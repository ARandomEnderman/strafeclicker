import { onServerEvent } from "./live";
import { friendsAction } from "./state";

// Your friends and pending requests. Fetched once, then kept fresh by the server's
// "friends" events whenever someone adds, accepts or removes you.

export interface FriendLists {
  friends: { user: string; online: boolean }[];
  incoming: { user: string; online: boolean }[];
  outgoing: { user: string; online: boolean }[];
}

let lists: FriendLists = { friends: [], incoming: [], outgoing: [] };
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((fn) => fn());

export const friendLists = () => lists;
export function onFriends(fn: () => void) {
  listeners.add(fn);
  return () => void listeners.delete(fn);
}

export async function loadFriends() {
  set(await friendsAction("list"));
}
export function set(l: FriendLists) {
  lists = { friends: l.friends, incoming: l.incoming, outgoing: l.outgoing };
  emit();
}

onServerEvent<FriendLists>("friends", set);
