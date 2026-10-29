// Player profiles: the mini profile card and profile page. Anyone logged in sees the
// public part (name, join date, a few stats); friends (and you) also see whether
// they're online, their balance, inventory value and the inventory itself.

import { ACHIEVEMENTS } from "../shared/achievements.js";
import { GameError } from "./game.mjs";

/** The game played most often (case openings count as "cases"), or null. */
function favourite(s) {
  const counts = Object.entries(s.games ?? {}).map(([g, st]) => [g, st.played ?? 0]);
  counts.push(["cases", s.opened ?? 0]);
  const [game, n] = counts.sort((x, y) => y[1] - x[1])[0];
  return n > 0 ? game : null;
}

export class Profiles {
  /**
   * @param {import("./game.mjs").Game} game
   * @param {import("node:sqlite").DatabaseSync} db
   * @param {import("./friends.mjs").Friends} friends
   * @param {(userId: number) => boolean} isOnline
   */
  constructor(game, db, friends, isOnline) {
    this.game = game;
    this.friends = friends;
    this.isOnline = isOnline;
    this.q = { user: db.prepare("SELECT id FROM users WHERE username = ?") };
  }

  get(viewerId, username) {
    const row = this.q.user.get(String(username ?? "").trim());
    if (!row) throw new GameError("not_found", "No such player", 404);
    const p = this.game.publicAccount(row.id);
    const self = row.id === viewerId;
    const rel = self ? "self" : this.friends.relation(viewerId, row.id);
    const close = self || rel === "friends";
    const s = p.stats;
    const games = s.games ?? {};
    return {
      user: p.user,
      name: p.name,
      joinedAt: p.joinedAt,
      relation: rel,
      stats: {
        opened: s.opened,
        best: s.best,
        battlesWon: games.battle?.won ?? 0,
        achievements: Object.keys(s.achievements ?? {}).length,
        achievementsTotal: ACHIEVEMENTS.length,
        bestWin: s.bestWin ? { value: s.bestWin.cents / 100, game: s.bestWin.game, mult: s.bestWin.mult } : null,
        favourite: favourite(s),
      },
      bio: s.bio ?? null,
      look: { color: s.look?.color ?? null, symbols: s.look?.symbols ?? null },
      // Pinned items and banner: shown to everyone, that's what they're for.
      showcase: {
        banner: s.showcase?.banner ?? "default",
        items: (s.showcase?.uids ?? [])
          .map((uid) => p.inventory.find((it) => it.uid === uid))
          .filter(Boolean)
          .map(({ uid, itemId, phase, float, wear, stattrak, seed, obtainedAt }) => ({ uid, itemId, phase, float, wear, stattrak, seed, obtainedAt })),
      },
      // Friends only:
      ...(close
        ? {
            online: self || this.isOnline(row.id),
            balance: p.balance,
            inventoryValue: p.inventoryValue,
            itemCount: p.inventory.length,
            inventory: p.inventory.map(({ uid, itemId, phase, float, wear, stattrak, seed, obtainedAt }) => ({ uid, itemId, phase, float, wear, stattrak, seed, obtainedAt })),
          }
        : {}),
    };
  }
}
