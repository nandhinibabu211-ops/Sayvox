import { describe, expect, it } from "vitest";
import { micGuide, micProblemFromError } from "./micGuide";

describe("micGuide", () => {
  it("gives concrete steps for every problem", () => {
    for (const p of ["browser-denied", "embedded", "windows-off", "no-device"] as const) {
      const g = micGuide(p);
      expect(g.title.length).toBeGreaterThan(5);
      expect(g.steps.length).toBeGreaterThanOrEqual(3);
    }
    expect(micGuide("windows-off").steps.join(" ")).toContain(
      "Let desktop apps access your microphone",
    );
    expect(micGuide("browser-denied").steps.join(" ")).toContain("Allow");
  });

  it("maps getUserMedia errors to the right guide", () => {
    expect(micProblemFromError(new DOMException("x", "NotAllowedError"), false)).toBe(
      "browser-denied",
    );
    expect(micProblemFromError(new DOMException("x", "NotAllowedError"), true)).toBe("embedded");
    expect(micProblemFromError(new DOMException("x", "NotFoundError"), false)).toBe("no-device");
  });
});
