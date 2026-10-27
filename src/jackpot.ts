import { onServerEvent } from "./live";

// The shared jackpot round, as last pushed by the server.

export interface JackpotItem {
  uid: string;
  itemId: string;
  phase: string | null;
  wear: string | null;
  stattrak: boolean;
  value: number;
}
export interface JackpotState {
  round: number;
  phase: "waiting" | "open" | "spinning" | "result";
  endsAt: number | null;
  spinAt: number | null;
  total: number;
  /** In ticket order: the wheel's slices. */
  deposits: { user: string; name: string; value: number }[];
  players: { user: string; name: string; value: number; chance: number; items: JackpotItem[] }[];
  /** The winning ticket (USD position along the pot) and winner, once it spins. */
  ticket: number | null;
  winner: string | null;
  history: { round: number; user: string; name: string; pot: number; chance: number; items: number }[];
}

let state: JackpotState | null = null;
const listeners = new Set<(s: JackpotState) => void>();
export const jackpotState = () => state;
export function onJackpot(fn: (s: JackpotState) => void) {
  listeners.add(fn);
  return () => void listeners.delete(fn);
}
onServerEvent<JackpotState>("jackpot", (s) => {
  state = s;
  listeners.forEach((fn) => fn(s));
});
