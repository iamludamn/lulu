import { defineTask } from "@earendil-works/pi-durable";
import { RENAMED_TASKS } from "../durable-names.js";

export interface AnchorInput {
  runId: string;
}

export const DelegateAnchor = defineTask<AnchorInput, { phase: "hold" }, { runId: string }, object>({
  name: RENAMED_TASKS.delegateAnchor.current,
  version: 1,
  initial: () => ({ phase: "hold" }),
  phases: {
    hold: async (task, runtime, context) => {
      await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: { runId: task.input.runId } } }), context);
    },
  },
  abort: async () => undefined,
});
