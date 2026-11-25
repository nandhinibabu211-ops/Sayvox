import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { settings, users } from "../../src/lib/db/schema";
import { createUserResolver } from "../../src/modules/auth/users";
import { startPostgres, type PgFixture } from "./helpers";

let pg: PgFixture;

beforeAll(async () => {
  pg = await startPostgres();
});

afterAll(async () => {
  await pg?.stop();
});

describe("lazy user creation (Story 2.2 AC 4)", () => {
  it("creates the user and default settings on first sight", async () => {
    const resolve = createUserResolver(pg.handle.db, { cacheMs: 0 });
    const u = await resolve({ sub: "sub-1", email: "one@example.com", emailVerified: true });
    expect(u).toMatchObject({ planId: "free", status: "active", email: "one@example.com" });

    const [s] = await pg.handle.db.select().from(settings).where(eq(settings.userId, u.id));
    expect(s).toMatchObject({ preset: "balanced", defaultMode: "dictation", insertMode: "auto" });
  });

  it("is idempotent under 20 concurrent first requests", async () => {
    const resolve = createUserResolver(pg.handle.db, { cacheMs: 0 });
    const ids = await Promise.all(
      Array.from({ length: 20 }, () =>
        resolve({ sub: "sub-race", email: "race@example.com", emailVerified: true }).then(
          (u) => u.id,
        ),
      ),
    );
    expect(new Set(ids).size).toBe(1);
    const rows = await pg.handle.db
      .select()
      .from(users)
      .where(eq(users.authProviderId, "sub-race"));
    expect(rows).toHaveLength(1);
  });

  it("keeps the email in sync with the identity provider", async () => {
    const resolve = createUserResolver(pg.handle.db, { cacheMs: 0 });
    await resolve({ sub: "sub-2", email: "old@example.com", emailVerified: true });
    const u = await resolve({ sub: "sub-2", email: "new@example.com", emailVerified: true });
    expect(u.email).toBe("new@example.com");
  });
});
