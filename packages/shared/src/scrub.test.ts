import { describe, expect, it } from "vitest";
import { scrubStack } from "./scrub";

describe("scrubStack (T076)", () => {
  it("drops the error message and keeps the frames", () => {
    const stack = [
      "TypeError: Cannot read 'tell priya the invoice is late'",
      "    at render (http://localhost:1420/src/overlay/main.ts:42:9)",
      "    at DictationPipeline.release (pipeline.ts:180:5)",
    ].join("\n");
    expect(scrubStack(stack)).toBe(
      [
        "TypeError",
        "at render (http://localhost:1420/src/overlay/main.ts:42:9)",
        "at DictationPipeline.release (pipeline.ts:180:5)",
      ].join("\n"),
    );
  });

  it("drops multi-line messages and non-frame noise", () => {
    const stack = "Error: line one\nsecret second line\n    at f (a.js:1:1)";
    expect(scrubStack(stack)).toBe("Error\nat f (a.js:1:1)");
  });

  it("scrubs literals, emails, user names and URL queries inside frames", () => {
    const stack = [
      "Error",
      `    at eval (eval at run ("hello priya"), <anonymous>:1:1)`,
      "    at C:\\Users\\Nandhini\\AppData\\Local\\Sayvox\\app.js:3:4",
      "    at /home/priya/sayvox/app.js:3:4",
      "    at load (https://api.example.com/v1/x?token=abc#frag:2:2)",
      "    at mail (https://cdn.example.com/u/priya@example.com/a.js:1:1)",
    ].join("\n");
    const out = scrubStack(stack);
    expect(out).not.toMatch(/priya|Nandhini|token=abc|hello/i);
    expect(out).toContain("C:\\Users\\<user>\\AppData");
    expect(out).toContain("/home/<user>/sayvox");
  });

  it("keeps Firefox-style frames and caps length", () => {
    expect(scrubStack("f@main.js:1:2\ng@main.js:3:4")).toBe("f@main.js:1:2\ng@main.js:3:4");
    const long =
      "Error\n" + Array.from({ length: 500 }, (_, i) => `    at f${i} (x.js:${i}:1)`).join("\n");
    expect(scrubStack(long).split("\n").length).toBeLessThanOrEqual(51);
  });

  it("handles empty input", () => {
    expect(scrubStack(undefined)).toBe("");
    expect(scrubStack("")).toBe("");
  });
});
