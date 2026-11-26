import { describe, expect, it } from "vitest";
import { apiErrorMessage, ApiFailure } from "./appMessages";

describe("apiErrorMessage", () => {
  it("explains the states a tester will actually meet", () => {
    expect(apiErrorMessage(new ApiFailure(503, "PROVIDER_UNAVAILABLE"))).toMatch(/isn't connected/);
    expect(apiErrorMessage(new ApiFailure(429, "QUOTA_EXCEEDED", "Daily limit reached"))).toBe(
      "Daily limit reached. It resets automatically.",
    );
    expect(apiErrorMessage(new ApiFailure(401, "UNAUTHENTICATED"))).toMatch(/sign in again/);
    expect(apiErrorMessage(new ApiFailure(503, "KILL_SWITCH", "Back in 15 minutes"))).toBe(
      "Back in 15 minutes",
    );
  });

  it("separates network failures from server errors", () => {
    expect(apiErrorMessage(new TypeError("Failed to fetch"))).toMatch(/Can't reach/);
    expect(apiErrorMessage(new ApiFailure(500, "INTERNAL"))).toMatch(/server had a problem/);
    expect(apiErrorMessage(new Error("x"))).toMatch(/Something went wrong/);
  });
});
