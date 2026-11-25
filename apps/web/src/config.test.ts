import { describe, expect, it } from "vitest";
import { webConfig } from "./config";

describe("webConfig", () => {
  it("prefers the runtime /config.js values (one image for every environment)", () => {
    expect(
      webConfig(
        { apiKey: "runtime", authDomain: "d.example", googleSignIn: "true" },
        { VITE_FIREBASE_API_KEY: "build" },
      ),
    ).toEqual({ apiKey: "runtime", authDomain: "d.example", googleSignIn: true });
  });

  it("falls back to build-time env for local dev, with Google sign-in off by default", () => {
    expect(webConfig(undefined, { VITE_FIREBASE_API_KEY: "dev" })).toEqual({
      apiKey: "dev",
      authDomain: "sayvox-app-2026.firebaseapp.com",
      googleSignIn: false,
    });
  });

  it("treats empty runtime values (unset env in nginx) as missing", () => {
    expect(
      webConfig({ apiKey: "", googleSignIn: "" }, { VITE_FIREBASE_API_KEY: "dev" }).apiKey,
    ).toBe("dev");
  });
});
