import type { BpOutcome } from "../shared/game.js";
import { onServerEvent } from "./live";

// The shared bomb plant round, as last pushed by the server.

export interface BombPlantState {
  round: number;
  phase: "betting" | "running" | "result";
  /** When betting closes (betting) or when the round started playing (running / result). */
  startAt: number;
  outcome: BpOutcome | null;
  bets: { pick: string; user: string; name: string; stake: number }[];
  history: BpOutcome[];
}

let state: BombPlantState | null = null;
const listeners = new Set<(s: BombPlantState) => void>();
export const bombPlantState = () => state;
export function onBombPlant(fn: (s: BombPlantState) => void) {
  listeners.add(fn);
  return () => void listeners.delete(fn);
}
onServerEvent<BombPlantState>("bombplant", (s) => {
  state = s;
  listeners.forEach((fn) => fn(s));
});
