import type { Tx } from "@earendil-works/pi-durable";
import { DelegateIndex, RunFamily } from "./runs.js";

export const MAX_CONCURRENT_DELEGATES = 5;
export const REQUEST_TIMEOUT_MS = 15 * 60_000;

export class DelegateCapacityError extends Error {
  constructor() { super("At most 5 child tasks can run concurrently; wait for a result before spawning or resuming another."); }
}

export async function reserveDelegate(tx: Tx, except: string): Promise<void> {
  const index = await tx.doc(DelegateIndex);
  let active = 0;
  for (const id of index.ids) {
    if (id === except) continue;
    const run = await tx.doc(RunFamily, id, { id, task: "", description: "", origin: [], agent: "", cwd: "" });
    if (run.status === "running") active++;
  }
  if (active >= MAX_CONCURRENT_DELEGATES) throw new DelegateCapacityError();
}
