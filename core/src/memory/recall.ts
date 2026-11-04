import type { TelemetryContext } from "@earendil-works/pi-telemetry";
import type { Environment } from "../host/types.js";
import type { Episode } from "./doc.js";
import { isSensitive } from "./guard.js";

const ENDPOINT = "https://api.typesafe.ai/v1/systemone";
const MODEL = "jev-latest";
const QUESTION = "needs_memory";
const TIMEOUT_MS = 2500;
const THRESHOLD = 0.8;

export type Turn = Pick<Episode, "role" | "text">;

export type RecallDecision = {
  inject: boolean;
  probability?: number;
  fallback?: "unconfigured" | "timeout" | "error";
};

const question = {
  type: "noul",
  instructions:
    "Does the latest user message need long-term personal memory about this user (who they are, their preferences, relationships, ongoing projects, or earlier conversations) to be answered well? Answer no for general knowledge questions, one-off tasks, greetings, and anything fully answerable from the conversation itself.",
  criteria: {
    true: "The reply depends on stored facts about this user, or refers to something from earlier conversations",
    false: "The reply needs nothing beyond the current conversation and general knowledge",
  },
};

const stateOf = (turns: readonly Turn[]): string =>
  turns.map((turn) => `${turn.role}: ${isSensitive(turn.text) ? "[redacted]" : turn.text}`).join("\n");

async function ask(key: string, turns: readonly Turn[]): Promise<RecallDecision> {
  try {
    const response = await fetch(ENDPOINT, {
      method: "POST",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({ model: MODEL, state: stateOf(turns), questions: { [QUESTION]: question } }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) return { inject: true, fallback: "error" };
    const body = (await response.json()) as { answers?: Record<string, { noul?: number }> };
    const probability = body.answers?.[QUESTION]?.noul;
    if (typeof probability !== "number") return { inject: true, fallback: "error" };
    return { inject: probability >= THRESHOLD, probability };
  } catch (error) {
    return { inject: true, fallback: error instanceof Error && error.name === "TimeoutError" ? "timeout" : "error" };
  }
}

export function judgeRecall(env: Environment, telemetry: TelemetryContext, turns: readonly Turn[]): Promise<RecallDecision> {
  const key = env.TYPESAFE_API_KEY;
  if (!key) return Promise.resolve({ inject: true, fallback: "unconfigured" });
  return telemetry.startSpan({ name: "memory.recall", attributes: { "lulu.recall.threshold": THRESHOLD } }, async (span) => {
    const decision = await ask(key, turns);
    span.setAttributes({ "lulu.recall.inject": decision.inject, "lulu.recall.probability": decision.probability, "lulu.recall.fallback": decision.fallback });
    return decision;
  });
}
