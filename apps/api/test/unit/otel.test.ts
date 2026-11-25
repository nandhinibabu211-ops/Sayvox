import { AggregationTemporality, MetricReader } from "@opentelemetry/sdk-metrics";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app";
import { createLogger } from "../../src/lib/logger";
import { startTelemetry, type Telemetry } from "../../src/lib/otel";
import { resetInstruments } from "../../src/lib/otel/metrics";

class TestReader extends MetricReader {
  constructor() {
    super({ aggregationTemporalitySelector: () => AggregationTemporality.CUMULATIVE });
  }
  protected async onForceFlush(): Promise<void> {}
  protected async onShutdown(): Promise<void> {}
}

let telemetry: Telemetry;
const reader = new TestReader();

beforeAll(() => {
  resetInstruments();
  telemetry = startTelemetry({ serviceVersion: "test", region: "us-east4", metricReader: reader });
});

afterAll(async () => {
  await telemetry.shutdown();
  resetInstruments();
});

describe("http metrics", () => {
  it("records request duration by route template, not raw URL", async () => {
    const app = buildApp({ logger: createLogger({ level: "silent" }) });
    app.get("/v1/session/:id/end-test", { config: { public: true } }, async () => ({ ok: true }));
    await app.inject({ method: "GET", url: "/healthz" });
    await app.inject({ method: "GET", url: "/v1/session/3f1c2a4e-secret-id/end-test?x=1" });
    await app.close();

    const { resourceMetrics } = await reader.collect();
    const metric = resourceMetrics.scopeMetrics
      .flatMap((s) => s.metrics)
      .find((m) => m.descriptor.name === "http_server_duration_ms");
    expect(metric).toBeDefined();

    const routes = metric!.dataPoints.map((p) => p.attributes["http.route"]);
    expect(routes).toContain("/healthz");
    expect(routes).toContain("/v1/session/:id/end-test");
    expect(JSON.stringify(metric)).not.toContain("secret-id");
    expect(resourceMetrics.resource.attributes["service.name"]).toBe("sayvox-api");
  });
});
