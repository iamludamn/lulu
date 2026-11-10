import { defineTool, type ToolExecutionResult } from "@earendil-works/pi-durable";
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
  "type text is a chat bubble: a short conversational reply of a few sentences. Long or lasting content never goes in a bubble; save it as a document and send it as a card.",
  "For a quick answer, send it once with end_turn true. For longer work, send a short acknowledgement first, do the work, then send the result with end_turn true; the acknowledgement does not deliver the result.",
  "Do not run the final call in parallel with work you still need.",
  "type widget offers one card: kind asset offers a file you saved with the artifact tools (a document or an html asset), kind panel offers a panel widget. A space, the small app page the user keeps on their panel, is a kind panel card whose body is { kind: space, src, refresh }; never offer a space as a kind asset card.",
  "A card is only an offer. Nothing reaches the user's assets or panel until the user swipes it, and a new version of a document you already offered is a new offer too. So never say you added anything to their assets or panel; say you are offering it.",
  "A type widget call carries only the card and never content: send the short takeaway as its own type text call first, so the user gets the gist without opening anything. Send at most one card per call. The card is the last call of the turn and carries end_turn true; never end the turn on a text that announces a card you have not sent. One short acknowledgement is enough while work runs in the background: do not send further waiting or filler messages.",
].join(" ");

function tooLong(content: string): boolean {
  return content.length > TEXT_LIMIT.chars || content.split("\n").filter((line) => line.trim() !== "").length > TEXT_LIMIT.lines || DOCUMENT_SHAPE.test(content);
}

function misuse(input: SendInput, files: boolean): string | undefined {
  if (input.type === "text") {
    if (input.widget !== undefined) return "widget is only valid with type widget. Nothing was sent. Send the card as its own type widget call.";
    if (!input.content?.trim()) return "type text requires content. Nothing was sent.";
    if (files && tooLong(input.content))
      return "This text is too long for a chat bubble. Nothing was sent. Write it to a .md file with mcp__artifact__write, then send a short type text saying what it is and a type widget kind asset card with the returned ref.";
    return undefined;
  }
  if (input.content !== undefined) return "content is only valid with type text and would be dropped from a widget. Nothing was sent, so the card has not been delivered. Send the text as its own type text call, then send the card again without content.";
  if (input.widget === undefined) return "type widget requires widget. Nothing was sent.";
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
      const refused = misuse(input, exists !== undefined) ?? (input.widget === undefined ? undefined : await missingAsset(input.widget, exists));
      if (refused !== undefined) return fail(refused);
      const end = input.end_turn === true;
      return {
        output: [{ type: "text", text: end ? "Delivered. Your turn is complete." : "Delivered." }],
        details: { type: input.type, end },
        ...(end && { control: { terminate: true } }),
      };
    },
  });
