import { describe, expect, it } from "vitest";
import { buildManifest } from "./release-manifest";

const URL_OK =
  "https://storage.googleapis.com/sayvox-app-2026-releases/releases/v0.2.0/Sayvox_0.2.0_x64-setup.exe";

describe("updater manifest (T082/T083)", () => {
  it("builds the Tauri v2 latest.json shape", () => {
    expect(
      buildManifest({
        version: "0.2.0",
        signature: "dW50cnVzdGVkIGNvbW1lbnQ=\n",
        url: URL_OK,
        now: new Date("2026-11-25T10:00:00.123Z"),
      }),
    ).toEqual({
      version: "0.2.0",
      notes: "Sayvox 0.2.0",
      pub_date: "2026-11-25T10:00:00Z",
      platforms: { "windows-x86_64": { signature: "dW50cnVzdGVkIGNvbW1lbnQ=", url: URL_OK } },
    });
  });

  it("refuses bad versions, empty signatures, http and mismatched URLs", () => {
    const base = { version: "0.2.0", signature: "sig", url: URL_OK };
    expect(() => buildManifest({ ...base, version: "v0.2" })).toThrow("not a version");
    expect(() => buildManifest({ ...base, signature: " \n" })).toThrow("empty signature");
    expect(() => buildManifest({ ...base, url: URL_OK.replace("https", "http") })).toThrow("https");
    expect(() => buildManifest({ ...base, version: "0.3.0" })).toThrow("doesn't name");
  });
});
