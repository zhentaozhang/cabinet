import { logEvent } from "@/lib/observability/log";
import { installOtlpExporterIfConfigured } from "@/lib/observability/otlp";

/**
 * Next calls this once per server instance, before the first request.
 *
 * Tracing is opt-in through `OTEL_EXPORTER_OTLP_ENDPOINT`: with no endpoint the
 * spans are still built (they cost a few microseconds) but nothing leaves the
 * process, so a local `next dev` needs no collector.
 */
export function register(): void {
  const enabled = installOtlpExporterIfConfigured();
  logEvent("info", "tracing.init", {
    enabled,
    endpoint: enabled ? process.env.OTEL_EXPORTER_OTLP_ENDPOINT : null,
  });
}
