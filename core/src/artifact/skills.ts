export interface Skill {
  readonly description: string;
  readonly body: string;
}

const HTML_ASSET = [
  "The page opens in the lulu iOS app, inside a WKWebView on a phone, over the user's wallpaper. Design it freely: layout, typography, motion, charts and illustration are yours to decide. Only the points below are fixed.",
  "",
  "Theme. The app sets these CSS variables on the root element and switches them between light and dark by itself: --lulu-fg, --lulu-muted, --lulu-card, --lulu-line, --lulu-accent, --lulu-good, --lulu-warn, --lulu-bad, --lulu-radius, --lulu-font, --lulu-mono. Build your palette from them so the page belongs to the app in both modes: use them directly, or derive tints and gradients with color-mix(). Give each one a fallback as the second argument, for example var(--lulu-fg, #1c1c1e). Do not redefine them, do not branch on prefers-color-scheme, and leave the body background transparent: the app paints a frosted layer behind the page. Colors outside the palette are fine when the content needs them (a map, a brand, a chart with many series), as long as text stays readable in both modes.",
  "",
  "Phone. Design for a 390pt wide portrait screen used with one hand, and let it flex wider. No horizontal scroll. The app already pads the page for the home indicator, so do not add that yourself. Body text 16px or larger, touch targets 44px or larger, nothing that needs hover. Native controls such as range sliders may ignore accent-color, so when their look matters, style them yourself or build your own.",
  "",
  "WebView limits. No alert, confirm, prompt or window.open. Links open in the system browser. Nothing persists between openings, so keep state in memory. A page whose job is to remember things (a tracker, a log, saved notes) cannot work here: build it around the data you have now, and say plainly in your report that it does not keep changes. The page cannot call any server and should not load anything from the network: inline CSS, JS, SVG and images (data: URIs). No downloads.",
  "",
  "A starting point, to use or ignore:",
  "body { margin: 0; padding: 20px 16px 24px; font: 16px/1.6 var(--lulu-font, -apple-system, system-ui, sans-serif); color: var(--lulu-fg, #1c1c1e); }",
  ".card { background: var(--lulu-card, rgba(255,255,255,.72)); border: 1px solid var(--lulu-line, rgba(60,60,67,.18)); border-radius: var(--lulu-radius, 16px); padding: 16px; }",
  ".muted { color: var(--lulu-muted, rgba(60,60,67,.6)); }",
  "button { min-height: 44px; padding: 0 18px; border: 0; border-radius: 12px; background: var(--lulu-accent, #007aff); color: #fff; font: inherit; }",
].join("\n");

export const SKILLS: Record<string, Skill> = {
  "html-asset": {
    description: "How to write an .html artifact that fits the lulu app: theme variables, phone WebView limits and an optional starting stylesheet. Use before writing any .html artifact.",
    body: HTML_ASSET,
  },
};
