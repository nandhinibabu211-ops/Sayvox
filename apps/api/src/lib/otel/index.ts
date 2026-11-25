import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-proto";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-proto";
import { metrics, trace } from "@opentelemetry/api";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  MeterProvider,
  PeriodicExportingMetricReader,
  type MetricReader,
} from "@opentelemetry/sdk-metrics";
import {
  BatchSpanProcessor,
  ParentBasedSampler,
  TraceIdRatioBasedSampler,
  TracerProvider,
} from "@opentelemetry/sdk-trace";
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from "@opentelemetry/semantic-conventions";

export interface TelemetryOptions {
  serviceVersion: string;
  region: string;
  /**
   * OTLP base URL. In Cloud Run this is a collector sidecar that forwards to Cloud Monitoring
   * and Cloud Trace (ADR-006); Google's direct exporters are deprecated in favour of OTLP.
   * Unset = no export (local dev and tests).
   */
  otlpEndpoint?: string | undefined;
  traceSampleRatio?: number;
  /** Injected in tests to read metrics without a network exporter. */
  metricReader?: MetricReader;
}

export interface Telemetry {
  shutdown: () => Promise<void>;
}

/**
 * Start metrics + traces. Spans and metric attributes must never carry user text
 * (Constitution I): only enums, ids, counts and timings.
 */
export function startTelemetry(opts: TelemetryOptions): Telemetry {
  const resource = resourceFromAttributes({
    [ATTR_SERVICE_NAME]: "sayvox-api",
    [ATTR_SERVICE_VERSION]: opts.serviceVersion,
    "cloud.region": opts.region,
  });

  const readers: MetricReader[] = [];
  if (opts.metricReader) readers.push(opts.metricReader);
  if (opts.otlpEndpoint) {
    readers.push(
      new PeriodicExportingMetricReader({
        exporter: new OTLPMetricExporter({ url: `${opts.otlpEndpoint}/v1/metrics` }),
        exportIntervalMillis: 60_000,
      }),
    );
  }
  const meterProvider = new MeterProvider({ resource, readers });
  metrics.setGlobalMeterProvider(meterProvider);

  const tracerProvider = new TracerProvider({
    resource,
    sampler: new ParentBasedSampler({
      root: new TraceIdRatioBasedSampler(opts.traceSampleRatio ?? 0.1),
    }),
    spanProcessors: opts.otlpEndpoint
      ? [
          new BatchSpanProcessor({
            exporter: new OTLPTraceExporter({ url: `${opts.otlpEndpoint}/v1/traces` }),
          }),
        ]
      : [],
  });
  trace.setGlobalTracerProvider(tracerProvider);

  return {
    shutdown: async () => {
      await Promise.allSettled([meterProvider.shutdown(), tracerProvider.shutdown()]);
      metrics.disable();
      trace.disable();
    },
  };
}
