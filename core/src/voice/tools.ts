export const MAX_REQUEST_CHARACTERS = 4000;

export const TOOLS = [
  {
    type: "function",
    name: "send_task",
    description:
      "Send a job that needs their computer, files, web, browser, or mail and chat they send. That call is a receipt, never the answer, and never the quick path. Call this for the job. Do not announce that you started. The receipt earns nothing out loud. The outcome lands later as a work_landed entry. Do not use this for a take, a recap of this call, a quiz from words already on the line, or a fact already on the line. If the useful answer needs a fact you do not have about their world, use it. Say nothing about calling this.",
    parameters: {
      type: "object",
      properties: {
        request: {
          type: "string",
          description:
            "The job itself: what to do or find out, and what to come back with. Not the caller's sentence. Add their exact words only where the wording itself is part of the job.",
        },
      },
      required: ["request"],
    },
  },
  {
    type: "function",
    name: "recall_text_messages",
    description:
      "Read the written chat between you and this caller: \"you\" is what you sent them, \"them\" is what they typed to you. Nobody else writes in it. Use it when they ask what either of you wrote. It is this bot's typed chat only, not Slack or mail, and it never holds anything said on this call: do not use it for those, send_task covers the rest. It takes no arguments and returns the latest messages only.",
    parameters: { type: "object", properties: {} },
  },
  {
    type: "function",
    name: "stay_silent",
    description:
      "Say nothing this turn. Use it only when the last thing that landed is a work_landed or work_overheard entry and speaking would give them nothing new. Never when they just talked to you, and never on the same turn as spoken words. It makes no sound; after it, say nothing at all.",
    parameters: { type: "object", properties: {} },
  },
  {
    type: "function",
    name: "end_the_call",
    description:
      "Hang up and end this call. Use it when the caller says goodbye, asks you to hang up, or the conversation is plainly finished. ALWAYS say your goodbye out loud first, including when hanging up is the last step of something else they asked for: the line drops the moment you call this, so nothing after it is heard. Never call it while they are still asking for something.",
    parameters: { type: "object", properties: {} },
  },
] as const;
