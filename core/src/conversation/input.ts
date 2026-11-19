import type { InputSubmissionDraft } from "@earendil-works/pi-durable";
import type { BusyMode } from "../protocol/contract.js";

export type ScheduleMessageSource = { kind: "schedule_message"; scheduleId: string; scheduledFor: number };

export type RunInput = { requestId: string; content: string } & (
  | { kind: "user_message"; whenBusy: BusyMode }
  | ScheduleMessageSource
  | { kind: "integration"; integrationId: string; eventId: string }
  | { kind: "delegate_result"; runId: string }
  | { kind: "delivery_retry"; messageId: number }
  | { kind: "widget_request"; origin: string }
);

export function inputSubmission({ requestId, content, ...source }: RunInput): InputSubmissionDraft {
  const draft = { type: "input", requestId, content } as const;
  if (source.kind === "user_message") return { ...draft, whenBusy: source.whenBusy };
  return { ...draft, whenBusy: "followUp", entry: { kind: "lulu.input", data: source } };
}
