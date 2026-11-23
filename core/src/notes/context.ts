import type { Context } from "@earendil-works/chord/context";
import { defineDocFamily, LiveDoc, type ConversationId, type DocumentReader, type Tx } from "@earendil-works/pi-durable";
import type { NoteRef, NotesStore } from "./store.js";

type Binding = { ref?: NoteRef };
const NoteBindings = defineDocFamily<Binding, Binding>({
  kind: "lulu.note.binding", version: 1, scope: "session", family: true, checkpointWhen: () => false, initial: (input) => input,
});

export async function bindNote(tx: Tx, submission: number, ref: NoteRef): Promise<void> {
  await tx.doc(NoteBindings, String(submission), { ref });
}

export async function inheritNote(tx: Tx, origin: number, submission: number): Promise<void> {
  const { ref } = await tx.doc(NoteBindings, String(origin), {});
  if (ref) await bindNote(tx, submission, ref);
}

export async function attachedNote(read: DocumentReader, conversation: ConversationId, context: Context, store?: NotesStore) {
  if (!store) return;
  const inputs = (await read.snapshot(LiveDoc, conversation, context))?.run?.inputs ?? [];
  const last = inputs.at(-1);
  if (last === undefined) return;
  const ref = (await read.snapshot(NoteBindings, String(last), context))?.ref;
  if (ref) return store.read(ref);
}
