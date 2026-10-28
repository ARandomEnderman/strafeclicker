import { onServerEvent } from "./live";

// Bracket tournaments you can see (filtered by the server), as last pushed.

export type BracketGame = "coinflip" | "highcard" | "rps" | "unbox";
export interface BracketCard {
  r: string;
  s: "s" | "h" | "d" | "c";
}
export interface BracketMatch {
  /** Seats in `players`. */
  a: number;
  b: number;
  status: "pending" | "playing" | "done";
  winner: number | null;
  result: {
    side?: "t" | "ct";
    cards?: [BracketCard, BracketCard];
    drops?: { itemId: string; phase: string | null; wear: string | null; stattrak: boolean }[];
    values?: number[];
  } | null;
  /** When a coinflip / high card / unbox match starts playing on screen. */
  startAt: number | null;
  rps: {
    score: [number, number];
    phase: "picking" | "reveal" | null;
    deadline: number;
    rounds: { picks: (string | null)[]; picked: boolean[]; winner: 0 | 1 | null }[];
  } | null;
}
export interface Bracket {
  id: number;
  status: "waiting" | "running" | "done";
  size: number;
  fee: number;
  pot: number;
  stages: { game: BracketGame; caseId?: string; caseName?: string }[];
  visibility: "public" | "friends" | "private";
  code: string | null;
  mine: boolean;
  seat: number | null;
  players: { user: string | null; name: string; bot: boolean }[];
  rounds: BracketMatch[][];
  champion: number | null;
  createdAt: number;
}

let list: Bracket[] = [];
const listeners = new Set<() => void>();
export const brackets = () => list;
export const bracketById = (id: number) => list.find((b) => b.id === id);
export function onBrackets(fn: () => void) {
  listeners.add(fn);
  return () => void listeners.delete(fn);
}
onServerEvent<Bracket[]>("brackets", (l) => {
  list = l;
  listeners.forEach((fn) => fn());
});
