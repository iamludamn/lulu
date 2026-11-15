import type { ToolRegistration } from "@earendil-works/pi-durable";
import { defineTool, type ToolExecutionApi, type ToolExecutionResult } from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord/context";
import { Type, type Static } from "typebox";
import { WidgetInput } from "../protocol/panel.js";
import { rememberSpace } from "../send/space-offers.js";
import { PanelDoc } from "./doc.js";

const PanelParams = Type.Object({
  action: Type.Union([Type.Literal("update"), Type.Literal("remove"), Type.Literal("list")], { description: "update | remove | list" }),
  widget: Type.Optional(WidgetInput),
  id: Type.Optional(Type.String({ description: "Widget id for remove" })),
});

type PanelArgs = Static<typeof PanelParams>;
type PanelDetails = { action: string; id: string | null };

function ok(text: string, action: string, id: string | null): ToolExecutionResult<PanelDetails> {
  return { output: [{ type: "text", text }], details: { action, id } };
}

function fail(text: string): ToolExecutionResult<PanelDetails> {
  return { output: [{ type: "text", text }], details: { action: "error", id: null }, isError: true };
}

async function update(api: ToolExecutionApi<PanelDetails>, args: PanelArgs, context: Context): Promise<ToolExecutionResult<PanelDetails>> {
  const widget = args.widget;
  if (!widget) return fail("update requires widget");
  const id = widget.id.trim();
  const current = await api.snapshot(PanelDoc, context);
  const previous = current?.widgets[id];
  if (previous === undefined) return fail(`${id} is not on the panel. Only the user adds widgets: offer a new one with send_to_user type widget kind panel.`);
  const wasSpace = (previous.body.kind as string) === "space" || (previous.body.kind as string) === "web";
  if (wasSpace !== (widget.body.kind === "space")) {
    return fail(`${id} ${wasSpace ? "is a space and cannot become another kind of widget" : "is not a space and cannot become one"}: its saved state would be lost. Nothing was changed. Offer a new widget with a new id instead.`);
  }
  if (wasSpace) return fail("Space changes require user approval. Save a new page version, then offer a send_to_user panel card with the same id and new ref. The user swipes to apply it. Nothing was changed.");
  const updatedAt = Date.now();
  await api.commit(async (tx) => {
    const draft = await tx.doc(PanelDoc);
    const previous = draft.widgets[id];
    if (previous === undefined) throw new Error(`${id} was removed. Nothing was changed.`);
    if (["space", "web"].includes(previous.body.kind)) throw new Error("Space changes require a preview card and user approval.");
    draft.widgets[id] = { ...widget, id, updatedAt, ...(previous.origin !== undefined && { origin: previous.origin }) };
  }, context);
  return ok(`updated ${id} (${widget.body.kind}, ${widget.size})`, "update", id);
}

async function remove(api: ToolExecutionApi<PanelDetails>, args: PanelArgs, context: Context): Promise<ToolExecutionResult<PanelDetails>> {
  const id = args.id?.trim();
  if (!id) return fail("remove requires id");
  await api.commit(async (tx) => {
    const draft = await tx.doc(PanelDoc);
    draft.order = draft.order.filter((entry) => entry !== id);
    rememberSpace(draft, draft.widgets[id]);
    delete draft.widgets[id];
  }, context);
  return ok(`removed ${id}`, "remove", id);
}

async function list(api: ToolExecutionApi<PanelDetails>, context: Context): Promise<ToolExecutionResult<PanelDetails>> {
  const state = await api.snapshot(PanelDoc, context);
  const widgets = (state?.order ?? []).flatMap((id) => state?.widgets[id] ?? []);
  return ok(widgets.length === 0 ? "Panel is empty." : JSON.stringify(widgets), "list", null);
}

export const createPanelTool = (): ToolRegistration =>
  defineTool({
    name: "panel",
    description: [
      "Maintain the widgets the user already keeps on their panel, the dashboard beside this chat.",
      "update replaces a kept non-space widget by id. Space revisions must instead be offered with send_to_user using the same id and a new artifact ref for the user to swipe and accept; it cannot add new widgets, which only the user does by swiping a card you offer with send_to_user.",
      "Pick the body kind by the shape of the information: stat for one number or status, gauge for progress toward a limit, chart for a trend, list for items or a checklist, timeline for dated events, note for a short summary, media for one image, actions for ready-made requests, weather for a city's forecast (only the city; the client fetches and refreshes it by itself once a day, so never update it), space for a small app page the user keeps, one that fetches live data or remembers what the user does (an .html artifact; read the `space` skill of the artifact server first). Never change a widget into or out of a space: its saved state would be lost.",
      "Offer a panel widget only for information the user will check repeatedly and that changes over time, such as a balance, a progress figure, a countdown, a schedule or a short checklist. Do not offer one for a one-off answer; that is a chat reply or a document. Offer at most one widget per conversation topic, and prefer updating a kept widget over offering a new one.",
      "To keep a widget fresh, create a daily schedule whose prompt updates it by id. Weather and space widgets refresh themselves, so never schedule updates for them.",
    ].join(" "),
    parameters: PanelParams,
    replay: "safe",
    executionMode: "parallel",
    execute: async (args, api, context) => {
      switch ((args as PanelArgs).action) {
        case "update":
          return update(api, args as PanelArgs, context);
        case "remove":
          return remove(api, args as PanelArgs, context);
        case "list":
          return list(api, context);
        default:
          return fail("unknown action: " + String((args as PanelArgs).action));
      }
    },
  });
