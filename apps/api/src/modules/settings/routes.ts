import {
  AddDictionaryTermRequest,
  type DictionaryList,
  type DictionaryTerm,
  Settings,
  type SettingsResponse,
} from "@sayvox/shared";
import { and, asc, count, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import type { Redis } from "ioredis";
import { z } from "zod";
import type { Db } from "../../lib/db/client";
import { dictionaryTerms, plans, settings, users } from "../../lib/db/schema";
import { getJson, setJson } from "../../lib/redis/client";
import { keys, TTL_SECONDS } from "../../lib/redis/keys";
import { ApiError } from "../../plugins/errors";
import { requireUser } from "../auth/plugin";

export interface SettingsDeps {
  db: Db;
  redis: Redis;
}

const PRESET_NAMES = { fastest: "Fastest", balanced: "Balanced", cheapest: "Cheapest" } as const;
const IdParams = z.object({ id: z.uuid() });
const isUniqueViolation = (err: unknown) =>
  (err as { code?: string; cause?: { code?: string } }).code === "23505" ||
  (err as { cause?: { code?: string } }).cause?.code === "23505";

/** Story 2.6 + 2.7 (T065/T066). */
export function registerSettingsRoutes(app: FastifyInstance, deps: SettingsDeps): void {
  const { db, redis } = deps;

  async function planOf(planId: string) {
    const [p] = await db
      .select({
        id: plans.id,
        allowedPresets: plans.allowedPresets,
        dictionaryLimit: plans.dictionaryLimit,
      })
      .from(plans)
      .where(eq(plans.id, planId));
    if (!p) throw new ApiError("INTERNAL", "Unknown plan");
    return p;
  }

  type StoredSettings = Settings & { translateHotkey: (Settings["translateHotkey"] & {}) | null };

  /** A translate shortcut equal to the dictation one can't work: report it as off. */
  const translateFor = (hotkey: string, translate: string | null | undefined) =>
    (translate ?? null) === hotkey
      ? null
      : ((translate ?? null) as StoredSettings["translateHotkey"]);

  async function readSettings(userId: string): Promise<StoredSettings> {
    const cached = await getJson<StoredSettings>(redis, keys.settings(userId)).catch(() => null);
    const parsed = cached ? Settings.safeParse(cached) : undefined;
    if (parsed?.success && parsed.data.translateHotkey !== undefined) {
      return { ...parsed.data, translateHotkey: parsed.data.translateHotkey };
    }

    const [row] = await db.select().from(settings).where(eq(settings.userId, userId));
    if (!row) throw new ApiError("NOT_FOUND", "Settings not found");
    const parsedRow = Settings.parse({
      preset: row.preset,
      defaultMode: row.defaultMode,
      appModeOverrides: row.appModeOverrides,
      insertMode: row.insertMode,
      languageHint: row.languageHint,
      hotkey: row.hotkey,
      translateHotkey: translateFor(row.hotkey, row.translateHotkey),
    });
    const value: StoredSettings = {
      ...parsedRow,
      translateHotkey: translateFor(row.hotkey, row.translateHotkey),
    };
    await setJson(redis, keys.settings(userId), value, TTL_SECONDS.settings).catch(() => {});
    return value;
  }

  const respond = async (planId: string, s: StoredSettings): Promise<SettingsResponse> => ({
    ...s,
    plan: await planOf(planId),
  });

  app.get("/v1/settings", async (req) => {
    const user = requireUser(req);
    return respond(user.planId, await readSettings(user.id));
  });

  app.put("/v1/settings", async (req) => {
    const user = requireUser(req);
    const next = Settings.parse(req.body);
    const plan = await planOf(user.planId);
    if (!plan.allowedPresets.includes(next.preset)) {
      throw new ApiError(
        "FORBIDDEN",
        `The ${PRESET_NAMES[next.preset]} preset isn't included in your plan`,
      );
    }
    // Absent translateHotkey (older clients) keeps the stored one, unless it now clashes.
    const [current] = await db
      .select({ translateHotkey: settings.translateHotkey })
      .from(settings)
      .where(eq(settings.userId, user.id));
    const translateHotkey = translateFor(
      next.hotkey,
      next.translateHotkey === undefined ? current?.translateHotkey : next.translateHotkey,
    );
    await db
      .update(settings)
      .set({ ...next, translateHotkey, updatedAt: new Date() })
      .where(eq(settings.userId, user.id));
    // Bust the cache so /session/start and /rewrite see the change on the next press.
    await redis.del(keys.settings(user.id)).catch(() => {});
    return { ...next, translateHotkey, plan } satisfies SettingsResponse;
  });

  app.get("/v1/dictionary", async (req): Promise<DictionaryList> => {
    const user = requireUser(req);
    const [rows, plan] = await Promise.all([
      db
        .select()
        .from(dictionaryTerms)
        .where(eq(dictionaryTerms.userId, user.id))
        .orderBy(asc(dictionaryTerms.createdAt)),
      planOf(user.planId),
    ]);
    return {
      terms: rows.map((r) => ({ id: r.id, term: r.term, createdAt: r.createdAt.toISOString() })),
      limit: plan.dictionaryLimit,
    };
  });

  app.post("/v1/dictionary", async (req, reply) => {
    const user = requireUser(req);
    const { term } = AddDictionaryTermRequest.parse(req.body);
    const plan = await planOf(user.planId);

    const created = await db
      .transaction(async (tx) => {
        // Serialise adds per user so two at once can't both slip under the limit.
        await tx.select({ id: users.id }).from(users).where(eq(users.id, user.id)).for("update");
        const [{ n } = { n: 0 }] = await tx
          .select({ n: count() })
          .from(dictionaryTerms)
          .where(eq(dictionaryTerms.userId, user.id));
        if (n >= plan.dictionaryLimit) {
          throw new ApiError(
            "FORBIDDEN",
            `Dictionary limit reached (${plan.dictionaryLimit} terms on your plan)`,
          );
        }
        const [row] = await tx
          .insert(dictionaryTerms)
          .values({ userId: user.id, term })
          .returning();
        return row!;
      })
      .catch((err: unknown) => {
        if (isUniqueViolation(err))
          throw new ApiError("CONFLICT", `"${term}" is already in your dictionary`);
        throw err;
      });

    const body: DictionaryTerm = {
      id: created.id,
      term: created.term,
      createdAt: created.createdAt.toISOString(),
    };
    return reply.code(201).send(body);
  });

  app.delete("/v1/dictionary/:id", async (req, reply) => {
    const user = requireUser(req);
    const { id } = IdParams.parse(req.params);
    const deleted = await db
      .delete(dictionaryTerms)
      .where(and(eq(dictionaryTerms.id, id), eq(dictionaryTerms.userId, user.id)))
      .returning({ id: dictionaryTerms.id });
    if (deleted.length === 0) throw new ApiError("NOT_FOUND", "Term not found");
    return reply.code(204).send();
  });
}
