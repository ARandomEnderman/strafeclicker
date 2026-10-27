import { onServerEvent } from "./live";
import type { Drop } from "./types";

// Every open, running and recently finished case battle, as last pushed by the server.

export interface BattleSlot {
  user: string;
  name: string;
  bot: boolean;
}
export interface Battle {
  id: number;
  status: "waiting" | "running" | "done";
  visibility: "public" | "friends" | "private";
  /** Join code; only sent to people in the battle. */
  code: string | null;
  creator: string;
  creatorName: string;
  cases: string[];
  size: number;
  cost: number;
  slots: (BattleSlot | null)[];
  createdAt: number;
  startAt: number | null;
  /** rounds[round][slot] once it has started. */
  rounds: { drop: Drop; value: number; reel?: { ids: string[]; stop: number } }[][] | null;
  totals: number[] | null;
  winner: number | null;
}

let list: Battle[] = [];
const listeners = new Set<() => void>();

export const battles = () => list;
export const battleById = (id: number) => list.find((b) => b.id === id);
export function onBattles(fn: () => void) {
  listeners.add(fn);
  return () => void listeners.delete(fn);
}

onServerEvent<Battle[]>("battles", (b) => {
  list = b;
  listeners.forEach((fn) => fn());
});
