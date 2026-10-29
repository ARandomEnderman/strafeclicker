import { onServerEvent } from "./live";

// The global chat as the server last pushed it.

export interface ChatMessage {
  id: number;
  kind: "msg" | "rain" | "pay" | "system";
  user: string | null;
  name: string | null;
  text: string;
  at: number;
  admin: boolean;
  /** "clan" for your clan's channel. */
  channel: "global" | "clan";
  /** rain and pay */
  amount?: number;
  /** rain: how many caught it, how big it was (0–5), your share (null: you weren't online) */
  count?: number;
  level?: number;
  yours?: number | null;
  mine?: boolean;
  /** An admin event: paid by the house, not the rainer. */
  house?: boolean;
  /** pay */
  toUser?: string;
  toName?: string;
  fromMe?: boolean;
  /** msg: display names of the players it @mentions, by lowercase username. */
  mentions?: Record<string, string>;
}

let messages: ChatMessage[] = [];
const listeners = new Set<(added: ChatMessage | null) => void>();
export const chatMessages = () => messages;
/** fn(message) for each live message, fn(null) when the whole list changed. */
export function onChat(fn: (added: ChatMessage | null) => void) {
  listeners.add(fn);
  return () => void listeners.delete(fn);
}
const emit = (m: ChatMessage | null) => listeners.forEach((fn) => fn(m));

onServerEvent<ChatMessage[]>("chat", (list) => {
  messages = list;
  emit(null);
});
onServerEvent<ChatMessage | null>("chatmsg", (m) => {
  if (!m || messages.some((x) => x.id === m.id)) return;
  messages = [...messages.slice(-149), m];
  emit(m);
});
onServerEvent<{ id: number }>("chatdel", ({ id }) => {
  messages = messages.filter((m) => m.id !== id);
  emit(null);
});
