import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Harness } from "@earendil-works/pi-durable";
import { PanelDoc } from "../panel/doc.js";
import { artifactName } from "../protocol/send.js";
import { AssetsDoc } from "./doc.js";
import { sentOf } from "./sent.js";

const MAX_PANEL_WIDGETS = 24;

type Entries = readonly { id?: unknown; kind?: unknown; model?: unknown }[];

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

export async function keepWidget(harness: Harness, entries: Entries, origin: string, keep: boolean): Promise<void> {
  if (!keep) {
    await harness.commit(async (tx) => {
      const panel = await tx.doc(PanelDoc);
      const dropped = panel.order.filter((id) => panel.widgets[id]?.origin === origin);
      panel.order = panel.order.filter((id) => !dropped.includes(id));
      for (const id of dropped) delete panel.widgets[id];
      const assets = await tx.doc(AssetsDoc);
      assets.items = assets.items.filter((item) => item.origin !== origin);
    }, BACKGROUND_CONTEXT);
    return;
  }
  const card = sentOf(entries, origin)?.input.widget;
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
    if (!panel.order.includes(id)) {
      if (panel.order.length >= MAX_PANEL_WIDGETS) throw new Error("视图已满，先移除一个组件");
      panel.order.push(id);
    }
    panel.widgets[id] = { ...card.panel, updatedAt: Date.now(), origin };
  }, BACKGROUND_CONTEXT);
}
