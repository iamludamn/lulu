import { defineTool, type ToolExecutionResult } from "@earendil-works/pi-durable";
import { SPACE_ID } from "../protocol/panel.js";
import type { SendCard, SendInput } from "../protocol/send.js";
import { ARTIFACT_REF, SEND_TOOL, SendInput as SendParams } from "../protocol/send.js";
import { assetRefProblem, spaceRefProblem } from "../artifact/space.js";

const TEXT_LIMIT = { chars: 600, lines: 12 };
const DOCUMENT_SHAPE = /^(#{1,6} |\|.+\|\s*$)/m;

export type ArtifactCheck = (name: string, version: number) => Promise<boolean>;

type SendDetails = { type: string; end: boolean };

const DESCRIPTION = [
  "Say something to the user in the PiStack chat. This is your only voice: the user only ever sees send_to_user calls, and your plain assistant text is a private scratchpad they never see.",
  "Every acknowledgement, question, progress update and result must be its own send_to_user call. A turn that ends without one leaves the user in silence.",
  "type text is a chat bubble: a short conversational reply of a few sentences.",
  "Long or structured content (a report, plan, list, table, steps, research) goes in body of the same type text call, written as Markdown with a title, the conclusion first, then headings, lists and tables where they help. Put a one-to-three sentence gist in content that tells the user what is behind the tap: the user sees content as a short bubble and taps it to read body. The body is the delivery: do not also save it as a file or offer an asset card for it, and do not mention files, documents or saving in content. Never split long content over several messages.",
  "For a quick answer, send it once with end_turn true. For longer work, send a short acknowledgement first, do the work, then send the result with end_turn true; the acknowledgement does not deliver the result.",
  "Do not run the final call in parallel with work you still need.",
  "type widget offers one card: kind asset offers a file the user asked to keep or an html asset you saved with the artifact tools, kind panel offers a panel widget. A space, the small app page the user keeps on their panel, is a kind panel card whose body is { kind: space, src, refresh }; never offer a space as a kind asset card.",
  "A card is only an offer. Nothing reaches the user's assets or panel until the user swipes it, and a new version of a document you already offered is a new offer too. So never say you added anything to their assets or panel; say you are offering it.",
  "A type widget call carries only the card and never content: send the short takeaway as its own type text call first, so the user gets the gist without opening anything. Send at most one card per call. The card is the last call of the turn and carries end_turn true; never end the turn on a text that announces a card you have not sent. One short acknowledgement is enough while work runs in the background: do not send further waiting or filler messages.",
].join(" ");

function tooLong(content: string): boolean {
  return content.length > TEXT_LIMIT.chars || content.split("\n").filter((line) => line.trim() !== "").length > TEXT_LIMIT.lines || DOCUMENT_SHAPE.test(content);
}

function misuse(input: SendInput): string | undefined {
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
  if (card.kind === "panel" && card.panel.body.kind === "space" && !SPACE_ID.test(card.panel.id))
    return "A space widget id is the key of its saved state, so it must be letters, digits, - or _, start with a letter or digit, and be at most 64 characters. Nothing was sent. Send the card again with a valid id.";
  return undefined;
}

const cardRef = (card: SendCard): string | undefined => {
  if (card.kind === "asset") return card.ref;
  return card.panel.body.kind === "space" ? card.panel.body.src : undefined;
};

const misplaced = (card: SendCard): string | undefined => {
  if (card.kind === "asset") return assetRefProblem(card.ref);
  const body = card.panel.body;
  const problem = body.kind === "space" ? spaceRefProblem(card.panel.id.trim(), body.src) : undefined;
  return problem === undefined ? undefined : problem.replace("Nothing was changed.", "Nothing was sent.");
};

async function missingAsset(card: SendCard, exists: ArtifactCheck | undefined): Promise<string | undefined> {
  const ref = cardRef(card);
  if (ref === undefined) return undefined;
  const refused = misplaced(card);
  if (refused !== undefined) return refused;
  if (exists === undefined) return "Artifacts are not available here, so asset and space cards cannot be sent. Nothing was sent.";
  const match = ARTIFACT_REF.exec(ref);
  if (match === null) return "ref must look like artifact://name@version. Nothing was sent.";
  return (await exists(match[1], Number(match[2]))) ? undefined : `${ref} does not exist. Nothing was sent. Save the file with the artifact tools first and use the ref they return.`;
}

function fail(text: string): ToolExecutionResult<SendDetails> {
  return { output: [{ type: "text", text }], details: { type: "error", end: false }, isError: true };
}

export const createSendTool = (exists: ArtifactCheck | undefined) =>
  defineTool({
    name: SEND_TOOL,
    description: DESCRIPTION,
    parameters: SendParams,
    replay: "safe",
    executionMode: "sequential",
    execute: async (args) => {
      const input = args as SendInput;
      const refused = misuse(input) ?? (input.widget === undefined ? undefined : await missingAsset(input.widget, exists));
      if (refused !== undefined) return fail(refused);
      const end = input.end_turn === true;
      return {
        output: [{ type: "text", text: end ? "Delivered. Your turn is complete." : "Delivered." }],
        details: { type: input.type, end },
        ...(end && { control: { terminate: true } }),
      };
    },
  });
