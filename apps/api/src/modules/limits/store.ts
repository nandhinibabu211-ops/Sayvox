import { and, eq, gte, lt, sql } from "drizzle-orm";
import type { Redis } from "ioredis";
import type { Db } from "../../lib/db/client";
import { usageDaily } from "../../lib/db/schema";
import { keys, TTL_SECONDS } from "../../lib/redis/keys";
import type { UsedSeconds } from "./policy";

/**
 * Token bucket in one atomic Lua call: `capacity` requests, refilled evenly over 60 s.
 * Returns {allowed, retryAfterMs}.
 */
const TOKEN_BUCKET = `
local key = KEYS[1]
local cap = tonumber(ARGV[1])
local per_ms = tonumber(ARGV[2])
local now = tonumber(ARGV[3])
local d = redis.call('HMGET', key, 't', 'ts')
local tokens = tonumber(d[1]) or cap
local ts = tonumber(d[2]) or now
tokens = math.min(cap, tokens + (now - ts) * per_ms)
local allowed = 0
if tokens >= 1 then
  tokens = tokens - 1
  allowed = 1
end
redis.call('HSET', key, 't', tostring(tokens), 'ts', tostring(now))
redis.call('PEXPIRE', key, ${TTL_SECONDS.rateLimit * 1000})
local wait = 0
if allowed == 0 then wait = math.ceil((1 - tokens) / per_ms) end
return {allowed, wait}
`;

export interface RateLimitResult {
  allowed: boolean;
  retryAfterMs: number;
}

export async function takeRateToken(
  redis: Redis,
  userId: string,
  capacityPerMinute: number,
  nowMs: number,
): Promise<RateLimitResult> {
  const [allowed, wait] = (await redis.eval(
    TOKEN_BUCKET,
    1,
    keys.rateLimit(userId),
    capacityPerMinute,
    capacityPerMinute / 60_000,
    nowMs,
  )) as [number, number];
  return { allowed: allowed === 1, retryAfterMs: wait };
}

/**
 * Count one rewrite for `sessionId`; false once `max` were already started. The desktop app
 * sends one rewrite per press and never retries, so 2 leaves room for a duplicate request
 * while stopping a modified client from looping LLM calls on one open session.
 */
export async function claimRewrite(redis: Redis, sessionId: string, max = 2): Promise<boolean> {
  const key = keys.rewriteClaims(sessionId);
  const [[, count]] = (await redis
    .multi()
    .incr(key)
    .expire(key, TTL_SECONDS.rewriteClaims)
    .exec()) as [[Error | null, number], [Error | null, number]];
  return count <= max;
}

const dayString = (d: Date) => d.toISOString().slice(0, 10);
const monthStart = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
const nextMonthStart = (d: Date) => new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));

/** Rebuild counters from Postgres (source of truth) when Redis lost them. */
async function usedFromDb(db: Db, userId: string, at: Date): Promise<UsedSeconds> {
  const [row] = await db
    .select({
      day: sql<string>`coalesce(sum(${usageDaily.audioSeconds}) filter (where ${usageDaily.day} = ${dayString(at)}), 0)`,
      month: sql<string>`coalesce(sum(${usageDaily.audioSeconds}), 0)`,
    })
    .from(usageDaily)
    .where(
      and(
        eq(usageDaily.userId, userId),
        gte(usageDaily.day, dayString(monthStart(at))),
        lt(usageDaily.day, dayString(nextMonthStart(at))),
      ),
    );
  return { day: Number(row?.day ?? 0), month: Number(row?.month ?? 0) };
}

/** Audio seconds used today and this month (UTC). Redis first, Postgres on a miss. */
export async function getUsedSeconds(
  redis: Redis,
  db: Db,
  userId: string,
  at: Date,
): Promise<UsedSeconds> {
  const dayKey = keys.quotaDay(userId, at);
  const monthKey = keys.quotaMonth(userId, at);
  const [day, month] = await redis.mget(dayKey, monthKey);
  if (day !== null && month !== null) return { day: Number(day), month: Number(month) };

  const used = await usedFromDb(db, userId, at);
  // NX: never overwrite a counter another instance already rebuilt and incremented.
  await redis
    .multi()
    .set(dayKey, String(used.day), "EX", TTL_SECONDS.quotaDay, "NX")
    .set(monthKey, String(used.month), "EX", TTL_SECONDS.quotaMonth, "NX")
    .exec();
  return used;
}

/** Add billed seconds after a session ends (only when its row actually transitioned). */
export async function addUsedSeconds(
  redis: Redis,
  userId: string,
  seconds: number,
  at: Date,
): Promise<void> {
  if (seconds <= 0) return;
  const dayKey = keys.quotaDay(userId, at);
  const monthKey = keys.quotaMonth(userId, at);
  // Only increment existing counters; a missing key is rebuilt from Postgres on next read.
  const exists = await redis.exists(dayKey, monthKey);
  if (exists === 0) return;
  await redis
    .multi()
    .incrbyfloat(dayKey, seconds)
    .expire(dayKey, TTL_SECONDS.quotaDay)
    .incrbyfloat(monthKey, seconds)
    .expire(monthKey, TTL_SECONDS.quotaMonth)
    .exec();
}
