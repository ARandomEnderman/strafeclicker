import { onServerEvent } from "./live";

// The shared bot race, as last pushed by the server.

export interface RaceState {
  round: number;
  phase: "betting" | "racing" | "result";
  /** When betting closes (betting) or when the race started (racing / result). */
  startAt: number;
  odds: number[];
  chances: number[];
  winner: number | null;
  /** Each bot's finish time (ms) and progress checkpoints, once the race is on. */
  race: { finish: number[]; paths: number[][] } | null;
  bets: { bot: number; user: string; name: string; stake: number }[];
  history: { winner: number; odds: number }[];
}

let state: RaceState | null = null;
const listeners = new Set<(s: RaceState) => void>();
export const raceState = () => state;
export function onRace(fn: (s: RaceState) => void) {
  listeners.add(fn);
  return () => void listeners.delete(fn);
}
onServerEvent<RaceState>("race", (s) => {
  state = s;
  listeners.forEach((fn) => fn(s));
});
