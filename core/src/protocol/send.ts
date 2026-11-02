import { Type, type Static } from "typebox";
import { WidgetInput } from "./panel.js";

export const SEND_TOOL = "send_to_user";

export const ARTIFACT_REF = /^artifact:\/\/(.+)@(\d+)$/;

export const artifactName = (ref: string): string | undefined => ARTIFACT_REF.exec(ref)?.[1];

const PanelCard = Type.Object({
  kind: Type.Literal("panel"),
  panel: WidgetInput,
});

const AssetCard = Type.Object({
  kind: Type.Literal("asset"),
  ref: Type.String({ description: "artifact://name@version of an artifact you already saved" }),
  title: Type.String(),
  summary: Type.Optional(Type.String({ description: "One line on what the file holds" })),
});

export const SendInput = Type.Object({
  type: Type.Union([Type.Literal("text"), Type.Literal("widget")]),
  content: Type.Optional(Type.String({ description: "Message for type text only; never on type widget. Markdown renders; use real line breaks between paragraphs" })),
  widget: Type.Optional(Type.Union([PanelCard, AssetCard], { description: "Card for type widget" })),
  end_turn: Type.Optional(Type.Boolean({ description: "true on your final send when the reply is complete; omit for acknowledgements and progress updates" })),
});

export type SendInput = Static<typeof SendInput>;
export type SendCard = NonNullable<SendInput["widget"]>;

export type AssetItem = { origin: string; ref: string; title: string; summary?: string; savedAt: number };
