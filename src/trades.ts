import { onServerEvent } from "./live";
import { tradeAction } from "./state";
import type { OwnedItem } from "./types";

// Your open trade offers (both ways) and recent finished ones, kept fresh by the
// server's "trades" events.

export type TradeItem = Pick<OwnedItem, "uid" | "itemId" | "phase" | "float" | "wear" | "stattrak" | "seed"> & { missing?: boolean };
export interface Trade {
  id: number;
  incoming: boolean;
  from: string;
  to: string;
  /** What the sender gives and asks for. */
  give: TradeItem[];
  get: TradeItem[];
  giveCash: number;
  getCash: number;
  status: "open" | "accepted" | "declined" | "cancelled" | "failed";
  createdAt: number;
  updatedAt: number;
}
export interface TradeLists {
  open: Trade[];
  history: Trade[];
}

let lists: TradeLists = { open: [], history: [] };
const listeners = new Set<() => void>();

export const tradeLists = () => lists;
export function onTrades(fn: () => void) {
  listeners.add(fn);
  return () => void listeners.delete(fn);
}
export function setTrades(l: TradeLists) {
  lists = { open: l.open, history: l.history };
  listeners.forEach((fn) => fn());
}
export async function loadTrades() {
  setTrades(await tradeAction<TradeLists>("list"));
}

onServerEvent<TradeLists>("trades", setTrades);
