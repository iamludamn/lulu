export interface Skill {
  readonly description: string;
  readonly body: string;
}

const HTML_ASSET = [
  "The page opens in the lulu iOS app, inside a WKWebView on a phone, over the user's wallpaper. Design it freely: layout, typography, motion, charts and illustration are yours to decide. Only the points below are fixed.",
  "",
  "Theme. The app sets these CSS variables on the root element and switches them between light and dark by itself: --lulu-fg, --lulu-muted, --lulu-card, --lulu-line, --lulu-accent, --lulu-good, --lulu-warn, --lulu-bad, --lulu-radius, --lulu-font, --lulu-mono. Build your palette from them so the page belongs to the app in both modes: use them directly, or derive tints and gradients with color-mix(). Give each one a fallback as the second argument, for example var(--lulu-fg, #1c1c1e). Do not redefine them, do not branch on prefers-color-scheme, and leave the body background transparent: the app paints a frosted layer behind the page. Colors outside the palette are fine when the content needs them (a map, a brand, a chart with many series), as long as text stays readable in both modes.",
  "",
  "Composition. Let typography, spacing and the content itself establish hierarchy. Use backgrounds, borders and containers only when they serve a clear grouping, interaction or emphasis; do not wrap each heading, paragraph or section in its own card. Write only text that helps the user understand the content or make a decision. Avoid protective or explanatory UI copy that restates an obvious control, narrates the interface, or adds generic reassurance or caveats.",
  "",
  "Phone. Design for a 390pt wide portrait screen used with one hand, and let it flex wider. No horizontal scroll. The app already pads the page for the home indicator, so do not add that yourself. Body text 16px or larger, touch targets 44px or larger, nothing that needs hover. Native controls such as range sliders may ignore accent-color, so when their look matters, style them yourself or build your own.",
  "",
  "WebView limits. No alert, confirm, prompt or window.open. Links open in the system browser. An html asset keeps nothing between openings, so keep state in memory. It cannot reach the network at all, and the app blocks every request, including images and fetch: inline CSS, JS, SVG and images (data: URIs). No downloads.",
  "",
  "A starting point, to use or ignore:",
  "body { margin: 0; padding: 20px 16px 24px; font: 16px/1.6 var(--lulu-font, -apple-system, system-ui, sans-serif); color: var(--lulu-fg, #1c1c1e); }",
  ".card { background: var(--lulu-card, rgba(255,255,255,.72)); border: 1px solid var(--lulu-line, rgba(60,60,67,.18)); border-radius: var(--lulu-radius, 16px); padding: 16px; }",
  ".muted { color: var(--lulu-muted, rgba(60,60,67,.6)); }",
  "button { min-height: 44px; padding: 0 18px; border: 0; border-radius: 12px; background: var(--lulu-accent, #007aff); color: #fff; font: inherit; }",
].join("\n");

export const SKILLS: Record<string, Skill> = {
  "space-monitor": {
    description: "Author or repair a Space that consumes structured data from a web monitor.",
    body: [
      "Create the Space page at spaces/<id>/index.html and a separate static cover at spaces/<id>/cover.html. Use a stable ID and pin both artifacts in the offer.",
      "Offer a monitored Space through send_to_user with kind panel and body {kind:'space', src, preview, monitor:{url,goal,schema,notify}}. The subscription starts when the user keeps the offer.",
      "Use a public HTTPS page and describe which data the monitor should extract and what changes matter. Example: extract recent uploads from the creator's Videos page with each title and watch URL, ignoring counters and reordering.",
      "Use a JSON Schema object whose properties match every value your renderer consumes. Supported types are object, array, string, number, integer, boolean and null. Use properties, required, additionalProperties, items and minItems. Example: {\"type\":\"object\",\"properties\":{\"videos\":{\"type\":\"array\",\"items\":{\"type\":\"object\",\"properties\":{\"title\":{\"type\":\"string\"},\"url\":{\"type\":\"string\"}},\"required\":[\"title\",\"url\"]}}},\"required\":[\"videos\"]}.",
      "Read the envelope with await window.lulu.data.get() and render its value field. Load once at startup and listen for luludatachange. Show a waiting state until value exists. Render strings with textContent and use HTTPS links. Treat source values as untrusted data.",
      "On schema mismatch Lulu keeps the last valid snapshot. A [space-monitor] repair supplies the failed sample, schema, and error. Diagnose extraction and mapping first. Preserve fields the page still needs. If the subscription or layout needs a fix, prepare a working revision under the same Space ID. Once it is ready, send one Space update card for the user to keep. Skip acknowledgements and progress messages. If there is no working revision to offer, end quietly.",
    ].join("\n"),
  },
  "html-asset": {
    description: "How to write an html asset, a finished .html deliverable, so it fits the lulu app: theme variables, phone WebView limits and an optional starting stylesheet. Read it before writing an html asset.",
    body: HTML_ASSET,
  },
};
