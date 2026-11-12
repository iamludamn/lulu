import type { TelemetryContext, TelemetrySpan } from "@earendil-works/pi-telemetry";

export function serviceUsage<T>(telemetry: TelemetryContext, provider: string, operation: string, run: (span: TelemetrySpan) => Promise<T>): Promise<T> {
  return telemetry.startSpan({ name: "service.request", attributes: { "lulu.service.provider": provider, "lulu.service.operation": operation, "lulu.service.requests": 1, "lulu.service.cost_status": "unavailable", "lulu.service.outcome": "success" } }, async (span) => {
    try {
      const result = await run(span);
      return result;
    } catch (error) {
      span.setAttributes({ "lulu.service.outcome": "error" });
      span.setStatus({ status: "error", error: { name: "Error", message: "external service request failed" } });
      throw error;
    }
  });
}

export function serviceFetch(telemetry: TelemetryContext, provider: string, operation: string, request: () => Promise<Response>, bytes?: number): Promise<Response> {
  return serviceUsage(telemetry, provider, operation, async (span) => {
    const response = await request();
    span.setAttributes({ "http.response.status_code": response.status });
    if (response.ok) span.setAttributes({ "lulu.service.upload_bytes": bytes });
    else {
      span.setAttributes({ "lulu.service.outcome": "error" });
      span.setStatus({ status: "error", error: { name: "Error", message: "external service HTTP failure" } });
    }
    return response;
  });
}
