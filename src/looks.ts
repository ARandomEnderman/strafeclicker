import { onServerEvent } from "./live";

// Custom looks: username -> { c: avatar colour, s: up to three symbols, b: profile banner,
// which also colours the name }, for every player who changed theirs, pushed by the server
// whenever someone does.

export interface Look {
  c: string | null;
  s: string | null;
  b?: string | null;
}

/** Name colours for the profile banners (the banner's colour, at full strength). */
const BANNER_NAME: Record<string, string> = {
  gold: "#e6b422",
  red: "#ef5b5b",
  purple: "#b47ee8",
  blue: "#5d9de6",
  green: "#3ecf8e",
  pink: "#eb64be",
  teal: "#2cc3cc",
};
/** The colour a player's name shows in, from their banner, or null. */
export const nameColor = (user: string) => BANNER_NAME[looks[user]?.b ?? ""] ?? null;
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
