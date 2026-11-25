import { describe, expect, it, vi } from "vitest";
import { CASES } from "../dataset/cases";
import { coin, JUDGE_MODEL, judgeAbsolute, judgePairwise } from "./judge";

/** Fake OpenRouter stream returning `content` as one token. */
function fakeStream(content: string) {
  return vi.fn(async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as { model: string };
    expect(body.model).toBe(JUDGE_MODEL);
    const sse = `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\ndata: [DONE]\n\n`;
    return new Response(new TextEncoder().encode(sse), { status: 200 });
  });
}

const c = CASES[0]!;

describe("judge (T057)", () => {
  it("the judge is never one of the preset models under test", () => {
    expect([
      "anthropic/claude-haiku-5.5",
      "openai/gpt-6-luna",
      "google/gemini-3.5-flash-lite",
    ]).not.toContain(JUDGE_MODEL);
  });

  it("parses and clamps absolute scores", async () => {
    const f = fakeStream('Here you go: {"faithfulness":5,"format":9,"tone":0}');
    expect(await judgeAbsolute(c, "out", "k", f as unknown as typeof fetch)).toEqual({
      faithfulness: 5,
      format: 5,
      tone: 1,
    });
  });

  it("maps A/B back to candidate/baseline whatever the shuffled order", async () => {
    const swap = coin(c.id) === 1;
    const winnerIsCandidate = swap ? "B" : "A";
    const f = fakeStream(`{"winner":"${winnerIsCandidate}"}`);
    expect(await judgePairwise(c, "cand", "base", "k", f as unknown as typeof fetch)).toBe(
      "candidate",
    );
    const g = fakeStream('{"winner":"tie"}');
    expect(await judgePairwise(c, "cand", "base", "k", g as unknown as typeof fetch)).toBe("tie");
  });

  it("A/B order is deterministic per case and varies across cases", () => {
    expect(coin("x")).toBe(coin("x"));
    const flips = new Set(CASES.map((k) => coin(k.id)));
    expect(flips.size).toBe(2);
  });
});
