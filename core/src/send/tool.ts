import type { Context } from "@earendil-works/chord/context";
import { defineExtension, defineTool, type DocumentReader, type ToolExecutionResult } from "@earendil-works/pi-durable";
import { Type, type Static, type TSchema } from "typebox";
import { Value } from "typebox/value";
import { requestIdsForReply } from "../conversation/requests.js";
import { STORED_EXTENSION_NAMES } from "../durable-names.js";
import { SEND_TOOL, SendInput, type SendCard, type SendDetails } from "../protocol/send.js";

export type SendGuidance = {
  instructions?: readonly string[];
  preamble?: readonly string[];
};

type PreparedCard = { card: SendCard } | { error: string };
type SendRead = Pick<DocumentReader, "snapshot">;
export type CardContribution = SendGuidance & {
  schema: TSchema;
  prepare(input: unknown, read: SendRead, context: Context): Promise<PreparedCard> | PreparedCard | undefined;
};

export type SendContribution = SendGuidance | CardContribution;

export function defineSendCard<S extends TSchema>(definition: SendGuidance & {
  schema: S;
  prepare: (input: Static<S>, read: SendRead, context: Context) => Promise<PreparedCard> | PreparedCard;
}): CardContribution {
  const { schema, prepare, ...guidance } = definition;
  return {
    ...guidance,
    schema,
    prepare(input, read, context) {
      return Value.Check(schema, input) ? prepare(input, read, context) : undefined;
    },
  };
}

export const SEND_PREAMBLE = [
  "Chat is for conversation: an answer, a question, a confirmation, a few sentences.",
  "When the content is long (a report, plan, guide, comparison, research, step-by-step instructions, a long list or table, or simply more than about ten lines, or anything with headings, tables or command output), put the full Markdown in body of the same send_to_user text call and give the user the gist in content, in one to three sentences. The body is the delivery: do not also offer it as a file. Never split a long answer into several messages.",
  "Write body like a good colleague: a title, the conclusion first, then headings, lists and tables where they help, in the language the user writes in.",
  "Nothing you make enters the user's assets or panel on its own. You offer it as a card and the user decides whether to keep it.",
].join(" ");

const DESCRIPTION = [
  "Send a message to the user in Chat. Use send_to_user for every user-visible text message or card.",
  "Every acknowledgement, question, progress update and result must be its own send_to_user call. A turn that ends without one leaves the user in silence.",
  "type text is a chat bubble: a short conversational reply of a few sentences.",
  "Long or structured content (a report, plan, list, table, steps, research) goes in body of the same type text call, written as Markdown with a title, the conclusion first, then headings, lists and tables where they help. Put a one-to-three sentence gist in content that tells the user what is behind the tap: the user sees content as a short bubble and taps it to read body. The body is the delivery: do not also save it as a file or offer an asset card for it, and do not mention files, documents or saving in content. Never split long content over several messages.",
  "For a quick answer, send it once with end_turn true. For longer work, send a short acknowledgement first, do the work, then send the result with end_turn true; the acknowledgement does not deliver the result.",
  "Do not run the final call in parallel with work you still need.",
  "The user swipes a card to accept it. Describe the card as ready to accept until the user accepts it.",
  "A type widget call carries only the card and never content: send the short takeaway as its own type text call first, unless the card instructions call for just the card or the user used the message-to-widget action. Send at most one card per call. The card is the last call of the turn and carries end_turn true; never end the turn on a text that announces a card you have not sent. One short acknowledgement is enough while work runs in the background: do not send further waiting or filler messages.",
];

const TEXT_LIMIT = { chars: 600, lines: 12 };
const DOCUMENT_SHAPE = /^(#{1,6} |\|.+\|\s*$)/m;
type ModelSendInput = Omit<SendInput, "widget"> & { widget?: unknown };

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
  return undefined;
}

function fail(text: string): ToolExecutionResult<SendDetails> {
  return { output: [{ type: "text", text }], details: { type: "error", end: false }, isError: true };
}

export function createSendTool(contributions: readonly SendContribution[]) {
  const cards = contributions.filter((contribution): contribution is CardContribution => "schema" in contribution);
  const widget = cards.length === 0
    ? Type.Never()
    : Type.Union(cards.map(({ schema }) => schema), { description: "Card to offer for type widget" });
  const parameters = Type.Object({ ...SendInput.properties, widget: Type.Optional(widget) });
  return defineTool({
    name: SEND_TOOL,
    description: [...DESCRIPTION, ...contributions.flatMap(({ instructions }) => instructions ?? [])].join(" "),
    parameters,
    callers: ["model"],
    replay: "safe",
    executionMode: "sequential",
    execute: async (input, api, context): Promise<ToolExecutionResult<SendDetails>> => {
      const refused = misuse(input);
      if (refused !== undefined) return fail(refused);
      let widget: SendCard | undefined;
      if (input.type === "widget") {
        for (const card of cards) {
          const prepared = await card.prepare(input.widget, api, context);
          if (prepared === undefined) continue;
          if ("error" in prepared) return fail(prepared.error);
          widget = prepared.card;
          break;
        }
        if (widget === undefined) return fail("This card is not supported. Nothing was sent.");
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
}

export const createSendExtension = (contributions: readonly SendContribution[]) =>
  defineExtension({
    name: STORED_EXTENSION_NAMES.send,
    tools: [createSendTool(contributions)],
  });
