import { onServerEvent } from "./live";
import type { RouletteColor } from "../shared/game.js";

// The shared roulette round, as last pushed by the server.

export interface RouletteBet {
  color: RouletteColor;
  user: string;
  name: string;
  stake: number;
}
export interface RouletteState {
  round: number;
  phase: "betting" | "spinning" | "result";
  /** When betting closes (betting) or when the spin started (spinning / result). */
  spinAt: number;
  number: number | null;
  stop: number | null;
  bets: RouletteBet[];
  history: number[];
}

let state: RouletteState | null = null;
const listeners = new Set<(s: RouletteState) => void>();

export const rouletteState = () => state;
export function onRoulette(fn: (s: RouletteState) => void) {
  listeners.add(fn);
  return () => void listeners.delete(fn);
}

onServerEvent<RouletteState>("roulette", (s) => {
  state = s;
  listeners.forEach((fn) => fn(s));
});
