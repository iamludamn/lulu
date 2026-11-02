export const FRAME_MS = 20;
export const FRAME_BYTES = 640;
const MAX_LAG_MS = 60;
const MAX_BACKLOG_FRAMES = 10;

const SILENCE = new Uint8Array(FRAME_BYTES);

export type Paced = { frame: Uint8Array; wait: number };

export class Pacer {
  #pending = new Uint8Array(0);
  #due = 0;

  push(pcm: Uint8Array): void {
    const merged = new Uint8Array(this.#pending.length + pcm.length);
    merged.set(this.#pending);
    merged.set(pcm, this.#pending.length);
    const limit = MAX_BACKLOG_FRAMES * FRAME_BYTES;
    this.#pending = merged.length > limit ? merged.slice(merged.length - limit) : merged;
  }

  reset(now: number): void {
    this.#pending = new Uint8Array(0);
    this.#due = now;
  }

  next(now: number): Paced {
    if (now - this.#due > MAX_LAG_MS) {
      this.#pending = new Uint8Array(0);
      this.#due = now;
    }
    let frame = SILENCE;
    if (this.#pending.length > 0) {
      frame = new Uint8Array(FRAME_BYTES);
      frame.set(this.#pending.subarray(0, FRAME_BYTES));
      this.#pending = this.#pending.slice(Math.min(FRAME_BYTES, this.#pending.length));
    }
    this.#due += FRAME_MS;
    return { frame, wait: Math.max(0, this.#due - now) };
  }
}
