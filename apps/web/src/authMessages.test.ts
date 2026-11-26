import { describe, expect, it } from "vitest";
import { authErrorMessage, RESET_SENT } from "./authMessages";

describe("authErrorMessage", () => {
  it("maps Identity Platform codes to plain messages", () => {
    expect(authErrorMessage("auth/invalid-credential")).toBe("Email or password is incorrect.");
    expect(authErrorMessage("auth/weak-password")).toMatch(/at least 8/);
    expect(authErrorMessage("auth/password-does-not-meet-requirements")).toMatch(/at least 8/);
    expect(authErrorMessage("auth/invalid-email")).toMatch(/email address/);
    expect(authErrorMessage("auth/too-many-requests")).toMatch(/Too many attempts/);
    expect(authErrorMessage("auth/email-already-in-use")).toMatch(/Sign in instead/);
  });

  it("doesn't reveal whether an account exists on sign-in failures", () => {
    expect(authErrorMessage("auth/user-not-found")).toBe(authErrorMessage("auth/wrong-password"));
  });

  it("falls back to a generic line for unknown codes", () => {
    expect(authErrorMessage("auth/something-new")).toBe("Sign-in failed. Please try again.");
    expect(authErrorMessage(undefined)).toBe("Sign-in failed. Please try again.");
  });

  it("gives the same reset answer for every email", () => {
    expect(RESET_SENT).toMatch(/If an account exists/);
  });
});
