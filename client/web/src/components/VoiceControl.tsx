import { useEffect, useRef, useState } from "react";
import type { BotStore } from "../session/store";

const MIC_RATE = 16000;
const FRAME_SAMPLES = 320;
const PLAY_RATE = 24000;

type Session = {
  stream: MediaStream;
  context: AudioContext;
  processor: ScriptProcessorNode;
  playback: AudioContext;
  queued: AudioBufferSourceNode[];
  nextAt: number;
};

const toBase64 = (bytes: Uint8Array): string => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
};

const fromBase64 = (text: string): Uint8Array => Uint8Array.from(atob(text), (char) => char.charCodeAt(0));

function encodeFrames(input: Float32Array, inputRate: number, pending: number[], send: (frame: Uint8Array) => void): void {
  const step = inputRate / MIC_RATE;
  for (let position = 0; position < input.length - 1; position += step) {
    const index = Math.floor(position);
    const fraction = position - index;
    const sample = input[index] * (1 - fraction) + input[index + 1] * fraction;
    pending.push(Math.max(-1, Math.min(1, sample)) * 0x7fff);
  }
  while (pending.length >= FRAME_SAMPLES) {
    const chunk = pending.splice(0, FRAME_SAMPLES);
    const frame = new Uint8Array(FRAME_SAMPLES * 2);
    const view = new DataView(frame.buffer);
    chunk.forEach((value, index) => view.setInt16(index * 2, Math.round(value), true));
    send(frame);
  }
}

export function VoiceControl({ store, enabled }: { store: BotStore; enabled: boolean }) {
  const [active, setActive] = useState(false);
  const [status, setStatus] = useState("");
  const [heard, setHeard] = useState("");
  const [notice, setNotice] = useState("");
  const [muted, setMuted] = useState(false);
  const mutedRef = useRef(false);
  const session = useRef<Session | undefined>(undefined);

  const stop = () => {
    const current = session.current;
    session.current = undefined;
    if (current !== undefined) {
      current.processor.disconnect();
      for (const track of current.stream.getTracks()) track.stop();
      void current.context.close();
      for (const node of current.queued) node.stop();
      void current.playback.close();
    }
    mutedRef.current = false;
    setMuted(false);
    setActive(false);
    setStatus("");
    store.stopVoice();
  };

  const toggleMute = () => {
    mutedRef.current = !mutedRef.current;
    setMuted(mutedRef.current);
    store.muteVoice(mutedRef.current);
  };

  const play = (current: Session, base64: string) => {
    const samples = new Int16Array(fromBase64(base64).buffer);
    const buffer = current.playback.createBuffer(1, samples.length, PLAY_RATE);
    const channel = buffer.getChannelData(0);
    for (let index = 0; index < samples.length; index++) channel[index] = samples[index] / 0x8000;
    const node = current.playback.createBufferSource();
    node.buffer = buffer;
    node.connect(current.playback.destination);
    const startAt = Math.max(current.playback.currentTime, current.nextAt);
    node.start(startAt);
    current.nextAt = startAt + buffer.duration;
    current.queued.push(node);
    node.onended = () => {
      current.queued = current.queued.filter((item) => item !== node);
    };
  };

  const interrupt = () => {
    const current = session.current;
    if (current === undefined) return;
    for (const node of current.queued) node.stop();
    current.queued = [];
    current.nextAt = 0;
  };

  useEffect(() => {
    return store.onVoice((event) => {
      const current = session.current;
      const type = String(event.type);
      if (type === "voice.state") {
        if (event.state === "ready") setStatus("在听");
        if (event.state === "closed") {
          if (typeof event.reason === "string" && event.reason !== "") setNotice(event.reason);
          stop();
        }
      } else if (type === "response.output_audio.delta" && current !== undefined) {
        play(current, String(event.delta));
      } else if (type === "voice.flush") {
        interrupt();
      } else if (type === "conversation.item.input_audio_transcription.completed") {
        setHeard(String(event.transcript ?? event.text ?? ""));
      } else if (type === "error") {
        setStatus(`语音出错：${JSON.stringify(event.error ?? event)}`);
      }
    });
  }, [store]);

  const start = async () => {
    setHeard("");
    setNotice("");
    setStatus("连接中");
    setActive(true);
    store.startVoice();
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
      const context = new AudioContext();
      const source = context.createMediaStreamSource(stream);
      const processor = context.createScriptProcessor(4096, 1, 1);
      const playback = new AudioContext();
      const current: Session = { stream, context, processor, playback, queued: [], nextAt: 0 };
      session.current = current;
      const pending: number[] = [];
      processor.onaudioprocess = (event) => {
        if (mutedRef.current) return;
        encodeFrames(event.inputBuffer.getChannelData(0), context.sampleRate, pending, (frame) => store.sendVoiceAudio(toBase64(frame)));
      };
      source.connect(processor);
      processor.connect(context.destination);
    } catch (failure) {
      setStatus(failure instanceof Error ? failure.message : "无法使用麦克风");
      store.stopVoice();
      session.current = undefined;
      setActive(false);
    }
  };

  useEffect(() => () => stop(), []);

  if (!enabled) return null;
  if (!active) {
    return (
      <>
        {notice !== "" && (
          <span className="voice-heard muted" title={notice}>
            {notice}
          </span>
        )}
        <button type="button" className="voice" onClick={() => void start()}>
          语音
        </button>
      </>
    );
  }
  return (
    <div className="voice-live" role="status">
      <span className="voice-status">
        <span className={muted ? "dot" : "dot running"} aria-hidden="true" />
        {muted ? "已静音" : status}
      </span>
      {heard !== "" && (
        <span className="voice-heard muted" title={heard}>
          你说：{heard}
        </span>
      )}
      <button type="button" className="voice" onClick={toggleMute}>
        {muted ? "取消静音" : "静音"}
      </button>
      <button type="button" className="stop" onClick={stop}>
        结束
      </button>
    </div>
  );
}
