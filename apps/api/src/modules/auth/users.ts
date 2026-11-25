import { sql } from "drizzle-orm";
import type { Db } from "../../lib/db/client";
import { settings, users } from "../../lib/db/schema";
import type { VerifiedIdentity } from "./verifier";

export interface AuthUser {
  id: string;
  authProviderId: string;
  email: string;
  planId: string;
  status: "active" | "suspended" | "deleted";
}

export type ResolveUser = (identity: VerifiedIdentity) => Promise<AuthUser>;

/**
 * Lazily create the user and default settings on first authenticated request (Story 2.2 AC 4).
 * Safe under concurrent first requests: both statements are ON CONFLICT upserts in one
 * transaction, so parallel calls converge on the same row.
 */
export function createUserResolver(
  db: Db,
  opts: { cacheMs?: number; maxEntries?: number } = {},
): ResolveUser {
  const cacheMs = opts.cacheMs ?? 60_000;
  const maxEntries = opts.maxEntries ?? 10_000;
  const cache = new Map<string, { user: AuthUser; at: number }>();

  return async (identity) => {
    const hit = cache.get(identity.sub);
    if (hit && Date.now() - hit.at < cacheMs && hit.user.email === identity.email) return hit.user;

    const user = await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(users)
        .values({ email: identity.email, authProviderId: identity.sub })
        .onConflictDoUpdate({
          target: users.authProviderId,
          // Keep email in sync if the user changed it at the identity provider.
          set: { email: sql`excluded.email` },
        })
        .returning({
          id: users.id,
          authProviderId: users.authProviderId,
          email: users.email,
          planId: users.planId,
          status: users.status,
        });
      if (!row) throw new Error("user upsert returned no row");
      await tx.insert(settings).values({ userId: row.id }).onConflictDoNothing();
      return row;
    });

    if (cache.size >= maxEntries) cache.delete(cache.keys().next().value as string);
    cache.set(identity.sub, { user, at: Date.now() });
    return user;
  };
}
