import { SessionEndRequest, SessionStartRequest, type SessionStartResponse } from "@sayvox/shared";
import { and, desc, eq, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { Redis } from "ioredis";
import { z } from "zod";
import type { Db } from "../../lib/db/client";
import { dictionaryTerms, plans, sessions, settings, usageDaily } from "../../lib/db/schema";
import { type MintScribeToken, ProviderError } from "../../lib/elevenlabs/token";
import {
  releaseToInsertDuration,
  sessionStartDuration,
  sessionEndCounter,
  sttCommitDuration,
} from "../../lib/otel/metrics";
import { ApiError } from "../../plugins/errors";
import { requireUser } from "../auth/plugin";
import type { ConfigService } from "../config/service";
import {
  capKeyterms,
  clampAudioSeconds,
  decideQuota,
  type PlanLimits,
  sttCostUsd,
} from "../limits/policy";
import { addUsedSeconds, getUsedSeconds, takeRateToken } from "../limits/store";

export interface SessionDeps {
  db: Db;
  redis: Redis;
  config: ConfigService;
  mintToken: MintScribeToken;
  region: string;
  rateLimitPerMinute?: number;
  now?: () => Date;
}

const STATUS_FOR: Record<
  SessionEndRequest["insertResult"],
  "completed" | "raw_fallback" | "failed"
> = {
  inserted: "completed",
  raw_fallback: "raw_fallback",
  discarded: "failed",
  failed: "failed",
};

const IdParams = z.object({ id: z.uuid() });

export function registerSessionRoutes(app: FastifyInstance, deps: SessionDeps): void {
  const now = deps.now ?? (() => new Date());
  const planCache = new Map<string, { limits: PlanLimits; at: number }>();

  async function planLimits(planId: string): Promise<PlanLimits> {
    const hit = planCache.get(planId);
    if (hit && Date.now() - hit.at < 60_000) return hit.limits;
    const [row] = await deps.db
      .select({
        dailyCapMinutes: plans.dailyCapMinutes,
        monthlyAudioMinutes: plans.monthlyAudioMinutes,
      })
      .from(plans)
      .where(eq(plans.id, planId));
    if (!row) throw new ApiError("INTERNAL", "Unknown plan");
    planCache.set(planId, { limits: row, at: Date.now() });
    return row;
  }

  // Story 2.4: quota check → session row + single-use Scribe token. Hot path (< 150 ms).
  app.post("/v1/session/start", async (req, reply) => {
    const started = performance.now();
    const user = requireUser(req);
    SessionStartRequest.parse(req.body ?? {});
    const at = now();

    const clientVersion = req.headers["x-client-version"];
    const cfg = await deps.config.clientConfig();
    if (cfg.killSwitch) throw new ApiError("KILL_SWITCH", cfg.killSwitchMessage ?? "Paused");
    if (typeof clientVersion === "string" && (await deps.config.isOutdated(clientVersion))) {
      throw new ApiError("CLIENT_OUTDATED", `Update to ${cfg.minClientVersion} or later`);
    }

    const rate = await takeRateToken(
      deps.redis,
      user.id,
      deps.rateLimitPerMinute ?? 30,
      at.getTime(),
    );
    if (!rate.allowed) {
      reply.header("retry-after", Math.ceil(rate.retryAfterMs / 1000));
      throw new ApiError("RATE_LIMITED", "Too many dictations; try again shortly", {
        resetAt: new Date(at.getTime() + rate.retryAfterMs),
      });
    }

    const [limits, used, prefs, terms] = await Promise.all([
      planLimits(user.planId),
      getUsedSeconds(deps.redis, deps.db, user.id, at),
      deps.db
        .select({ languageHint: settings.languageHint })
        .from(settings)
        .where(eq(settings.userId, user.id)),
      deps.db
        .select({ term: dictionaryTerms.term })
        .from(dictionaryTerms)
        .where(eq(dictionaryTerms.userId, user.id))
        .orderBy(desc(dictionaryTerms.createdAt))
        .limit(200),
    ]);

    const quota = decideQuota(limits, used, at);
    if (!quota.ok) {
      throw new ApiError(
        "QUOTA_EXCEEDED",
        quota.scope === "day" ? "Daily limit reached" : "Monthly limit reached",
        { resetAt: quota.resetAt },
      );
    }
    const keyterms = capKeyterms(terms.map((t) => t.term));

    let token;
    let session;
    try {
      [token, [session]] = await Promise.all([
        deps.mintToken({ maxSessionSeconds: quota.maxSessionSeconds }),
        deps.db
          .insert(sessions)
          .values({
            userId: user.id,
            startedAt: at,
            keytermsUsed: keyterms.length > 0,
            maxSessionSeconds: quota.maxSessionSeconds,
            region: deps.region,
            clientVersion: typeof clientVersion === "string" ? clientVersion.slice(0, 32) : null,
          })
          .returning({ id: sessions.id }),
      ]);
    } catch (err) {
      if (err instanceof ProviderError) {
        req.log.warn({ provider: err.provider, providerStatus: err.status }, "token mint failed");
        throw new ApiError("PROVIDER_UNAVAILABLE", "Speech service unavailable");
      }
      throw err;
    }
    if (!session) throw new ApiError("INTERNAL", "Session not created");

    const body: SessionStartResponse = {
      sessionId: session.id,
      scribeToken: token.token,
      expiresAt: token.expiresAt.toISOString(),
      keyterms,
      languageHint: prefs[0]?.languageHint ?? null,
      maxSessionSeconds: quota.maxSessionSeconds,
    };
    sessionStartDuration().record(performance.now() - started);
    return body;
  });

  // Story 2.5: close the session with client timings; idempotent.
  app.post("/v1/session/:id/end", async (req, reply) => {
    const user = requireUser(req);
    const { id } = IdParams.parse(req.params);
    const body = SessionEndRequest.parse(req.body);
    const at = now();

    const result = await deps.db.transaction(async (tx) => {
      const [row] = await tx
        .select({
          userId: sessions.userId,
          startedAt: sessions.startedAt,
          status: sessions.status,
          keytermsUsed: sessions.keytermsUsed,
          maxSessionSeconds: sessions.maxSessionSeconds,
        })
        .from(sessions)
        .where(eq(sessions.id, id))
        .for("update");
      if (!row || row.userId !== user.id) throw new ApiError("NOT_FOUND", "Session not found");
      if (row.status !== "started") return { transitioned: false, seconds: 0 };

      const seconds = clampAudioSeconds(
        body.audioSeconds,
        row.startedAt,
        at,
        row.maxSessionSeconds,
      );
      await tx
        .update(sessions)
        .set({
          status: STATUS_FOR[body.insertResult],
          endedAt: at,
          audioSeconds: seconds.toFixed(2),
          mode: body.mode ?? null,
          targetApp: body.targetApp ?? null,
          sttCommitMs: body.timings.sttCommitMs,
          releaseToInsertMs: body.timings.releaseToInsertMs,
          ...(body.clientVersion ? { clientVersion: body.clientVersion } : {}),
        })
        .where(and(eq(sessions.id, id), eq(sessions.status, "started")));

      // Audio was streamed (and billed by ElevenLabs) even if the result was discarded.
      const cost = sttCostUsd(seconds, row.keytermsUsed);
      await tx
        .insert(usageDaily)
        .values({
          userId: user.id,
          day: at.toISOString().slice(0, 10),
          audioSeconds: seconds.toFixed(2),
          requests: 1,
          sttCostUsd: cost.toFixed(5),
        })
        .onConflictDoUpdate({
          target: [usageDaily.userId, usageDaily.day],
          set: {
            audioSeconds: sql`${usageDaily.audioSeconds} + excluded.audio_seconds`,
            requests: sql`${usageDaily.requests} + 1`,
            sttCostUsd: sql`${usageDaily.sttCostUsd} + excluded.stt_cost_usd`,
          },
        });
      return { transitioned: true, seconds };
    });

    if (result.transitioned) {
      await addUsedSeconds(deps.redis, user.id, result.seconds, at);
      const attrs = { mode: body.mode ?? "dictation", result: body.insertResult };
      releaseToInsertDuration().record(body.timings.releaseToInsertMs, attrs);
      sttCommitDuration().record(body.timings.sttCommitMs, attrs);
      sessionEndCounter().add(1, { ...attrs, scribe_retried: body.scribeRetried === true });
    }
    return reply.code(204).send();
  });
}
