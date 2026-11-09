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
  "WebView limits. No alert, confirm, prompt or window.open. Links open in the system browser. Nothing persists between openings, so keep state in memory. A plain asset page does not keep anything between openings and should not load anything from the network: inline CSS, JS, SVG and images (data: URIs). A page that must show live data from a public API or remember what the user does is a space: read the `space` skill and do not build it as a plain asset. No downloads.",
  "",
  "A starting point, to use or ignore:",
  "body { margin: 0; padding: 20px 16px 24px; font: 16px/1.6 var(--lulu-font, -apple-system, system-ui, sans-serif); color: var(--lulu-fg, #1c1c1e); }",
  ".card { background: var(--lulu-card, rgba(255,255,255,.72)); border: 1px solid var(--lulu-line, rgba(60,60,67,.18)); border-radius: var(--lulu-radius, 16px); padding: 16px; }",
  ".muted { color: var(--lulu-muted, rgba(60,60,67,.6)); }",
  "button { min-height: 44px; padding: 0 18px; border: 0; border-radius: 12px; background: var(--lulu-accent, #007aff); color: #fff; font: inherit; }",
].join("\n");

const SPACE = [
  "A space is a self-contained .html page the user keeps on their panel. It opens full screen in the lulu app and is built exactly like an html-asset page (read that skill first for theme and phone rules). Two things differ: it can fetch live data, and it can save the user's state.",
  "",
  "Live data. Call public https JSON APIs with fetch(). The page runs with a null origin, so the API must answer with Access-Control-Allow-Origin: * (GitHub's REST API and ESPN's public scoreboard do). Check before you write the page: in the sandbox run `curl -sI -H 'Origin: null' <url>` and look for that header, then `curl -s <url>` to see the real fields. Build the page from what came back, never from memory. If an API refuses curl or lacks the header, choose another source or tell the user plainly; do not ship a page that cannot load. Never put a key or token in the page: the file is readable. Only GET works, and anonymous APIs rate-limit, so fetch once on open and on a refresh button, never on a timer.",
  "",
  "Every data page shows a loading state, a failure state with the reason and a retry button, an empty state, and the time the data was fetched.",
  "",
  "Saved state. `await lulu.state.get()` returns the saved object, or null the first time. `await lulu.state.set(obj)` saves a JSON-serializable object of up to 256 KiB and rejects on failure. Save when the user changes something, not on every keystroke. The state lives in the artifact `spaces/<widget id>/state.json`, so you can read what the user checked or wrote with `mcp__artifact__read`, but never write it yourself while the user may have the page open. Keep state a plain object, and let the page tolerate older shapes: a new page version reads the state the old one saved. `lulu` exists only when the page is opened from the panel.",
  "",
  "Offering it. Save the page with a name like `spaces/nba-schedule.html`, then send a short type text, then one type widget kind panel card whose body is { kind: web, src: <artifact ref> }. Choose a stable kebab-case widget id: it is also the key of the saved state, so never reuse it for a different page. To change a space the user already keeps, edit the artifact and call the panel tool update with the same id and the new ref.",
].join("\n");

export const SKILLS: Record<string, Skill> = {
  "html-asset": {
    description: "How to write an .html artifact that fits the lulu app: theme variables, phone WebView limits and an optional starting stylesheet. Use before writing any .html artifact.",
    body: HTML_ASSET,
  },
  space: {
    description: "How to build a space: an .html page kept on the user's panel that fetches live data from public APIs and saves the user's state. Use before writing a page that shows live data or remembers anything.",
    body: SPACE,
  },
};
