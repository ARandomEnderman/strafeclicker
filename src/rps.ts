import { onServerEvent } from "./live";

// Rock paper scissors duels you can see (filtered by the server), as last pushed.

export type Hand = "rock" | "paper" | "scissors";
export interface RpsPlayer {
  user: string;
  name: string;
  bot: boolean;
}
export interface RpsDuel {
  id: number;
  status: "waiting" | "playing" | "done";
  phase: "picking" | "reveal" | null;
  /** When picking (or the reveal) ends. */
  deadline: number | null;
  visibility: "public" | "friends" | "private";
  code: string | null;
  stake: number;
  creator: RpsPlayer;
  joiner: RpsPlayer | null;
  /** Your seat (0 creator, 1 joiner), or null when watching. */
  seat: 0 | 1 | null;
  /** In an open round the other side's pick is null; `picked` says who has picked. */
  rounds: { picks: (Hand | null)[]; picked: boolean[]; winner: 0 | 1 | null }[];
  score: [number, number];
  winner: 0 | 1 | null;
  createdAt: number;
}

let list: RpsDuel[] = [];
const listeners = new Set<() => void>();
export const rpsDuels = () => list;
export const rpsById = (id: number) => list.find((d) => d.id === id);
export function onRps(fn: () => void) {
  listeners.add(fn);
  return () => void listeners.delete(fn);
}
onServerEvent<RpsDuel[]>("rps", (l) => {
  list = l;
  listeners.forEach((fn) => fn());
});
