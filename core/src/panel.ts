import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
import { defineDoc, defineExtension, defineTool, section, type DocumentReader, type EntryRecord, type Harness, type ToolExecutionApi, type ToolExecutionResult, type ToolRegistration } from "@earendil-works/pi-durable";
import { Type, type Static } from "typebox";
import { spaceRefProblem, spacePreviewProblem } from "./artifact/space.js";
import { deliveredSentIn, type Sent } from "./conversation/transcript.js";
import { withScheduleOverview } from "./cron/schedule.js";
import { STORED_DOC_KINDS, STORED_EXTENSION_NAMES } from "./durable-names.js";
import { EMPTY_PANEL, ListItem, panelWidgetProperties, SCHEDULE_ORIGIN_PREFIX, SCHEDULE_WIDGET_ID, type PanelState, type Widget, type WidgetInput } from "./protocol/panel.js";
import { ARTIFACT_REF, artifactName, type AssetItem } from "./protocol/send.js";
import type { Environment } from "./host/types.js";
import { defineSendCard, type CardContribution } from "./send/tool.js";
import { archiveRefresh, keepMonitoredSpace } from "./space/doc.js";

export const PanelDoc = defineDoc<PanelState>({
  kind: STORED_DOC_KINDS.panel,
  version: 1,
  scope: "session",
  checkpointWhen: () => false,
  initial: () => ({ order: [], widgets: {} }),
});

export const AssetsDoc = defineDoc<{ items: AssetItem[] }>({
  kind: STORED_DOC_KINDS.assets,
  version: 1,
  scope: "session",
  checkpointWhen: () => false,
  initial: () => ({ items: [] }),
});

export async function checkItem(harness: Harness, id: string, index: number, done: boolean): Promise<void> {
  await harness.commit(async (tx) => {
    const body = (await tx.doc(PanelDoc)).widgets[id]?.body;
    const item = body?.kind === "list" ? body.items[index] : undefined;
    if (item?.done === undefined) throw new Error("这个条目不能勾选");
    item.done = done;
  }, BACKGROUND_CONTEXT);
}

export async function scheduleOfferRevision(read: Pick<DocumentReader, "snapshot">, context: Context): Promise<number | undefined> {
  const panel = await read.snapshot(PanelDoc, context);
  if (panel?.widgets[SCHEDULE_WIDGET_ID]?.body.kind === "schedules") return;
  return panel?.scheduleRevision ?? 1;
}

export function panelOfferProblem(id: string): string | undefined {
  if (id === SCHEDULE_WIDGET_ID) return "Use widget { kind: panel, panel: { body: { kind: schedules } } } to send the Schedule Overview.";
}

const ChecklistWidgetInput = Type.Object({
  ...panelWidgetProperties,
  body: Type.Object({
    kind: Type.Literal("list"),
    items: Type.Array(Type.Object({ ...ListItem.properties, done: Type.Boolean() }), { minItems: 1, maxItems: 8 }),
  }, { description: "A Checklist. Every item must have a done boolean so the user can check it off on Panel." }),
});

export const checklistSend: CardContribution = defineSendCard({
  schema: Type.Object({ kind: Type.Literal("panel"), panel: ChecklistWidgetInput }),
  preamble: ["For items the user wants to check off over time, offer a Checklist."],
  instructions: [
    "Offer a Checklist when the user wants items they can check off over time. Use kind panel with body { kind: list, items } and a done boolean on every item. Use size m for up to three short items and l for up to eight.",
  ],
  prepare(card) {
    const error = panelOfferProblem(card.panel.id);
    return error === undefined ? { card } : { error };
  },
});

const MAX_PANEL_WIDGETS = 24;

const arranged = <T>(current: readonly T[], ids: readonly string[], keyOf: (item: T) => string): T[] => {
  const rank = new Map(ids.map((id, index) => [id, index]));
  return current.map((item, index) => ({ item, index })).sort((a, b) => (rank.get(keyOf(a.item)) ?? ids.length + a.index) - (rank.get(keyOf(b.item)) ?? ids.length + b.index)).map(({ item }) => item);
};

export async function orderCards(harness: Harness, ids: readonly string[]): Promise<void> {
  await harness.commit(async (tx) => {
    const assets = await tx.doc(AssetsDoc);
    assets.items = arranged(assets.items, ids, (item) => item.origin);
  }, BACKGROUND_CONTEXT);
}

export async function keepWidget(harness: Harness, entries: readonly EntryRecord[], origin: string, keep: boolean, requestId?: string, env: Environment = {}): Promise<void> {
  if (!keep) {
    await harness.commit(async (tx) => {
      const panel = await tx.doc(PanelDoc);
      const dropped = panel.order.filter((id) => panel.widgets[id]?.origin === origin);
      panel.order = panel.order.filter((id) => !dropped.includes(id));
      for (const id of dropped) {
        if (["space", "web"].includes(panel.widgets[id]?.body.kind ?? "")) await archiveRefresh(tx, id);
        rememberSpace(panel, panel.widgets[id]);
        delete panel.widgets[id];
      }
      const assets = await tx.doc(AssetsDoc);
      assets.items = assets.items.filter((item) => item.origin !== origin);
    }, BACKGROUND_CONTEXT);
    return;
  }
  const offers = deliveredSentIn(entries);
  const card = offers.find((offer) => offer.id === origin)?.input.widget;
  if (card === undefined) throw new Error("这张卡片已不在对话里");
  await harness.commit(async (tx) => {
    if (card.kind === "asset") {
      const assets = await tx.doc(AssetsDoc);
      if (assets.items.some((item) => item.origin === origin)) return;
      const name = artifactName(card.ref);
      const kept = { origin, ref: card.ref, title: card.title, ...(card.summary !== undefined && { summary: card.summary }), savedAt: Date.now() };
      assets.items = [kept, ...assets.items.filter((item) => name === undefined || artifactName(item.ref) !== name)];
      return;
    }
    const panel = await tx.doc(PanelDoc);
    const id = card.panel.id;
    if (id === SCHEDULE_WIDGET_ID && card.panel.body.kind === "schedules" && requestId !== undefined) {
      acceptSchedule(panel, card.panel, origin, requestId, Date.now());
      if (panel.widgets[id]?.origin !== origin) return;
      addToOrder(panel, id);
      return;
    }
    if (id === SCHEDULE_WIDGET_ID || card.panel.body.kind === "schedules") throw new Error("无效的定时任务卡片");
    const isSpace = ["space", "web"].includes(card.panel.body.kind);
    if (isSpace) {
      const accepted = panel.spaceReceipts?.[origin] !== undefined && panel.widgets[id] !== undefined;
      acceptSpace(panel, card.panel, origin, offers, Date.now());
      if (!accepted && card.panel.body.kind === "space" && card.panel.body.monitor !== undefined) {
        await keepMonitoredSpace(tx, id, card.panel.body.monitor, env);
      }
    } else if (["space", "web"].includes(panel.widgets[id]?.body.kind ?? "")) {
      throw new Error("不能将 Space 替换为其他组件，请使用新的 ID");
    }
    addToOrder(panel, id);
    if (!isSpace) panel.widgets[id] = { ...card.panel, updatedAt: Date.now(), origin };
  }, BACKGROUND_CONTEXT);
}

function addToOrder(panel: PanelState, id: string): void {
  if (panel.order.includes(id)) return;
  const active = panel.order.filter((entry) => {
    const body = panel.widgets[entry]?.body;
    return !(body?.kind === "list" && body.items.length > 0 && body.items.every((item) => item.done === true));
  });
  if (active.length >= MAX_PANEL_WIDGETS) throw new Error("视图已满，先移除一个组件");
  panel.order.push(id);
}

function acceptSchedule(panel: PanelState, widget: WidgetInput, origin: string, requestId: string, now: number): void {
  const previous = panel.widgets[widget.id];
  const receipt = panel.scheduleReceipts?.[origin];
  if (receipt?.requestIds.includes(requestId)) return;
  if (widget.id !== SCHEDULE_WIDGET_ID || widget.body.kind !== "schedules" ||
      (origin.startsWith(SCHEDULE_ORIGIN_PREFIX) && widget.body.revision !== panel.scheduleRevision)) {
    throw new Error("这张预览已有新版，请使用最新卡片");
  }
  if (previous !== undefined && previous.body.kind !== "schedules") throw new Error("不能将其他组件替换为定时任务视图");
  const alreadyKept = previous?.origin === origin;
  if (previous !== undefined && !alreadyKept) throw new Error("定时任务已在视图中");
  panel.scheduleReceipts ??= {};
  panel.scheduleReceipts[origin] = {
    action: alreadyKept && receipt !== undefined ? receipt.action : "add",
    requestIds: [...(receipt?.requestIds ?? []), requestId],
  };
  if (!alreadyKept) panel.widgets[widget.id] = { ...widget, body: { ...widget.body, rows: [] }, updatedAt: now, origin };
}

type SpaceBody = Extract<WidgetInput["body"], { kind: "space" }>;

const spaceBody = (widget: WidgetInput | undefined): SpaceBody | undefined =>
  widget !== undefined && ["space", "web"].includes(widget.body.kind) ? widget.body as SpaceBody : undefined;

function spaceVersion(widget: WidgetInput | undefined): number | undefined {
  const body = spaceBody(widget);
  if (widget === undefined || body === undefined) return undefined;
  const src = body.src;
  if (spaceRefProblem(widget.id, src) !== undefined) return undefined;
  const match = ARTIFACT_REF.exec(src);
  return match === null ? undefined : Number(match[2]);
}

// Keep a durable receipt even when a legacy Space is removed. This prevents old
// chat cards from becoming a rollback path once the panel entry is gone.
export function rememberSpace(panel: PanelState, widget: Widget | undefined): void {
  const version = spaceVersion(widget);
  if (widget?.origin === undefined || version === undefined) return;
  panel.spaceReceipts ??= {};
  const refresh = spaceBody(widget)?.refresh;
  panel.spaceReceipts[widget.origin] ??= { id: widget.id, version, action: "add", ...(refresh !== undefined ? { refresh } : {}) };
}

export function acceptSpace(panel: PanelState, widget: WidgetInput, origin: string, offers: readonly Sent[], now: number): void {
  const version = spaceVersion(widget);
  const body = spaceBody(widget);
  if (version === undefined || body === undefined) throw new Error("Space 版本无效，请重新生成预览");
  const previewProblem = spacePreviewProblem(widget.id, body.preview);
  if (previewProblem !== undefined) throw new Error(previewProblem);
  const previous = panel.widgets[widget.id];
  const receipts = Object.values(panel.spaceReceipts ?? {}).filter((receipt) => receipt.id === widget.id);
  // Early Spaces used spaces/<id>.html. Migrating that exact namespace starts
  // a new index.html version sequence, while retaining widget identity/state.
  const previousBody = spaceBody(previous);
  const legacyPath = previousBody !== undefined && ARTIFACT_REF.exec(previousBody.src)?.[1] === `spaces/${widget.id}.html`;
  if (previous !== undefined && spaceVersion(previous) === undefined && !legacyPath) throw new Error("不能将其他组件替换为 Space，请使用新的 ID");
  // A retry after a successful acceptance must never replace a subsequent revision.
  if (previous !== undefined && panel.spaceReceipts?.[origin] !== undefined) return;
  const latest = offers.reduce<{ origin: string; version: number } | undefined>((latest, offer) => {
    const card = offer.input.widget;
    if (card?.kind !== "panel" || card.panel.id !== widget.id) return latest;
    const offered = spaceVersion(card.panel);
    return offered !== undefined && (latest === undefined || offered >= latest.version) ? { origin: offer.id, version: offered } : latest;
  }, undefined);
  const accepted = Math.max(spaceVersion(previous) ?? 0, ...receipts.map((receipt) => receipt.version));
  if (latest?.origin !== origin || version < accepted || (previous !== undefined && version <= accepted)) {
    throw new Error("这张预览已有新版，请使用最新卡片");
  }
  rememberSpace(panel, previous);
  const refresh = spaceBody(previous)?.refresh ?? receipts.sort((a, b) => b.version - a.version)[0]?.refresh;
  const updatedBody: SpaceBody = { ...body, kind: "space", ...(body.refresh === undefined && refresh !== undefined ? { refresh } : {}) };
  panel.widgets[widget.id] = {
    ...widget, body: updatedBody,
    origin, updatedAt: now,
  };
  panel.spaceReceipts ??= {};
  panel.spaceReceipts[origin] = {
    id: widget.id, version, action: previous === undefined ? "add" : "update",
    ...(updatedBody.refresh !== undefined ? { refresh: updatedBody.refresh } : {}),
  };
}

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

const PanelSection = section("panel", async (input, context) => {
  const state = await input.read.snapshot(PanelDoc, context);
  const rows = (state?.order ?? []).flatMap((id) => {
    const widget = state?.widgets[id];
    return widget && !["space", "web"].includes(widget.body.kind) ? ["- " + id + ": " + widget.title + " (" + widget.body.kind + ", updated " + new Date(widget.updatedAt).toISOString().slice(0, 16) + "Z)"] : [];
  });
  return rows.length === 0 ? undefined : rows.join("\n");
});

export const createPanelExtension = () =>
  defineExtension({
    name: STORED_EXTENSION_NAMES.panel,
    tools: [createPanelTool()],
    sections: [PanelSection],
  });
