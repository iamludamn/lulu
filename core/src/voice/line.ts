export type ToolCall = { callId: string; name: string; arguments: string };
export type ToolResult = { output: string; quiet?: boolean; hangup?: boolean };
export type Update = { key: string; text: string; progress: boolean };
export type Notice = { kind: "landed" | "overheard"; key: string; text: string; at: string };
export type Cut = { heardMs: number; heardText: string; reported: string[] };
export type LineSettings = { instructions: string; tools: readonly unknown[]; voice: string };

export interface Writer {
  compose(updates: readonly Update[]): Promise<string>;
}

export interface LineEvents {
  ready(): void;
  caller(text: string): void;
  agent(text: string): void;
  tools(calls: ToolCall[]): Promise<ToolResult[]>;
  cut(cut: Cut): void;
  failed(message: string): void;
  closed(): void;
}

export interface AudioSink {
  play(pcm: Uint8Array): void;
  flush(): void;
}

export interface Line {
  start(): Promise<void>;
  listen(pcm: Uint8Array): void;
  mute(): void;
  unmute(): void;
  say(text: string): void;
  report(updates: Update[]): void;
  note(notices: Notice[]): void;
  close(): Promise<void>;
}
