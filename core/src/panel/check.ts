import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Harness } from "@earendil-works/pi-durable";
import { PanelDoc } from "./doc.js";

export async function checkItem(harness: Harness, id: string, index: number, done: boolean): Promise<void> {
  await harness.commit(async (tx) => {
    const body = (await tx.doc(PanelDoc)).widgets[id]?.body;
    const item = body?.kind === "list" ? body.items[index] : undefined;
    if (item?.done === undefined) throw new Error("这个条目不能勾选");
    item.done = done;
  }, BACKGROUND_CONTEXT);
}
