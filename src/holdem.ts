import { onServerEvent } from "./live";
import { toast } from "./ui/dom";

// Texas Hold'em tables you can see (filtered by the server), as last pushed.

export interface HeCard {
  r: string;
  s: "s" | "h" | "d" | "c";
}
export interface HePlayer {
  user: string;
  name: string;
  bot: boolean;
  chips: number;
  out: boolean;
  /** Finishing place once out (1 for the winner). */
  place: number | null;
  away: boolean;
  /** Chips put in on this street. */
  bet: number;
  inHand: boolean;
  folded: boolean;
  allIn: boolean;
  /** Their last action this hand ("Call 40", "Fold", ...). */
  last: string | null;
  /** Your own cards, or anyone's at a showdown; null face down; [] not in the hand. */
  cards: HeCard[] | null;
  /** Their hand's name at a showdown. */
  hand: string | null;
}
export interface HeGame {
  id: number;
  status: "waiting" | "playing" | "done";
  size: number;
  fee: number;
  prize: number;
  visibility: "public" | "friends" | "private";
  code: string | null;
  creator: string;
  /** You created it. */
  mine: boolean;
  /** Your seat, or null when watching. */
  seat: number | null;
  players: HePlayer[];
  winner: number | null;
  handNo: number;
  button: number;
  log: string[];
  hand: {
    no: number;
    sb: number;
    bb: number;
    nextLevelIn: number | null;
    board: HeCard[];
    street: "preflop" | "flop" | "turn" | "river";
    phase: "betting" | "dealing" | "result";
    pot: number;
    toAct: number;
    deadline: number | null;
    currentBet: number;
    results: { amount: number; winners: number[]; hand: string | null }[] | null;
    /** Only when it's your turn. */
    you: { toCall: number; minRaiseTo: number; maxRaiseTo: number } | null;
  } | null;
  createdAt: number;
}

let list: HeGame[] = [];
const listeners = new Set<() => void>();
export const holdemGames = () => list;
export const holdemById = (id: number) => list.find((g) => g.id === id);
export function onHoldem(fn: () => void) {
  listeners.add(fn);
  return () => void listeners.delete(fn);
}
// Your turn at a table you're not looking at: a toast (once per decision), so nobody
// times out just for being on another page.
const told = new Set<string>();
onServerEvent<HeGame[]>("holdem", (l) => {
  list = l;
  listeners.forEach((fn) => fn());
  for (const g of l) {
    const hd = g.hand;
    if (!hd?.you || location.hash === `#/holdem/${g.id}`) continue;
    const key = `${g.id}:${hd.no}:${hd.street}:${hd.currentBet}`;
    if (told.has(key)) continue;
    told.add(key);
    toast(`Your turn at Hold'em (${g.fee.toLocaleString("en-US", { style: "currency", currency: "USD" })} table). Open Hold'em to play.`, "achievement", 6000);
  }
});
