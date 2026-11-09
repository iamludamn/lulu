import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { AssistantMessage, ToolResultMessage } from "@earendil-works/pi-ai";
import { watchEvents, type AgentEvent, type ConversationId, type Harness } from "@earendil-works/pi-durable";
import type { SpanAttributes, TelemetryContext, TelemetrySpan } from "@earendil-works/pi-telemetry";
import { isSensitive } from "../memory/guard.js";

const FAILURE_CHARACTERS = 300;

type Held = { readonly span: TelemetrySpan; end(): void };

function hold(parent: TelemetryContext, name: string, attributes: SpanAttributes): Held {
  let release!: () => void;
  const done = new Promise<void>((resolve) => {
    release = resolve;
  });
  let span!: TelemetrySpan;
  void parent.startSpan({ name, attributes }, (started) => {
    span = started;
    return done;
  });
  return { span, end: release };
}

function failed(held: Held, message: string): void {
  held.span.setStatus({ status: "error", error: { name: "Error", message } });
}

function errorText(raw: string | undefined): string {
  const text = (raw ?? "").replace(/\s+/g, " ").trim();
  if (text === "") return "model request failed";
  return isSensitive(text) ? "model request failed: [redacted]" : text.slice(0, FAILURE_CHARACTERS);
}

function failureText(result: ToolResultMessage): string {
  const text = result.content
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  if (text === "") return "tool returned an error";
  return isSensitive(text) ? "tool returned an error: [redacted]" : text.slice(0, FAILURE_CHARACTERS);
}

class ConversationTrace {
  readonly #telemetry: TelemetryContext;
  readonly #attributes: SpanAttributes;
  #run: Held | undefined = undefined;
  #turn: Held | undefined = undefined;
  #message: Held | undefined = undefined;
  readonly #tools = new Map<string, Held>();
  readonly #compactions = new Map<string, Held>();

  constructor(telemetry: TelemetryContext, attributes: SpanAttributes) {
    this.#telemetry = telemetry;
    this.#attributes = attributes;
  }

  apply(event: AgentEvent): void {
    switch (event.type) {
      case "run_start":
        this.#run ??= hold(this.#telemetry, "lulu.run", { ...this.#attributes, "lulu.run.inputs": event.inputs.length });
        return;
      case "run_end":
        this.#close();
        return;
      case "turn_start":
        this.#turn ??= hold(this.#parent(), "lulu.turn", {});
        return;
      case "turn_end":
        this.#turn?.end();
        this.#turn = undefined;
        return;
      case "message_start":
        if (event.message.role === "assistant") this.#message ??= hold(this.#parent(), "chat", { "gen_ai.operation.name": "chat" });
        return;
      case "message_end":
        this.#finishMessage(event.entry.model?.[0]);
        return;
      case "tool_execution_start": {
        const parent = event.parentToolCallId === undefined ? undefined : this.#tools.get(event.parentToolCallId)?.span;
        this.#tools.set(
          event.toolCallId,
          hold(parent ?? this.#parent(), `execute_tool ${event.toolName}`, {
            "gen_ai.operation.name": "execute_tool",
            "gen_ai.tool.name": event.toolName,
            "gen_ai.tool.call.id": event.toolCallId,
          }),
        );
        return;
      }
      case "tool_execution_end": {
        const tool = this.#tools.get(event.toolCallId);
        if (tool === undefined) return;
        const result = event.entry?.model?.[0];
        if (event.entry === undefined && event.result === undefined) failed(tool, "tool call did not complete");
        else if (result?.role === "toolResult" && result.isError) failed(tool, failureText(result));
        tool.end();
        this.#tools.delete(event.toolCallId);
        return;
      }
      case "compaction_start":
        this.#compactions.set(String(event.taskId), hold(this.#parent(), "lulu.compaction", { "lulu.compaction.reason": event.reason, "lulu.compaction.blocking": event.blocking }));
        return;
      case "compaction_end": {
        const compaction = this.#compactions.get(String(event.taskId));
        if (compaction === undefined) return;
        if (event.error !== undefined) failed(compaction, event.error);
        compaction.end();
        this.#compactions.delete(String(event.taskId));
        return;
      }
      case "auto_retry_start":
        (this.#turn ?? this.#run)?.span.addEvent("lulu.retry", { "lulu.retry.attempt": event.attempt, "lulu.retry.error": event.errorMessage });
        return;
      case "entry_appended": {
        const message = event.entry.model?.[0] as AssistantMessage | undefined;
        if (message?.role === "assistant" && message.stopReason === "error") (this.#turn ?? this.#run)?.span.addEvent("lulu.model_error", { "lulu.model.error": errorText(message.errorMessage) });
        return;
      }
      case "task_failed":
        (this.#turn ?? this.#run)?.span.addEvent("lulu.task_failed", { "lulu.task.kind": event.kind, "lulu.task.error": event.message });
        return;
      default:
        return;
    }
  }

  close(): void {
    this.#close();
  }

  #parent(): TelemetryContext {
    return this.#turn?.span ?? this.#run?.span ?? this.#telemetry;
  }

  #finishMessage(message: unknown): void {
    const held = this.#message;
    if (held === undefined) return;
    const assistant = (message as { role?: string } | undefined)?.role === "assistant" ? (message as AssistantMessage) : undefined;
    if (assistant !== undefined) {
      const prompt = assistant.usage.input + assistant.usage.cacheRead + assistant.usage.cacheWrite;
      held.span.setAttributes({
        "gen_ai.provider.name": assistant.provider,
        "gen_ai.request.model": assistant.model,
        "gen_ai.response.model": assistant.responseModel ?? assistant.model,
        "gen_ai.response.id": assistant.responseId,
        "gen_ai.response.finish_reasons": [assistant.stopReason],
        "gen_ai.usage.input_tokens": assistant.usage.input,
        "gen_ai.usage.output_tokens": assistant.usage.output,
        "gen_ai.usage.cache_read.input_tokens": assistant.usage.cacheRead,
        "gen_ai.usage.cache_creation.input_tokens": assistant.usage.cacheWrite,
        "lulu.usage.total_tokens": assistant.usage.totalTokens,
        "lulu.usage.prompt_tokens": prompt,
        "lulu.usage.cache_hit_ratio": prompt > 0 ? assistant.usage.cacheRead / prompt : undefined,
      });
      if (assistant.stopReason === "error") failed(held, assistant.errorMessage ?? "model request failed");
    }
    held.end();
    this.#message = undefined;
  }

  #close(): void {
    for (const held of [...this.#tools.values(), ...this.#compactions.values()]) held.end();
    this.#tools.clear();
    this.#compactions.clear();
    this.#message?.end();
    this.#message = undefined;
    this.#turn?.end();
    this.#turn = undefined;
    this.#run?.end();
    this.#run = undefined;
  }
}

export function traceHarness(harness: Harness, telemetry: TelemetryContext, attributes: SpanAttributes): (id: ConversationId) => void {
  const seen = new Set<ConversationId>();
  const watch = (id: ConversationId): void => {
    if (seen.has(id)) return;
    seen.add(id);
    const trace = new ConversationTrace(telemetry, { ...attributes, "lulu.conversation.id": String(id) });
    void watchEvents(harness, id, BACKGROUND_CONTEXT)
      .then((stream) => {
        stream.start(async (events) => {
          for (const event of events) trace.apply(event);
        });
        void stream.closed.then(() => trace.close());
      })
      .catch((error: unknown) => console.error(JSON.stringify({ message: "Trace attach failed", error: error instanceof Error ? error.message : String(error) })));
  };
  harness.subscribeCommits((publication) => {
    for (const change of publication.changes) if (change.type === "conversation") watch(change.value.id);
  });
  return watch;
}
