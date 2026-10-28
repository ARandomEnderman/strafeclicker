import { onServerEvent } from "./live";

// Clan tags: username -> tag for everyone in a clan, pushed by the server whenever a
// clan gains or loses a member.

let tags: Record<string, string> = {};
const listeners = new Set<() => void>();
export const tagOf = (user: string) => tags[user] ?? null;
export function onTags(fn: () => void) {
  listeners.add(fn);
  return () => void listeners.delete(fn);
}
onServerEvent<Record<string, string>>("tags", (t) => {
  tags = t;
  listeners.forEach((fn) => fn());
});
