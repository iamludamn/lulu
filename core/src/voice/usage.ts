import type { TelemetryContext } from "@earendil-works/pi-telemetry";
import type { DurableHost } from "../host/types.js";
import { serviceUsage } from "../telemetry/service.js";
import { INPUT_RATE } from "./doubao/events.js";

const bytesOf = (audio: unknown): number => typeof audio === "string" ? Math.max(0, Math.floor(audio.length * 3 / 4) - (audio.endsWith("==") ? 2 : audio.endsWith("=") ? 1 : 0)) : 0;

export function meteredVoiceConnect(connect: DurableHost["connect"], telemetry: TelemetryContext): DurableHost["connect"] {
  return async (url, headers, handlers) => {
    let since: number | undefined;
    let input = 0;
    let output = 0;
    const flush = (closing = false) => {
      if (since === undefined) return;
      const now = Date.now();
      if (!closing && now - since < 30_000) return;
      const attributes = {
        "lulu.service.provider": "doubao",
        "lulu.service.operation": "audio",
        "lulu.service.cost_status": "unavailable",
        "lulu.service.input_audio_seconds": input / (INPUT_RATE * 2),
        "lulu.service.download_bytes": output,
        "lulu.service.upload_bytes": input,
        "lulu.service.connection_seconds": Math.max(0, now - since) / 1000,
      };
      since = closing ? undefined : now;
      input = 0;
      output = 0;
      void telemetry.startSpan({ name: "service.usage", attributes }, () => undefined).catch(() => undefined);
    };
    const result = await serviceUsage(telemetry, "doubao", "connect", async (span) => {
      const result = await connect(url, headers, {
        message(data) {
          try {
            const event = JSON.parse(String(data)) as { type?: string; delta?: unknown };
            if (event.type === "response.output_audio.delta") output += bytesOf(event.delta);
          } catch {}
          flush();
          handlers.message(data);
        },
        close() {
          flush(true);
          handlers.close();
        },
      });
      if (!result.socket) {
        span.setAttributes({ "lulu.service.outcome": "error" });
        span.setStatus({ status: "error", error: { name: "Error", message: "voice connection refused" } });
      }
      return result;
    });
    const socket = result.socket;
    if (!socket) return result;
    since = Date.now();
    return { ...result, socket: {
      get readyState() { return socket.readyState; },
      send(data) {
        socket.send(data);
        try {
          const event = JSON.parse(String(data)) as { type?: string; audio?: unknown };
          if (event.type === "input_audio_buffer.append") input += bytesOf(event.audio);
        } catch {}
        flush();
      },
      close(code, reason) {
        flush(true);
        socket.close(code, reason);
      },
    } };
  };
}
