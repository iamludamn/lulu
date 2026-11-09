import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { AssistantMessage, ToolResultMessage } from "@earendil-works/pi-ai";
import { watchEvents, type AgentEvent, type ConversationId, type Harness } from "@earendil-works/pi-durable";
import type { SpanAttributes, TelemetryContext, TelemetrySpan } from "@earendil-works/pi-telemetry";
import { isSensitive } from "../memory/guard.js";

const FAILURE_CHARACTERS = 300;

type Held = { readonly span: TelemetrySpan; end(): void };

type Totals = {
  turns: number;
  chats: number;
  tools: number;
  toolErrors: number;
  delegates: number;
  retries: number;
  compactions: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cost: number;
};

const emptyTotals = (): Totals => ({ turns: 0, chats: 0, tools: 0, toolErrors: 0, delegates: 0, retries: 0, compactions: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cost: 0 });

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
  readonly #scope: SpanAttributes;
  #run: Held | undefined = undefined;
  #totals = emptyTotals();
  #turn: Held | undefined = undefined;
  #message: Held | undefined = undefined;
  readonly #tools = new Map<string, Held>();
  readonly #compactions = new Map<string, Held>();

  constructor(telemetry: TelemetryContext, attributes: SpanAttributes) {
    this.#telemetry = telemetry;
    this.#attributes = attributes;
    this.#scope = { "lulu.bot.id": attributes["lulu.bot.id"], "lulu.agent": attributes["lulu.agent"], "lulu.conversation.kind": attributes["lulu.conversation.kind"] };
  }

  apply(event: AgentEvent): void {
    switch (event.type) {
      case "run_start":
        if (this.#run === undefined) this.#totals = emptyTotals();
        this.#run ??= hold(this.#telemetry, "lulu.run", { ...this.#attributes, "lulu.run.inputs": event.inputs.length });
        return;
      case "run_end":
        this.#close();
        return;
      case "turn_start":
        if (this.#turn === undefined) this.#totals.turns += 1;
        this.#turn ??= this.#child(this.#parent(), "lulu.turn", {});
        return;
      case "turn_end":
        this.#turn?.end();
        this.#turn = undefined;
        return;
      case "message_start":
        if (event.message.role === "assistant") this.#message ??= this.#child(this.#parent(), "chat", { "gen_ai.operation.name": "chat" });
        return;
      case "message_end":
        this.#finishMessage(event.entry.model?.[0]);
        return;
      case "tool_execution_start": {
        this.#totals.tools += 1;
        if (event.toolName === "delegate" && event.parentToolCallId === undefined) this.#totals.delegates += 1;
        const parent = event.parentToolCallId === undefined ? undefined : this.#tools.get(event.parentToolCallId)?.span;
        this.#tools.set(
          event.toolCallId,
          this.#child(parent ?? this.#parent(), `execute_tool ${event.toolName}`, {
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
        const incomplete = event.entry === undefined && event.result === undefined;
        const errored = result?.role === "toolResult" && result.isError;
        if (incomplete) failed(tool, "tool call did not complete");
        else if (errored) failed(tool, failureText(result));
        if (incomplete || errored) this.#totals.toolErrors += 1;
        tool.end();
        this.#tools.delete(event.toolCallId);
        return;
      }
      case "compaction_start":
        this.#totals.compactions += 1;
        this.#compactions.set(String(event.taskId), this.#child(this.#parent(), "lulu.compaction", { "lulu.compaction.reason": event.reason, "lulu.compaction.blocking": event.blocking }));
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
        this.#totals.retries += 1;
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

  #child(parent: TelemetryContext, name: string, attributes: SpanAttributes): Held {
    return hold(parent, name, { ...this.#scope, ...attributes });
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
        "lulu.usage.cost": assistant.usage.cost.total,
        "lulu.usage.cache_hit_ratio": prompt > 0 ? assistant.usage.cacheRead / prompt : undefined,
      });
      this.#totals.chats += 1;
      this.#totals.inputTokens += assistant.usage.input;
      this.#totals.outputTokens += assistant.usage.output;
      this.#totals.cacheReadTokens += assistant.usage.cacheRead;
      this.#totals.cost += assistant.usage.cost.total;
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
    if (this.#run !== undefined) {
      const totals = this.#totals;
      this.#run.span.setAttributes({
        "lulu.run.turns": totals.turns,
        "lulu.run.chats": totals.chats,
        "lulu.run.tools": totals.tools,
        "lulu.run.tool_errors": totals.toolErrors,
        "lulu.run.delegates": totals.delegates,
        "lulu.run.retries": totals.retries,
        "lulu.run.compactions": totals.compactions,
        "lulu.run.input_tokens": totals.inputTokens,
        "lulu.run.output_tokens": totals.outputTokens,
        "lulu.run.cache_read_tokens": totals.cacheReadTokens,
        "lulu.run.cost": totals.cost,
      });
    }
    this.#run?.end();
    this.#run = undefined;
  }
}

export function traceHarness(harness: Harness, telemetry: TelemetryContext, attributes: SpanAttributes): (id: ConversationId) => void {
  const seen = new Set<ConversationId>();
  const watch = (id: ConversationId, parent?: ConversationId): void => {
    if (seen.has(id)) return;
    seen.add(id);
    const trace = new ConversationTrace(telemetry, {
      ...attributes,
      "lulu.conversation.id": String(id),
      "lulu.conversation.kind": parent === undefined ? "root" : "delegate",
      "lulu.conversation.parent": parent === undefined ? undefined : String(parent),
    });
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
    for (const change of publication.changes) if (change.type === "conversation") watch(change.value.id, change.value.owner?.conversationId);
  });
  return (id) => watch(id);
}
