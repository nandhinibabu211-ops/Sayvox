import { describe, expect, it } from "vitest";
import { cleanup } from "./cleanup";

describe("dictation cleanup (T025)", () => {
  it("handles the spec example: fillers + self-correction + casing + period", () => {
    expect(cleanup("um so let's meet on Thursday no wait Friday")).toBe("So let's meet on Friday.");
  });

  it.each([
    ["Um, I think we should ship.", "I think we should ship."],
    ["so, uh, the build is green", "So, the build is green."],
    ["We need, umm, three more tests.", "We need three more tests."],
    ["Hmm. Let me check.", "Let me check."],
    ["You know, the API is slow.", "The API is slow."],
    ["The API is, you know, slow.", "The API is slow."],
    ["It's, like, really fast.", "It's really fast."],
  ])("removes fillers: %s", (input, expected) => {
    expect(cleanup(input)).toBe(expected);
  });

  it.each([
    ["Book it for 3 pm sorry I mean 4 pm", "Book it for 4 pm."],
    ["Send it to Priya, no wait, to Arun.", "Send it to Arun."],
    ["Call me on Monday no wait Tuesday please", "Call me on Tuesday please."],
    ["The total is 40 actually no 45 rupees", "The total is 45 rupees."],
  ])("applies self-corrections: %s", (input, expected) => {
    expect(cleanup(input)).toBe(expected);
  });

  it("leaves a correction alone when the replacement is too long to place safely", () => {
    const s = "Let's do Friday no wait I think we should move everything to next month instead";
    expect(cleanup(s)).toBe(`${s}.`);
  });

  it.each([
    ["Send the file na", "Send the file na."],
    ["I need two only", "I need two only."],
    ["I like this design", "I like this design."],
    ["You know the answer", "You know the answer."],
    ["I mean it", "I mean it."],
    ["Actually, it works", "Actually, it works."],
  ])("keeps meaningful words (Indian English and real verbs): %s", (input, expected) => {
    expect(cleanup(input)).toBe(expected);
  });

  it("capitalises sentences and standalone i", () => {
    expect(cleanup("i think so. then i left")).toBe("I think so. Then I left.");
  });

  it("keeps existing end punctuation", () => {
    expect(cleanup("Is it ready?")).toBe("Is it ready?");
    expect(cleanup("Ship it!")).toBe("Ship it!");
  });

  it("tidies spacing around punctuation", () => {
    expect(cleanup("hello ,  world  .")).toBe("Hello, world.");
  });

  it("restores dictionary casing for custom terms", () => {
    expect(cleanup("ask zia about the ZOHO invoice", ["Zoho", "Zia", "OpenRouter"])).toBe(
      "Ask Zia about the Zoho invoice.",
    );
    expect(cleanup("openrouter is up", ["OpenRouter"])).toBe("OpenRouter is up.");
  });

  it("returns an empty string for filler-only speech", () => {
    expect(cleanup("um uh")).toBe("");
    expect(cleanup("   ")).toBe("");
  });
});
