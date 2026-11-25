/**
 * Redis key layout (data-model.md "Redis keys"). All time buckets are UTC.
 * Keep key construction here so TTLs and formats can't drift between modules.
 */

const pad = (n: number) => String(n).padStart(2, "0");

export const utcDay = (d: Date): string =>
  `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`;

export const utcMonth = (d: Date): string => `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}`;

export const TTL_SECONDS = {
  rateLimit: 60,
  quotaDay: 48 * 3600,
  quotaMonth: 40 * 86_400,
  settings: 5 * 60,
  /** Outlives the longest a session can stay `started` (token TTL + max session, ~20 min). */
  rewriteClaims: 30 * 60,
  /** Outlives any ID token issued before the deletion (1 h) with margin. */
  accountDeleted: 2 * 3600,
} as const;

export const keys = {
  rateLimit: (userId: string) => `rl:${userId}`,
  quotaDay: (userId: string, at: Date) => `quota:day:${userId}:${utcDay(at)}`,
  quotaMonth: (userId: string, at: Date) => `quota:month:${userId}:${utcMonth(at)}`,
  settings: (userId: string) => `settings:${userId}`,
  /** Tombstone keyed by Identity Platform uid (Story 5.7): refuse its tokens after deletion. */
  accountDeleted: (authProviderId: string) => `deleted:${authProviderId}`,
  /** One-time /v1/stream ticket -> session + Scribe token (TTL = Scribe token TTL). */
  streamTicket: (ticket: string) => `stream:${ticket}`,
  /** Rewrites started for one session (capped, so a client can't loop paid LLM calls). */
  rewriteClaims: (sessionId: string) => `rw:${sessionId}`,
  clientConfig: () => "cfg:client",
  presets: () => "cfg:presets",
  /** Every key that belongs to one user, for account deletion (Story 5.7). */
  userPatterns: (userId: string) => [`rl:${userId}`, `quota:*:${userId}:*`, `settings:${userId}`],
} as const;
