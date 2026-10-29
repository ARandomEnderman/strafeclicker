import { onServerEvent } from "./live";

// The blackjack table this player sits (or watches), as last pushed by the server.

export interface BjCard {
  r: string;
  s: "s" | "h" | "d" | "c";
}
export interface BjSeat {
  user: string;
  name: string;
  stake: number;
  cards: BjCard[];
  total: number | null;
  soft: boolean;
  status: "betting" | "playing" | "stood" | "bust" | "blackjack";
  doubled: boolean;
  result: "blackjack" | "win" | "push" | "lose" | null;
  payout: number;
}
export interface BjTable {
  id: number;
  round: number;
  phase: "idle" | "betting" | "playing" | "dealer" | "result";
  deadline: number | null;
  /** The hole card is null until the dealer turns it. */
  dealer: (BjCard | null)[];
  dealerTotal: number | null;
  seats: BjSeat[];
  /** Bets placed during this hand, playing the next one. */
  waiting?: { user: string; name: string; stake: number }[];
}
export interface BjState {
  tables: number;
  seated?: boolean;
  /** You've bet and play the next hand at this table. */
  queued?: boolean;
  table: BjTable | null;
}

let state: BjState | null = null;
const listeners = new Set<(s: BjState) => void>();
export const bjState = () => state;
export function onBlackjack(fn: (s: BjState) => void) {
  listeners.add(fn);
  return () => void listeners.delete(fn);
}
onServerEvent<BjState>("bj", (s) => {
  state = s;
  listeners.forEach((fn) => fn(s));
});
