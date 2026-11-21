import { Value } from "typebox/value";
import { NOTE_ID, NoteMutation, type NotesStore } from "./store.js";

export async function noteApi(request: Request, path: string, store: NotesStore | undefined): Promise<Response> {
  const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "private, no-store" } });
  if (!store) return json({ error: "Notes unavailable" }, 503);
  try {
    if (path === "/notes" && request.method === "GET") {
      const params = new URL(request.url).searchParams;
      const id = params.get("id");
      const time = params.get("updatedAt");
      if (id === null && time === null) return json(await store.list());
      const updatedAt = Number(time);
      if (!id || !NOTE_ID.test(id) || time === null || !Number.isSafeInteger(updatedAt) || updatedAt < 0)
        return json({ error: "Invalid notes cursor" }, 400);
      return json(await store.list({ id: id.toLowerCase(), updatedAt }));
    }
    if (request.method !== "PUT") return json({ error: "Method not allowed" }, 405);
    const raw = await request.text();
    if (raw.length > 128000) return json({ error: "Note too large" }, 413);
    const input: unknown = JSON.parse(raw);
    if (path === "/notes/pin") {
      if (!input || typeof input !== "object" || !("key" in input) || !("pinned" in input) ||
          typeof input.key !== "string" || input.key.length > 2048 ||
          (!NOTE_ID.test(input.key) && !input.key.startsWith("asset:")) || typeof input.pinned !== "boolean")
        return json({ error: "Invalid pin" }, 400);
      await store.pin(NOTE_ID.test(input.key) ? input.key.toLowerCase() : input.key, input.pinned);
      return json({ ok: true });
    }
    if (!Value.Check(NoteMutation, input) || new Set(input.content.blocks.map(({ id }) => id.toLowerCase())).size !== input.content.blocks.length)
      return json({ error: "Invalid note" }, 400);
    const revision = await store.write(input);
    return revision ? json(revision) : json({ error: "revision_conflict" }, 409);
  } catch (error) {
    if (error instanceof SyntaxError) return json({ error: "Invalid JSON" }, 400);
    console.error("Notes request failed", error);
    return json({ error: "Notes unavailable" }, 503);
  }
}
