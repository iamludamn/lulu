import { Type, type Static } from "typebox";
import { ChecklistWidgetInput, WidgetInput } from "./panel.js";

export const SEND_TOOL = "send_to_user";

export const ARTIFACT_REF = /^artifact:\/\/(.+)@(\d+)$/;

export const artifactName = (ref: string): string | undefined => ARTIFACT_REF.exec(ref)?.[1];

const WidgetCard = Type.Object({
  kind: Type.Literal("panel"),
  panel: WidgetInput,
});

const AssetCard = Type.Object({
  kind: Type.Literal("asset"),
  ref: Type.String({ description: "artifact://name@version of an artifact you already saved" }),
  title: Type.String(),
  summary: Type.Optional(Type.String({ description: "One line on what the file holds" })),
});

const ScheduleOverviewRequest = Type.Object({
  kind: WidgetCard.properties.kind,
  panel: Type.Object({
    body: Type.Object({ kind: Type.Literal("schedules") }, { additionalProperties: false }),
  }, { additionalProperties: false, description: "A Schedule Overview filled from the saved jobs by the server" }),
});
export type ScheduleOverviewRequest = Static<typeof ScheduleOverviewRequest>;

export const SendInput = Type.Object({
  type: Type.Union([Type.Literal("text"), Type.Literal("widget")]),
  content: Type.Optional(Type.String({ description: "Message for type text only; never on type widget. Markdown renders; use real line breaks between paragraphs" })),
  body: Type.Optional(Type.String({ description: "Full Markdown for type text when the reply is long: the user sees content as a short bubble and taps it to read body" })),
  widget: Type.Optional(Type.Union([WidgetCard, AssetCard], { description: "Card for type widget: a Widget for Panel or an Asset for Assets" })),
  end_turn: Type.Optional(Type.Boolean({ description: "true on your final send when the reply is complete; omit for acknowledgements and progress updates" })),
});

export const ModelSendInput = Type.Object({
  ...SendInput.properties,
  widget: Type.Optional(Type.Union([Type.Object({ ...WidgetCard.properties, panel: ChecklistWidgetInput }), ScheduleOverviewRequest, AssetCard], { description: "Card for type widget: a Widget for Panel or an Asset for Assets" })),
});

export type SendInput = Static<typeof SendInput>;
export type ModelSendInput = Static<typeof ModelSendInput>;
export function isScheduleOverviewRequest(card: SendCard | ScheduleOverviewRequest | undefined): card is ScheduleOverviewRequest {
  return card?.kind === "panel" && card.panel?.body?.kind === "schedules";
}

export type SendCard = NonNullable<SendInput["widget"]>;
export type SendDetails = { type: string; end: boolean; requestIds?: string[]; widget?: SendCard };

export type AssetItem = { origin: string; ref: string; title: string; summary?: string; savedAt: number };
