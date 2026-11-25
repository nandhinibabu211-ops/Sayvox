import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { buildApp } from "../../src/app";
import { createLogger } from "../../src/lib/logger";

const SECRET_PHRASE = "meet priya friday about the zoho invoice";

function captureStream(): { stream: Writable; output: () => string } {
  let buf = "";
  const stream = new Writable({
    write(chunk, _enc, cb) {
      buf += chunk.toString();
      cb();
    },
  });
  return { stream, output: () => buf };
}

describe("logger redaction (Constitution I)", () => {
  it("never writes transcript, rewrite or thread text", () => {
    const { stream, output } = captureStream();
    const log = createLogger({ level: "info" }, stream);

    log.info({ transcript: SECRET_PHRASE }, "top-level");
    log.info({ payload: { transcript: SECRET_PHRASE, threadContext: SECRET_PHRASE } }, "nested");
    log.info({ req: { body: { transcript: SECRET_PHRASE } } }, "request body");
    log.info({ event: { data: { text: SECRET_PHRASE } } }, "sse token");
    log.info({ partial: SECRET_PHRASE, rewrite: SECRET_PHRASE }, "partials");

    const out = output();
    expect(out).not.toContain("priya");
    expect(out).toContain("[REDACTED]");
  });

  it("redacts auth headers", () => {
    const { stream, output } = captureStream();
    const log = createLogger({ level: "info" }, stream);
    log.info({ req: { headers: { authorization: "Bearer abc.def.ghi" } } }, "headers");
    expect(output()).not.toContain("abc.def.ghi");
  });

  it("request logs from the app never include bodies", async () => {
    const { stream, output } = captureStream();
    const app = buildApp({ logger: createLogger({ level: "info" }, stream) });
    app.post("/echo-test", async () => ({ ok: true }));
    await app.inject({ method: "POST", url: "/echo-test", payload: { transcript: SECRET_PHRASE } });
    await app.close();
    expect(output()).not.toContain("priya");
  });
});
