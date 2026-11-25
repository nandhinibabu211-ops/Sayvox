import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { llmCostUsd, validateSlugs } from "../../src/modules/config/validateSlugs";
import { startMockOpenRouter, type MockOpenRouter } from "../mocks/openrouter";

let mock: MockOpenRouter;
beforeAll(async () => {
  mock = await startMockOpenRouter();
});
afterAll(async () => {
  await mock.close();
});

describe("validateSlugs (T049)", () => {
  it("reports preset slugs OpenRouter doesn't list and loads prices", async () => {
    const r = await validateSlugs(
      ["anthropic/claude-haiku-5.5", "openai/gpt-6-luna", "openai/gpt-7-typo"],
      fetch,
      mock.baseUrl,
    );
    expect(r.missing).toEqual(["openai/gpt-7-typo"]);
    expect(r.prices.get("anthropic/claude-haiku-5.5")).toEqual({
      prompt: 0.0000001,
      completion: 0.0000005,
    });
  });

  it("computes LLM cost from token counts", () => {
    expect(llmCostUsd({ prompt: 0.0000001, completion: 0.0000005 }, 800, 200)).toBe(0.00018);
    expect(llmCostUsd(undefined, 800, 200)).toBe(0);
  });
});
