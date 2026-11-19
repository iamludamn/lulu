import { archiveRefresh } from "../space/doc.js";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { EntryRecord, Harness } from "@earendil-works/pi-durable";
import { PanelDoc } from "../panel/doc.js";
import { artifactName } from "../protocol/send.js";
import { AssetsDoc } from "./doc.js";
import { deliveredSentIn } from "./sent.js";
import { acceptSpace, rememberSpace } from "./space-offers.js";
import { acceptSchedule } from "./schedule-offers.js";
import { SCHEDULE_WIDGET_ID } from "../protocol/panel.js";

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

export async function keepWidget(harness: Harness, entries: readonly EntryRecord[], origin: string, keep: boolean, requestId?: string): Promise<void> {
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
      addToOrder(panel.order, id);
      return;
    }
    if (id === SCHEDULE_WIDGET_ID || card.panel.body.kind === "schedules") throw new Error("无效的定时任务卡片");
    const isSpace = ["space", "web"].includes(card.panel.body.kind);
    if (isSpace) {
      acceptSpace(panel, card.panel, origin, offers, Date.now());
    } else if (["space", "web"].includes(panel.widgets[id]?.body.kind ?? "")) {
      throw new Error("不能将 Space 替换为其他组件，请使用新的 ID");
    }
    addToOrder(panel.order, id);
    if (!isSpace) panel.widgets[id] = { ...card.panel, updatedAt: Date.now(), origin };
  }, BACKGROUND_CONTEXT);
}

function addToOrder(order: string[], id: string): void {
  if (order.includes(id)) return;
  if (order.length >= MAX_PANEL_WIDGETS) throw new Error("视图已满，先移除一个组件");
  order.push(id);
}
