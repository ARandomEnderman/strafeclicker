import { onServerEvent } from "./live";

// Coinflips you can see (filtered by the server), as last pushed.

export interface FlipItem {
  uid: string;
  itemId: string;
  phase: string | null;
  wear: string | null;
  stattrak: boolean;
  value: number;
}
export interface FlipPlayer {
  user: string;
  name: string;
  bot: boolean;
  /** What they put up (a bot puts up cash, so no items). */
  value: number;
  items: FlipItem[];
}
export interface Flip {
  id: number;
  status: "waiting" | "flipping" | "done";
  visibility: "public" | "friends" | "private";
  /** Join code, only for the players in it. */
  code: string | null;
  creator: FlipPlayer;
  joiner: FlipPlayer | null;
  /** The creator's side. */
  side: "t" | "ct";
  /** The creator's stake, and the value range a joiner must put up. */
  value: number;
  range: [number, number];
  createdAt: number;
  startAt: number | null;
  result: "t" | "ct" | null;
  winner: "creator" | "joiner" | null;
}

let list: Flip[] = [];
const listeners = new Set<() => void>();
export const flips = () => list;
export const flipById = (id: number) => list.find((f) => f.id === id);
export function onFlips(fn: () => void) {
  listeners.add(fn);
  return () => void listeners.delete(fn);
}
onServerEvent<Flip[]>("flips", (l) => {
  list = l;
  listeners.forEach((fn) => fn());
});
