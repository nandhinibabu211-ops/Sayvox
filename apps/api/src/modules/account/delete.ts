import { and, eq, inArray } from "drizzle-orm";
import type { Redis } from "ioredis";
import type { Db } from "../../lib/db/client";
import { subscriptions, users } from "../../lib/db/schema";
import { keys, TTL_SECONDS } from "../../lib/redis/keys";
import type { AuthUser } from "../auth/users";
import type { DeleteIdentity } from "./identity";

/**
 * Account deletion (Story 5.7, T075). Every step is idempotent, so a failed deletion is
 * simply retried by the client (the route stays reachable for a tombstoned account):
 *
 * 1. Tombstone the identity in Redis, so a still-valid ID token can't recreate the user
 *    (the user resolver upserts on first request) while or after we delete.
 * 2. Cancel live subscriptions (billing, Phase 9). Refuse rather than leave someone paying.
 * 3. Delete the Identity Platform account: the refresh token stops working.
 * 4. `DELETE FROM users`: settings, dictionary, sessions, usage and subscriptions cascade.
 * 5. Purge the user's Redis keys (rate limit, quotas, settings cache).
 */

export interface LiveSubscription {
  provider: string;
  providerSubId: string;
}

export interface AccountDeps {
  db: Db;
  redis: Redis;
  deleteIdentity: DeleteIdentity;
  /** Cancels at the billing provider. Until billing exists, live subscriptions block deletion. */
  cancelSubscriptions?: (subs: LiveSubscription[]) => Promise<void>;
}

export class SubscriptionCancelUnavailable extends Error {
  constructor() {
    super("live subscription but no billing client to cancel it");
    this.name = "SubscriptionCancelUnavailable";
  }
}

const LIVE = ["active", "past_due", "incomplete"] as const;

export async function purgeUserKeys(redis: Redis, userId: string): Promise<number> {
  let removed = 0;
  for (const pattern of keys.userPatterns(userId)) {
    if (!pattern.includes("*")) {
      removed += await redis.del(pattern);
      continue;
    }
    let cursor = "0";
    do {
      const [next, found] = await redis.scan(cursor, "MATCH", pattern, "COUNT", 500);
      cursor = next;
      if (found.length) removed += await redis.del(...found);
    } while (cursor !== "0");
  }
  return removed;
}

export async function deleteAccount(deps: AccountDeps, user: AuthUser): Promise<void> {
  const { db, redis } = deps;

  await redis.set(keys.accountDeleted(user.authProviderId), "1", "EX", TTL_SECONDS.accountDeleted);

  const live = await db
    .select({ provider: subscriptions.provider, providerSubId: subscriptions.providerSubId })
    .from(subscriptions)
    .where(and(eq(subscriptions.userId, user.id), inArray(subscriptions.status, [...LIVE])));
  if (live.length) {
    if (!deps.cancelSubscriptions) throw new SubscriptionCancelUnavailable();
    await deps.cancelSubscriptions(live);
  }

  await deps.deleteIdentity(user.authProviderId);
  await db.delete(users).where(eq(users.id, user.id));
  await purgeUserKeys(redis, user.id);
}
