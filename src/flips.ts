import { onServerEvent } from "./live";

// Coinflips you can see (filtered by the server), as last pushed.

export interface FlipPlayer {
  user: string;
  name: string;
  bot: boolean;
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
  stake: number;
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
