import { onServerEvent } from "./live";
import { getState } from "./state";
import { flashScreen } from "./ui/flash";

// The global flashbang round, as last pushed by the server. Kept outside the page so
// every tab follows it: anyone watching the flashbang page, and anyone who was still
// riding the round wherever they are on the site, gets flashed at the pop.

export interface FbBet {
  user: string;
  stake: number;
  status: "queued" | "open" | "won" | "lost";
  mult: number | null;
  payout: number;
}
export interface FbState {
  round: number;
  phase: "waiting" | "running";
  startAt: number | null;
  nextAt: number | null;
  last: { round: number; crash: number; bets: FbBet[] } | null;
  bets: FbBet[];
  next: FbBet[];
  history: number[];
}

let state: FbState | null = null;
const listeners = new Set<(s: FbState, popped: boolean) => void>();
let watching = false;

export const fbState = () => state;
export const setWatchingFlashbang = (on: boolean) => (watching = on);

/** Called on every update; `popped` is true for the update that ends a round. */
export function onFlashbang(fn: (s: FbState, popped: boolean) => void) {
  listeners.add(fn);
  return () => void listeners.delete(fn);
}

onServerEvent<FbState>("fb", (s) => {
  const prev = state;
  state = s;
  const popped = !!prev && prev.phase === "running" && s.phase === "waiting" && s.last?.round === prev.round;
  if (popped) {
    const me = getState()?.username;
    const wasRiding = s.last!.bets.some((b) => b.user === me && b.status === "lost");
    if (watching || wasRiding) flashScreen();
  }
  listeners.forEach((fn) => fn(s, popped));
});
