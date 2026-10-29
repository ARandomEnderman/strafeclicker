import { onServerEvent } from "./live";

// Custom avatars: username -> { c: background colour, s: up to three symbols }, for every
// player who changed theirs, pushed by the server whenever someone does.

export interface Look {
  c: string | null;
  s: string | null;
}
let looks: Record<string, Look> = {};
const listeners = new Set<() => void>();
export const lookOf = (user: string): Look | null => looks[user] ?? null;
export function onLooks(fn: () => void) {
  listeners.add(fn);
  return () => void listeners.delete(fn);
}
onServerEvent<Record<string, Look>>("looks", (l) => {
  looks = l;
  listeners.forEach((fn) => fn());
});
