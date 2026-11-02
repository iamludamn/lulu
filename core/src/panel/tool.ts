import { defineTool, type ToolExecutionApi, type ToolExecutionResult } from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";
import { WidgetInput } from "../protocol/panel.js";
import { PanelDoc } from "./doc.js";

const PanelParams = Type.Object({
  action: StringEnum(["update", "remove", "move", "list"], { description: "update | remove | move | list" }),
  widget: Type.Optional(WidgetInput),
  id: Type.Optional(Type.String({ description: "Widget id for remove and move" })),
  index: Type.Optional(Type.Integer({ minimum: 0, description: "Target position for move, 0 is first" })),
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
  if (current?.widgets[id] === undefined) return fail(`${id} is not on the panel. Only the user adds widgets: offer a new one with send_to_user type widget kind panel.`);
  const updatedAt = Date.now();
  await api.commit(async (tx) => {
    const draft = await tx.doc(PanelDoc);
    const previous = draft.widgets[id];
    if (previous === undefined) return;
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
    delete draft.widgets[id];
  }, context);
  return ok(`removed ${id}`, "remove", id);
}

async function move(api: ToolExecutionApi<PanelDetails>, args: PanelArgs, context: Context): Promise<ToolExecutionResult<PanelDetails>> {
  const id = args.id?.trim();
  if (!id || args.index === undefined) return fail("move requires id and index");
  const current = (await api.snapshot(PanelDoc, context))?.order ?? [];
  if (!current.includes(id)) return fail("unknown id: " + id);
  await api.commit(async (tx) => {
    const draft = await tx.doc(PanelDoc);
    const rest = draft.order.filter((entry) => entry !== id);
    rest.splice(Math.min(args.index ?? 0, rest.length), 0, id);
    draft.order = rest;
  }, context);
  return ok(`moved ${id} to ${args.index}`, "move", id);
}

async function list(api: ToolExecutionApi<PanelDetails>, context: Context): Promise<ToolExecutionResult<PanelDetails>> {
  const state = await api.snapshot(PanelDoc, context);
  const widgets = (state?.order ?? []).flatMap((id) => state?.widgets[id] ?? []);
  return ok(widgets.length === 0 ? "Panel is empty." : JSON.stringify(widgets), "list", null);
}

export const PanelTool = defineTool({
  name: "panel",
  description: [
    "Maintain the widgets the user already keeps on their panel, the dashboard beside this chat.",
    "update replaces a kept widget's content by id, keeping its id; it cannot add new widgets, which only the user does by swiping a card you offer with send_to_user.",
    "Pick the body kind by the shape of the information: stat for one number or status, gauge for progress toward a limit, chart for a trend, list for items or a checklist, timeline for dated events, note for a short summary, media for one image, actions for ready-made requests.",
    "Offer a panel widget only for information the user will check repeatedly and that changes over time, such as a balance, a progress figure, a countdown, a schedule or a short checklist. Do not offer one for a one-off answer; that is a chat reply or a document. Offer at most one widget per conversation topic, and prefer updating a kept widget over offering a new one.",
    "To keep a widget fresh, create a daily schedule whose prompt updates it by id.",
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
      case "move":
        return move(api, args as PanelArgs, context);
      case "list":
        return list(api, context);
      default:
        return fail("unknown action: " + String((args as PanelArgs).action));
    }
  },
});
