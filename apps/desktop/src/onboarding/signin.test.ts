import { describe, expect, it, vi } from "vitest";
import { signIn, type SignInDeps } from "./signin";

function fakeDeps() {
  const handlers = new Map<string, (p: unknown) => void>();
  const unlistened: string[] = [];
  const deps: SignInDeps = {
    begin: vi.fn(async () => ({
      signinUrl:
        "https://sayvox-staging-web-264655228768.us-west1.run.app/signin?port=5000&state=abc",
      state: "abc",
    })),
    open: vi.fn(async () => {}),
    on: async (event, cb) => {
      handlers.set(event, cb as (p: unknown) => void);
      return () => unlistened.push(event);
    },
  };
  return { deps, emit: (e: string, p: unknown) => handlers.get(e)?.(p), unlistened };
}

describe("signIn", () => {
  it("opens the hosted page and resolves when Rust reports success", async () => {
    const { deps, emit, unlistened } = fakeDeps();
    const p = signIn(deps);
    await vi.waitFor(() => expect(deps.open).toHaveBeenCalled());
    expect(deps.open).toHaveBeenCalledWith(
      "https://sayvox-staging-web-264655228768.us-west1.run.app/signin?port=5000&state=abc",
    );
    emit("auth://signed-in", { email: "a@example.com" });
    await expect(p).resolves.toEqual({ status: "signed-in", email: "a@example.com" });
    expect(unlistened.sort()).toEqual(["auth://signed-in", "auth://timed-out"]);
  });

  it("reports a timeout", async () => {
    const { deps, emit } = fakeDeps();
    const p = signIn(deps);
    await vi.waitFor(() => expect(deps.open).toHaveBeenCalled());
    emit("auth://timed-out", null);
    await expect(p).resolves.toEqual({ status: "timed-out" });
  });
});
