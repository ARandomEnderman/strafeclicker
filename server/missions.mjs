// Daily missions: three random tasks per UTC day (one easy, one medium, one hard),
// kept in the account's stats. Progress comes from the same events the leaderboards
// see (Game#track); rewards are claimed by hand, like achievements.

export const dayKey = (t = Date.now()) => new Date(t).toISOString().slice(0, 10);
export const nextMidnight = (t = Date.now()) => {
  const d = new Date(t);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1);
};

const NAMES = {
  plinko: "Plinko",
  roulette: "Roulette",
  blackjack: "Blackjack",
  poker: "Video poker",
  bombplant: "Bomb plant",
  towers: "Towers",
  defuse: "Defuse",
  bhop: "B-hop",
  flashbang: "Flashbang",
  race: "Bot race",
  coinflip: "Coinflip",
  battle: "Case battles",
  upgrade: "the Upgrader",
};

/**
 * Each kind lists [target, reward cents] per difficulty (easy, medium, hard); a null
 * entry means that kind doesn't come in that difficulty.
 */
const KINDS = [
  { kind: "cases", tiers: [[5, 100], [15, 250], [40, 500]], label: (m) => `Open ${m.target} cases` },
  { kind: "clicks", tiers: [[300, 100], [1000, 250], [2500, 500]], label: (m) => `Click ${m.target.toLocaleString("en-US")} times on the clicker` },
  { kind: "wager", tiers: [[2500, 100], [10000, 250], [30000, 500]], label: (m) => `Wager ${usd(m.target)} in total`, money: true },
  ...["plinko", "roulette", "blackjack", "poker", "towers", "defuse", "bhop", "flashbang", "race", "bombplant"].map((game) => ({
    kind: `play:${game}`,
    game,
    tiers: [[5, 100], [12, 250], [25, 500]],
    label: (m) => `Play ${m.target} rounds of ${NAMES[game]}`,
  })),
  { kind: "win:blackjack", game: "blackjack", tiers: [[2, 100], [5, 250], [10, 500]], label: (m) => `Win ${m.target} hands of Blackjack` },
  { kind: "win:coinflip", game: "coinflip", tiers: [[1, 100], [3, 250], null], label: (m) => (m.target === 1 ? "Win a coinflip" : `Win ${m.target} coinflips`) },
  { kind: "win:battle", game: "battle", tiers: [null, [1, 250], [3, 500]], label: (m) => (m.target === 1 ? "Win a case battle" : `Win ${m.target} case battles`) },
  { kind: "win:upgrade", game: "upgrade", tiers: [[1, 100], [3, 250], null], label: (m) => (m.target === 1 ? "Win an upgrade" : `Win ${m.target} upgrades`) },
  ...[
    ["towers", 5],
    ["bhop", 5],
    ["defuse", 5],
    ["flashbang", 3],
    ["plinko", 3],
  ].map(([game, mult]) => ({
    kind: `mult:${game}`,
    game,
    mult,
    tiers: [null, [1, 250], [3, 500]],
    label: (m) => `Win ${mult}x or more in ${NAMES[game]}${m.target > 1 ? ` ${m.target} times` : ""}`,
  })),
];
const BY_KIND = Object.fromEntries(KINDS.map((k) => [k.kind, k]));
const usd = (c) => `$${(c / 100).toLocaleString("en-US", { maximumFractionDigits: 2 })}`;

function generate(day) {
  const used = new Set();
  const list = [];
  for (let tier = 0; tier < 3; tier++) {
    // A family (cases, play, win, ...) first, so there aren't three "play" missions
    // just because there are many games; then a kind within it. Families don't repeat.
    const pool = KINDS.filter((k) => k.tiers[tier] && !used.has(k.kind.split(":")[0]));
    const families = [...new Set(pool.map((k) => k.kind.split(":")[0]))];
    const family = families[Math.floor(Math.random() * families.length)];
    const options = pool.filter((k) => k.kind.split(":")[0] === family);
    const k = options[Math.floor(Math.random() * options.length)];
    used.add(family);
    const [target, reward] = k.tiers[tier];
    list.push({ id: `${day}:${tier}`, kind: k.kind, tier, target, reward, progress: 0, claimed: false });
  }
  return { day, list };
}

/** Make sure the account has today's missions. */
export function ensureMissions(a) {
  const day = dayKey();
  if (a.stats.missions?.day !== day) a.stats.missions = generate(day);
}

/**
 * Count one event towards today's missions.
 * @param {{ type: "game" | "cases" | "clicks", game?: string, n?: number, stakeCents?: number, payoutCents?: number }} ev
 */
export function trackMissions(a, ev) {
  for (const m of a.stats.missions?.list ?? []) {
    if (m.progress >= m.target) continue;
    const k = BY_KIND[m.kind];
    // A mission for a game that has been removed (keno, RPS duels) completes by itself.
    if (!k) {
      m.progress = m.target;
      continue;
    }
    let add = 0;
    if (m.kind === "cases" && ev.type === "cases") add = ev.n;
    else if (m.kind === "clicks" && ev.type === "clicks") add = ev.n;
    else if (m.kind === "wager") add = ev.stakeCents ?? 0;
    else if (ev.type === "game" && ev.game === k.game) {
      if (m.kind.startsWith("play:")) add = 1;
      else if (m.kind.startsWith("win:")) add = ev.payoutCents > ev.stakeCents ? 1 : 0;
      else if (m.kind.startsWith("mult:")) add = ev.stakeCents > 0 && ev.payoutCents / ev.stakeCents >= k.mult ? 1 : 0;
    }
    m.progress = Math.min(m.target, m.progress + add);
  }
}

/** Claim one finished mission (or all, id null). Returns the reward in cents. */
export function claimMissions(a, id) {
  let total = 0;
  for (const m of a.stats.missions?.list ?? []) {
    if (m.claimed || m.progress < m.target || (id != null && m.id !== id)) continue;
    m.claimed = true;
    total += m.reward;
  }
  return total;
}

/** What the browser sees. */
export function missionsView(missions) {
  return {
    resetsAt: nextMidnight(),
    list: (missions?.list ?? []).map((m) => {
      const k = BY_KIND[m.kind];
      const money = !!k?.money;
      return {
        id: m.id,
        tier: m.tier,
        label: k ? k.label(m) : "Bonus: a game from this mission was removed, so it's yours",
        progress: money ? m.progress / 100 : m.progress,
        target: money ? m.target / 100 : m.target,
        money,
        reward: m.reward / 100,
        done: m.progress >= m.target,
        claimed: m.claimed,
      };
    }),
  };
}
