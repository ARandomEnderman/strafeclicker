// Achievements, named as one word plus a Roman numeral per tier. Checked by the server after every action (and shown by the browser
// with the same progress maths). Each pays a one-off cash reward when unlocked.
//
// `goal(s)` gets { stats, perks, balance, inventoryValue } (the account view plus the
// inventory's current market value) and returns [progress, target].

import { PERKS } from "./game.js";

const g = (s, game) => s.stats.games?.[game] ?? {};
const maxedBranches = (s) => Object.keys(PERKS).filter((id) => (s.perks[id] ?? 0) >= PERKS[id].levels.length - 1).length;

export const ACHIEVEMENTS = [
  { id: "click-1", name: "Clicker I", desc: "Click the clicker.", icon: "clicker", reward: 0.1, goal: (s) => [s.stats.clicks, 1] },
  { id: "click-1k", name: "Clicker II", desc: "Click 1,000 times.", icon: "clicker", reward: 1, goal: (s) => [s.stats.clicks, 1000] },
  { id: "click-10k", name: "Clicker III", desc: "Click 10,000 times.", icon: "clicker", reward: 5, goal: (s) => [s.stats.clicks, 10_000] },
  { id: "click-100k", name: "Clicker IV", desc: "Click 100,000 times.", icon: "clicker", reward: 25, goal: (s) => [s.stats.clicks, 100_000] },
  { id: "open-1", name: "Unboxer I", desc: "Open a case or capsule.", icon: "cases", reward: 0.25, goal: (s) => [s.stats.opened, 1] },
  { id: "open-100", name: "Unboxer II", desc: "Open 100 cases or capsules.", icon: "cases", reward: 5, goal: (s) => [s.stats.opened, 100] },
  { id: "open-1000", name: "Unboxer III", desc: "Open 1,000 cases or capsules.", icon: "cases", reward: 25, goal: (s) => [s.stats.opened, 1000] },
  { id: "covert", name: "Collector I", desc: "Unbox a Covert (or Extraordinary) item.", icon: "gem", reward: 2, goal: (s) => [s.stats.tiers?.covert ?? 0, 1] },
  { id: "gold", name: "Collector II", desc: "Unbox a knife or gloves.", icon: "crown", reward: 10, goal: (s) => [s.stats.tiers?.gold ?? 0, 1] },
  { id: "best-100", usd: true, name: "Jackpot I", desc: "Get an item worth $100 or more.", icon: "star", reward: 5, goal: (s) => [Math.min(s.stats.best?.value ?? 0, 100), 100] },
  { id: "best-1000", usd: true, name: "Jackpot II", desc: "Get an item worth $1,000 or more.", icon: "star", reward: 25, goal: (s) => [Math.min(s.stats.best?.value ?? 0, 1000), 1000] },
  { id: "upgrade-1", name: "Upgrader I", desc: "Win an upgrade.", icon: "upgrader", reward: 0.5, goal: (s) => [s.stats.upgradesWon, 1] },
  { id: "upgrade-25", name: "Upgrader II", desc: "Win 25 upgrades.", icon: "upgrader", reward: 5, goal: (s) => [s.stats.upgradesWon, 25] },
  { id: "plinko-100", name: "Plinko I", desc: "Drop 100 plinko balls.", icon: "plinko", reward: 1, goal: (s) => [g(s, "plinko").played ?? 0, 100] },
  { id: "plinko-big", name: "Plinko II", desc: "Hit 100x or more in plinko.", icon: "plinko", reward: 5, goal: (s) => [Math.min(g(s, "plinko").bestMult ?? 0, 100), 100] },
  { id: "flash-10", name: "Flashbang I", desc: "Cash out a flashbang at 10x or more.", icon: "flashbang", reward: 5, goal: (s) => [Math.min(g(s, "flashbang").bestMult ?? 0, 10), 10] },
  { id: "bhop-10", name: "Hopper I", desc: "Make 10 jumps in one b-hop run.", icon: "bhop", reward: 5, goal: (s) => [Math.min(g(s, "bhop").bestJumps ?? 0, 10), 10] },
  { id: "battle-1", name: "Gladiator I", desc: "Win a case battle.", icon: "battles", reward: 2, goal: (s) => [g(s, "battle").won ?? 0, 1] },
  { id: "perk-max", name: "Maxed I", desc: "Max out one upgrade branch.", icon: "upgrades", reward: 5, goal: (s) => [Math.min(maxedBranches(s), 1), 1] },
  { id: "perk-all", name: "Maxed II", desc: "Max out every upgrade branch.", icon: "upgrades", reward: 50, goal: (s) => [maxedBranches(s), Object.keys(PERKS).length] },
  { id: "rich-1k", usd: true, name: "Tycoon I", desc: "Be worth $1,000 (balance plus inventory).", icon: "coins", reward: 10, goal: (s) => [Math.min(s.balance + s.inventoryValue, 1000), 1000] },
  { id: "rich-10k", usd: true, name: "Tycoon II", desc: "Be worth $10,000 (balance plus inventory).", icon: "coins", reward: 50, goal: (s) => [Math.min(s.balance + s.inventoryValue, 10_000), 10_000] },
  { id: "offline", name: "Sleeper I", desc: "Earn offline income.", icon: "offlineIncome", reward: 0.25, goal: (s) => [(s.stats.offlineEarned ?? 0) > 0 ? 1 : 0, 1] },
];

/** Ids of achievements whose goal is met but aren't in `unlocked` yet. */
export function newlyMet(s, unlocked) {
  return ACHIEVEMENTS.filter((a) => !unlocked[a.id] && (([have, need]) => have >= need)(a.goal(s))).map((a) => a.id);
}
