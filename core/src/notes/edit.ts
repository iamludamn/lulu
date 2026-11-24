import { Type, type Static } from "typebox";
import { Value } from "typebox/value";
import { NoteContent } from "./store.js";

export const NoteEdit = Type.Object({
  title: Type.Optional(Type.String({ maxLength: 512 })),
  edits: Type.Optional(Type.Array(Type.Object({
    id: Type.String(),
    text: Type.Optional(Type.String({ maxLength: 48000 })),
    done: Type.Optional(Type.Boolean()),
  }), { maxItems: 250 })),
  append: Type.Optional(Type.String({ maxLength: 48000 })),
});
type NoteEdit = Static<typeof NoteEdit>;

export function editNote(note: NoteContent, input: NoteEdit): NoteContent {
  const edits = new Map(input.edits?.map((edit) => [edit.id, edit]));
  if ([...edits.values()].some((edit) => !note.blocks.some((block) =>
    block.id === edit.id && (block.kind === "check" || (block.kind === "text" && edit.done === undefined))))) {
    throw new Error("Each edit must reference an existing text or checklist block.");
  }
  const blocks = note.blocks.map((block) => {
    const edit = edits.get(block.id);
    if (!edit || block.kind === "file") return block;
    const text = edit.text ?? block.text;
    return block.kind === "check" ? { ...block, text, done: edit.done ?? block.done } : { ...block, text };
  });
  if (input.append) blocks.push({ id: crypto.randomUUID(), kind: "text", text: input.append });
  const content = { title: input.title ?? note.title, blocks, ...(note.source === undefined ? {} : { source: note.source }) };
  if (!Value.Check(NoteContent, content) || JSON.stringify(content).length > 120000) {
    throw new Error("The edited note exceeds its storage limits.");
  }
  return content;
}
