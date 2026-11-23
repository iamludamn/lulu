import { requestIdsForReply } from "../conversation/requests.js";
import { scheduleOverviewCard } from "../panel.js";
import { defineExtension, defineTool, type ToolExecutionResult, type ToolRegistration } from "@earendil-works/pi-durable";
import { SCHEDULE_WIDGET_ID } from "../protocol/panel.js";
import type { SendCard, SendDetails } from "../protocol/send.js";
import { ARTIFACT_REF, SEND_TOOL, isScheduleOverviewRequest, ModelSendInput } from "../protocol/send.js";
import { assetRefProblem, spacePreviewProblem, spaceRefProblem } from "../artifact/space.js";
import { STORED_EXTENSION_NAMES } from "../durable-names.js";
import { monitorProblem } from "../space/monitor-contract.js";

const TEXT_LIMIT = { chars: 600, lines: 12 };
const DOCUMENT_SHAPE = /^(#{1,6} |\|.+\|\s*$)/m;

export type ArtifactCheck = (name: string, version: number) => Promise<boolean>;

const DESCRIPTION = [
  "Send a message to the user in Chat. Use send_to_user for every user-visible text message or card.",
  "Every acknowledgement, question, progress update and result must be its own send_to_user call. A turn that ends without one leaves the user in silence.",
  "type text is a chat bubble: a short conversational reply of a few sentences.",
  "Long or structured content (a report, plan, list, table, steps, research) goes in body of the same type text call, written as Markdown with a title, the conclusion first, then headings, lists and tables where they help. Put a one-to-three sentence gist in content that tells the user what is behind the tap: the user sees content as a short bubble and taps it to read body. The body is the delivery: do not also save it as a file or offer an asset card for it, and do not mention files, documents or saving in content. Never split long content over several messages.",
  "For a quick answer, send it once with end_turn true. For longer work, send a short acknowledgement first, do the work, then send the result with end_turn true; the acknowledgement does not deliver the result. For a [space-monitor] repair, send only the finished Space update card when the revision is ready.",
  "Do not run the final call in parallel with work you still need.",
  "type widget sends one card to Chat. Offer a Checklist when the user wants items they can check off over time. Use kind panel with body { kind: list, items } and a done boolean on every item. Use size m for up to three short items and l for up to eight. Use kind asset for a requested file, including a finished HTML Asset.",
  "Use schedule with mode=reminder to set an Alarm. Confirm the time in text after creation succeeds.",
  "Use widget { kind: panel, panel: { body: { kind: schedules } } } to offer the Schedule Overview. The server supplies the job rows. A Schedule Overview already kept on Panel updates from the saved jobs.",
  "For a Space powered by a web monitor, read artifact skill space-monitor. Offer it using body.kind space with monitor.url, monitor.goal and monitor.schema. The monitor starts when the user keeps the offer.",
  "The user swipes a card to accept its Widget or Asset. Describe the card as ready to accept until the user accepts it.",
  "A type widget call carries only the card and never content: send the short takeaway as its own type text call first, except for a [space-monitor] repair or when the user used the message-to-widget action. Send at most one card per call. Dispatch any outstanding additions or corrections to delegated work before sending the card. The card is the last call of the turn and carries end_turn true; never end the turn on a text that announces a card you have not sent. One short acknowledgement is enough while work runs in the background: do not send further waiting or filler messages.",
].join(" ");

function tooLong(content: string): boolean {
  return content.length > TEXT_LIMIT.chars || content.split("\n").filter((line) => line.trim() !== "").length > TEXT_LIMIT.lines || DOCUMENT_SHAPE.test(content);
}

function misuse(input: ModelSendInput): string | undefined {
  if (input.type === "text") {
    if (input.widget !== undefined) return "widget is only valid with type widget. Nothing was sent. Send the card as its own type widget call.";
    if (!input.content?.trim()) return "type text requires content. Nothing was sent.";
    if (input.body !== undefined && !input.body.trim()) return "body must not be empty. Nothing was sent. Omit body or put the full Markdown in it.";
    if (tooLong(input.content))
      return "content is too long for a chat bubble. Nothing was sent. Send the same call again with a one-to-three sentence gist in content and the full Markdown in body.";
    return undefined;
  }
  if (input.body !== undefined) return "body is only valid with type text and would be dropped from a widget. Nothing was sent, so the card has not been delivered. Send the text as its own type text call with body, then send the card again without body.";
  if (input.content !== undefined) return "content is only valid with type text and would be dropped from a widget. Nothing was sent, so the card has not been delivered. Send the text as its own type text call, then send the card again without content.";
  if (input.widget === undefined) return "type widget requires widget. Nothing was sent.";
  const card = input.widget;
  if (isScheduleOverviewRequest(card)) return undefined;
  if (card.kind === "panel" && card.panel.id === SCHEDULE_WIDGET_ID) return "Use widget { kind: panel, panel: { body: { kind: schedules } } } to send the Schedule Overview.";
  return undefined;
}

async function missingAsset(ref: string, exists: ArtifactCheck | undefined): Promise<string | undefined> {
  const refused = assetRefProblem(ref);
  if (refused !== undefined) return refused;
  if (exists === undefined) return "Artifacts are not available here, so asset cards cannot be sent. Nothing was sent.";
  const match = ARTIFACT_REF.exec(ref);
  if (match === null) return "ref must look like artifact://name@version. Nothing was sent.";
  if (!await exists(match[1], Number(match[2]))) return `${ref} does not exist. Nothing was sent. Save the file with the artifact tools first and use the ref they return.`;
  return undefined;
}

function fail(text: string): ToolExecutionResult<SendDetails> {
  return { output: [{ type: "text", text }], details: { type: "error", end: false }, isError: true };
}

export const createSendTool = (exists: ArtifactCheck | undefined, monitorConfigured = false): ToolRegistration<typeof ModelSendInput, SendDetails> =>
  defineTool({
    name: SEND_TOOL,
    description: DESCRIPTION,
    parameters: ModelSendInput,
    callers: ["model"],
    replay: "safe",
    executionMode: "sequential",
    execute: async (input, api, context) => {
      const refused = misuse(input);
      if (refused !== undefined) return fail(refused);
      let widget: SendCard | undefined;
      if (isScheduleOverviewRequest(input.widget)) {
        widget = await scheduleOverviewCard(api, context);
        if (widget === undefined) return fail("The Schedule Overview is already on Panel. Send a text confirmation about the schedule.");
      } else if (input.widget?.kind === "asset") {
        const problem = await missingAsset(input.widget.ref, exists);
        if (problem !== undefined) return fail(problem);
      } else if (input.widget?.kind === "panel" && input.widget.panel.body.kind === "space") {
        if (!monitorConfigured) return fail("Context.dev monitoring is unavailable in this deployment.");
        const { id, body } = input.widget.panel;
        const problem = monitorProblem(body.monitor) ?? spaceRefProblem(id, body.src) ?? spacePreviewProblem(id, body.preview);
        if (problem !== undefined) return fail(problem);
        if (exists === undefined) return fail("Artifact storage is unavailable.");
        for (const ref of [body.src, body.preview]) {
          const match = ARTIFACT_REF.exec(ref);
          if (match === null || !await exists(match[1], Number(match[2]))) return fail("Space artifact missing: " + ref);
        }
      }
      const end = input.end_turn === true;
      const requestIds = await requestIdsForReply(api, api.conversationId, context);
      return {
        output: [{ type: "text", text: end ? "Delivered. Your turn is complete." : "Delivered." }],
        details: { type: input.type, end, ...(requestIds.length > 0 ? { requestIds } : {}), ...(widget && { widget }) },
        ...(end && { control: { terminate: true } }),
      };
    },
  });

export const createSendExtension = (exists: ArtifactCheck | undefined, monitorConfigured = false) =>
  defineExtension({
    name: STORED_EXTENSION_NAMES.send,
    tools: [createSendTool(exists, monitorConfigured)],
  });
