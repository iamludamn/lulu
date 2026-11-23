import { Type, type Static } from "typebox";
import { ARTIFACT_REF } from "../protocol/send.js";

export const NOTE_ID = /^[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$/;
const id = Type.String({ pattern: NOTE_ID.source });
const text = Type.String({ maxLength: 48000 });
const block = Type.Union([
  Type.Object({ id, kind: Type.Literal("text"), text }),
  Type.Object({ id, kind: Type.Literal("check"), text, done: Type.Boolean() }),
  Type.Object({ id, kind: Type.Literal("file"), ref: Type.String({ maxLength: 2048, pattern: ARTIFACT_REF.source }) }),
]);

export const NoteContent = Type.Object({
  title: Type.String({ maxLength: 512 }),
  blocks: Type.Array(block, { maxItems: 250 }),
  source: Type.Optional(Type.String({ maxLength: 256 })),
});
export type NoteContent = Static<typeof NoteContent>;
export type NoteRevision = NoteContent & { id: string; revision: number; updatedAt: number };
export type NoteRef = Pick<NoteRevision, "id" | "revision">;
export const NoteMutation = Type.Object({
  id, requestId: id, baseRevision: Type.Integer({ minimum: 0 }), content: NoteContent,
});
export type NoteMutation = Static<typeof NoteMutation>;
export type NoteCursor = { updatedAt: number; id: string };
export interface NotesStore {
  list(cursor?: NoteCursor): Promise<{ notes: NoteRevision[]; pinned: string[]; next?: NoteCursor }>;
  read(ref: NoteRef): Promise<NoteRevision | undefined>;
  write(mutation: NoteMutation): Promise<NoteRevision | undefined>;
  pin(key: string, pinned: boolean): Promise<void>;
}
