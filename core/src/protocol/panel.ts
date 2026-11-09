import { Type, type Static } from "typebox";

const enumOf = <T extends string>(values: readonly T[], description?: string) =>
  Type.Unsafe<T>({ type: "string", enum: [...values], ...(description && { description }) });

const Tone = enumOf(["neutral", "good", "warn", "bad", "accent"] as const, "Semantic color; the client picks the actual color");

const Stat = Type.Object({
  kind: Type.Literal("stat"),
  value: Type.Union([Type.Number(), Type.String()]),
  unit: Type.Optional(Type.String()),
  at: Type.Optional(Type.Number({ description: "Epoch ms; the client renders a live countdown instead of value" })),
  delta: Type.Optional(Type.Object({ text: Type.String(), tone: Tone })),
  spark: Type.Optional(Type.Array(Type.Number(), { maxItems: 60 })),
});

const Gauge = Type.Object({
  kind: Type.Literal("gauge"),
  items: Type.Array(Type.Object({ label: Type.String(), value: Type.Number(), max: Type.Number(), tone: Type.Optional(Tone) }), { minItems: 1, maxItems: 3 }),
});

const Chart = Type.Object({
  kind: Type.Literal("chart"),
  mark: enumOf(["line", "bar"] as const),
  x: Type.Array(Type.String(), { maxItems: 60 }),
  series: Type.Array(Type.Object({ name: Type.String(), values: Type.Array(Type.Number()), tone: Type.Optional(Tone) }), { minItems: 1, maxItems: 3 }),
});

const List = Type.Object({
  kind: Type.Literal("list"),
  items: Type.Array(
    Type.Object({
      title: Type.String(),
      subtitle: Type.Optional(Type.String()),
      value: Type.Optional(Type.String()),
      tone: Type.Optional(Tone),
      done: Type.Optional(Type.Boolean({ description: "Present makes the item a checklist entry" })),
    }),
    { maxItems: 12 },
  ),
});

const Timeline = Type.Object({
  kind: Type.Literal("timeline"),
  events: Type.Array(
    Type.Object({ at: Type.Number({ description: "Epoch ms" }), end: Type.Optional(Type.Number()), title: Type.String(), detail: Type.Optional(Type.String()), tone: Type.Optional(Tone) }),
    { maxItems: 12 },
  ),
});

const Note = Type.Object({ kind: Type.Literal("note"), markdown: Type.String() });

const Media = Type.Object({
  kind: Type.Literal("media"),
  src: Type.String({ description: "https URL or artifact://name@version" }),
  caption: Type.Optional(Type.String()),
});

const Space = Type.Object({
  kind: Type.Literal("space"),
  src: Type.String({ description: "artifact://spaces/<widget id>/index.html@version of the page; the widget id is the page's saved-state key" }),
  summary: Type.Optional(Type.String({ description: "One line on what the space shows, displayed on its card" })),
  refresh: Type.Optional(
    enumOf(
      ["manual", "open", "daily"] as const,
      "When the app re-fetches the data the page loads. manual (default): the user refreshes by hand, otherwise cached data is shown. open: every time the user opens the space full screen. daily: the first time each local calendar day the user opens it",
    ),
  ),
});

const Actions = Type.Object({
  kind: Type.Literal("actions"),
  buttons: Type.Array(Type.Object({ label: Type.String(), icon: Type.Optional(Type.String()), prompt: Type.String({ description: "Sent to you as a chat message when tapped" }) }), {
    minItems: 1,
    maxItems: 4,
  }),
});

export const WidgetInput = Type.Object({
  id: Type.String({ description: "Stable kebab-case id; the user's panel keeps one widget per id" }),
  size: enumOf(["s", "m", "l"] as const, "s = 1x1, m = 2x1, l = 2x2"),
  title: Type.String(),
  icon: Type.Optional(Type.String({ description: "SF Symbol name, e.g. figure.run" })),
  tone: Type.Optional(Tone),
  ask: Type.Optional(Type.String({ description: "Follow-up question sent to you when the widget is tapped" })),
  body: Type.Union([Stat, Gauge, Chart, List, Timeline, Note, Media, Space, Actions]),
});

export type WidgetInput = Static<typeof WidgetInput>;
export type Widget = WidgetInput & { updatedAt: number; origin?: string };
export type PanelState = { order: string[]; widgets: Record<string, Widget> };

export const EMPTY_PANEL: PanelState = { order: [], widgets: {} };
