import { defineTask } from "@earendil-works/pi-durable";

export interface AnchorInput {
  runId: string;
}

export const DelegateAnchor = defineTask<AnchorInput, { phase: "hold" }, { runId: string }, object>({
  name: "pistack.delegate.anchor",
  version: 1,
  initial: () => ({ phase: "hold" }),
  phases: {
    hold: async (task, runtime, context) => {
      await runtime.commit(() => ({ status: "terminal", outcome: { status: "completed", result: { runId: task.input.runId } } }), context);
    },
  },
  abort: async () => undefined,
});
