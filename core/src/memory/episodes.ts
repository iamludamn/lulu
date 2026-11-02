import type { Message } from "@earendil-works/pi-ai";
import type { EntryRecord } from "@earendil-works/pi-durable";
import { sentIn, spokenText } from "../send/sent.js";
import type { Episode } from "./doc.js";

const EPISODE_CHARACTERS = 2000;

const textOf = (message: Message | undefined): string => {
  if (message === undefined) return "";
  if (typeof message.content === "string") return message.content;
  return message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("");
};

const episodeOf = (entry: EntryRecord): Episode | undefined => {
  const role = entry.kind === "pi.user" ? "user" : entry.kind === "pi.assistant" ? "assistant" : undefined;
  if (role === undefined) return undefined;
  const text = (role === "assistant" ? spokenText(sentIn([entry])) : textOf(entry.model?.[0]).trim()).slice(0, EPISODE_CHARACTERS);
  return text === "" ? undefined : { id: Number(entry.id), role, text };
};

export function episodesOf(entries: readonly EntryRecord[]): Episode[] {
  return entries.flatMap((entry) => {
    const episode = episodeOf(entry);
    return episode === undefined ? [] : [episode];
  });
}
