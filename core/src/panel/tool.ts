import { archiveRefresh } from "../space/doc.js";
import type { ToolRegistration } from "@earendil-works/pi-durable";
import { defineTool, type ToolExecutionApi, type ToolExecutionResult } from "@earendil-works/pi-durable";
import type { Context } from "@earendil-works/chord/context";
import { Type, type Static } from "typebox";
import { withScheduleOverview } from "../cron/overview.js";
import { ChecklistWidgetInput, EMPTY_PANEL, SCHEDULE_WIDGET_ID, type Widget } from "../protocol/panel.js";
import { rememberSpace } from "../send/space-offers.js";
import { PanelDoc } from "./doc.js";

const PanelParams = Type.Object({
  action: Type.Union([Type.Literal("update"), Type.Literal("remove"), Type.Literal("list")], { description: "update | remove | list" }),
  widget: Type.Optional(ChecklistWidgetInput),
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

function isChecklist(widget: Widget): boolean {
  return widget.body.kind === "list" && widget.body.items.length > 0 && widget.body.items.every((item) => item.done !== undefined);
}

async function update(api: ToolExecutionApi<PanelDetails>, args: PanelArgs, context: Context): Promise<ToolExecutionResult<PanelDetails>> {
  const widget = args.widget;
  if (!widget) return fail("update requires widget");
  const id = widget.id.trim();
  if (id === SCHEDULE_WIDGET_ID) return fail("The Schedule Overview is updated automatically when scheduled jobs change.");
  const current = await api.snapshot(PanelDoc, context);
  const previous = current?.widgets[id];
  if (previous === undefined) return fail(`${id} is not on the panel. Only the user adds widgets: offer a new one with send_to_user type widget kind panel.`);
  if (["space", "web"].includes(previous.body.kind)) return fail("Space revisions are currently unavailable. Nothing was changed.");
  if (!isChecklist(previous)) return fail(`${id} is not a Checklist. Offer a Checklist with a new id so the existing widget stays on Panel.`);
  const updatedAt = Date.now();
  await api.commit(async (tx) => {
    const draft = await tx.doc(PanelDoc);
    const previous = draft.widgets[id];
    if (previous === undefined) throw new Error(`${id} was removed. Nothing was changed.`);
    if (!isChecklist(previous)) throw new Error(`${id} is no longer a Checklist. Nothing was changed.`);
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
    if (draft.widgets[id]?.body.kind === "space") await archiveRefresh(tx, id);
    rememberSpace(draft, draft.widgets[id]);
    delete draft.widgets[id];
  }, context);
  return ok(`removed ${id}`, "remove", id);
}

async function list(api: ToolExecutionApi<PanelDetails>, context: Context): Promise<ToolExecutionResult<PanelDetails>> {
  const state = await withScheduleOverview(api, (await api.snapshot(PanelDoc, context)) ?? EMPTY_PANEL, context);
  const widgets = state.order.flatMap((id) => state.widgets[id] ?? []);
  return ok(widgets.length === 0 ? "Panel is empty." : JSON.stringify(widgets), "list", null);
}

export const createPanelTool = (): ToolRegistration =>
  defineTool({
    name: "panel",
    description: [
      "Maintain Widgets the user has accepted on Panel.",
      "update replaces a kept Checklist by id. Read the current items with list and preserve the user's checkmarks for unchanged items.",
      "Only the user can add Widgets by swiping a card you offer with send_to_user.",
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
