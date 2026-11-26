import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createOpenRouterClient } from "../../src/lib/openrouter/stream";
import { createTanglishPass } from "../../src/modules/stream/tanglish";
import type { StreamTicketData } from "../../src/modules/stream/ticket";
import { startMockOpenRouter, type MockOpenRouter } from "../mocks/openrouter";

const FAST = "google/gemini-3.5-flash-lite";
const SLOW = "openai/gpt-6-luna";
let mock: MockOpenRouter;

const ticket = (languageHint: string | null): StreamTicketData => ({
  sessionId: "3f1c2a4e-8b7d-4c1a-9e2f-1a2b3c4d5e6f",
  userId: "u",
  scribeToken: "none",
  keyterms: [],
  languageHint,
  keytermsUsed: false,
  maxSessionSeconds: 300,
});

beforeAll(async () => {
  mock = await startMockOpenRouter();
});
afterAll(() => mock.close());
beforeEach(() => {
  mock.behaviours.clear();
  mock.requests.length = 0;
});

const pass = () =>
  createTanglishPass({
    models: async () => [FAST, SLOW],
    effortFor: () => "none",
    complete: createOpenRouterClient({ apiKey: "k", baseUrl: mock.baseUrl }),
  });

describe("Tanglish pass (Language: Tanglish)", () => {
  it("turns Tamil script into Latin-letter Tanglish through the fastest preset", async () => {
    mock.behaviours.set(FAST, { kind: "normal", tokens: ["naalaiku ", "meeting irukku"] });
    const out = await pass()("நாளைக்கு meeting இருக்கு", ticket("tanglish"));
    expect(out).toBe("naalaiku meeting irukku");
    expect(mock.requests[0]?.model).toBe(FAST);
    const user = (mock.requests[0]!.body["messages"] as { content: string }[])[1]!.content;
    expect(user).toBe("<transcript>நாளைக்கு meeting இருக்கு</transcript>");
  });

  it("leaves other languages and Latin-only text alone, with no model call", async () => {
    expect(await pass()("நாளைக்கு meeting", ticket("ta"))).toBe("நாளைக்கு meeting");
    expect(await pass()("naalaiku meeting irukku", ticket("tanglish"))).toBe(
      "naalaiku meeting irukku",
    );
    expect(await pass()("let's meet Friday", ticket(null))).toBe("let's meet Friday");
    expect(mock.requests).toHaveLength(0);
  });

  it("keeps the original text when every model fails", async () => {
    mock.behaviours.set(FAST, { kind: "status", status: 503 });
    mock.behaviours.set(SLOW, { kind: "status", status: 503 });
    expect(await pass()("நாளைக்கு meeting", ticket("tanglish"))).toBe("நாளைக்கு meeting");
  });
});
