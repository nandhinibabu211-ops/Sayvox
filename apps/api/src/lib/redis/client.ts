import { Redis } from "ioredis";

/**
 * Shared Redis connection. Commands fail fast (no offline queue) so a Redis outage surfaces
 * as a clear error on the hot path instead of piling up requests.
 */
export function createRedis(url: string): Redis {
  return new Redis(url, {
    lazyConnect: true,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    connectTimeout: 2_000,
    commandTimeout: 500,
  });
}

/** Read a JSON value; returns null on a miss or unparsable value. */
export async function getJson<T>(redis: Redis, key: string): Promise<T | null> {
  const raw = await redis.get(key);
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export async function setJson(
  redis: Redis,
  key: string,
  value: unknown,
  ttlSeconds?: number,
): Promise<void> {
  const raw = JSON.stringify(value);
  if (ttlSeconds) await redis.set(key, raw, "EX", ttlSeconds);
  else await redis.set(key, raw);
}
