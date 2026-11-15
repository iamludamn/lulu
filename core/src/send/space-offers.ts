import type { PanelState, Widget, WidgetInput } from "../protocol/panel.js";
import { ARTIFACT_REF } from "../protocol/send.js";
import { spaceRefProblem, spacePreviewProblem } from "../artifact/space.js";
import type { Sent } from "./sent.js";

type SpaceBody = Extract<WidgetInput["body"], { kind: "space" }>;

const spaceBody = (widget: WidgetInput | undefined): SpaceBody | undefined =>
  widget !== undefined && ["space", "web"].includes(widget.body.kind) ? widget.body as SpaceBody : undefined;

export function spaceVersion(widget: WidgetInput | undefined): number | undefined {
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
  if (previous !== undefined && spaceVersion(previous) === undefined) throw new Error("不能将其他组件替换为 Space，请使用新的 ID");
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
