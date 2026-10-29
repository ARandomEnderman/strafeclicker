import { onServerEvent } from "./live";

// Clan tags: username -> tag for everyone in a clan, and each tag's colour, pushed by the
// server whenever a clan gains or loses a member or changes its colour.

let tags: Record<string, string> = {};
let colors: Record<string, string> = {};
const listeners = new Set<() => void>();
export const tagOf = (user: string) => tags[user] ?? null;
/** A tag's colour, or null for the default. */
export const tagColor = (tag: string) => colors[tag] ?? null;
export function onTags(fn: () => void) {
  listeners.add(fn);
  return () => void listeners.delete(fn);
}
onServerEvent<{ users: Record<string, string>; colors: Record<string, string> }>("tags", (t) => {
  tags = t.users ?? {};
  colors = t.colors ?? {};
  listeners.forEach((fn) => fn());
});
