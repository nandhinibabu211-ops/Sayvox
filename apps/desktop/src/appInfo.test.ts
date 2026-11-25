import { describe, expect, it } from "vitest";
import { shellStatus } from "./appInfo";

describe("shellStatus", () => {
  it("names the version and platform", () => {
    expect(shellStatus("0.1.0")).toBe("Sayvox 0.1.0 · Windows · setup build");
  });
});
