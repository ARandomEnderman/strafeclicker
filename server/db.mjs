// SQLite storage for users, sessions and inventories, via Node's built-in
// node:sqlite (Node 22.13+), so there's nothing to install or compile.

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

const [major, minor] = process.versions.node.split(".").map(Number);
if (major < 22 || (major === 22 && minor < 13)) {
  throw new Error(`StrafeClicker needs Node 22.13 or newer for its built-in SQLite (you have ${process.version}). Update from nodejs.org.`);
}

// node:sqlite still prints an ExperimentalWarning on every start; it works fine.
const emitWarning = process.emitWarning;
process.emitWarning = (warning, ...rest) => {
  if (String(warning).includes("SQLite is an experimental feature")) return;
  return emitWarning.call(process, warning, ...rest);
};
const { DatabaseSync } = await import("node:sqlite");

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY,
  username      TEXT    NOT NULL UNIQUE COLLATE NOCASE,
  pass_hash     TEXT    NOT NULL,
  created_at    INTEGER NOT NULL,
  balance_cents INTEGER NOT NULL DEFAULT 0,
  perks         TEXT    NOT NULL DEFAULT '{}',
  stats         TEXT    NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS items (
  uid         TEXT    PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  item_id     TEXT    NOT NULL,
  phase       TEXT,
  float       REAL,
  wear        TEXT,
  stattrak    INTEGER NOT NULL DEFAULT 0,
  seed        INTEGER,
  source      TEXT    NOT NULL,
  obtained_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS items_by_user ON items(user_id, obtained_at);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT    PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

-- Anonymous accounts from before logins existed, waiting to be claimed on register.
CREATE TABLE IF NOT EXISTS legacy_accounts (
  id   TEXT PRIMARY KEY,
  data TEXT NOT NULL
);
`;

/**
 * The most a balance can hold: $1 quadrillion. Past about $90 trillion a balance is no
 * longer exact to the cent (a double's spacing reaches 16 cents at the cap), which is
 * fine for play money; much further and small bets would stop registering at all.
 */
export const MAX_BALANCE_CENTS = 1e17;

/**
 * node:sqlite throws when it reads an integer past 2^53 into a JavaScript number, so
 * every statement reads integers as BigInt and hands them back as (rounded) numbers.
 */
function readBigNumbers(db) {
  const toNum = (row) => {
    if (row) for (const k in row) if (typeof row[k] === "bigint") row[k] = Number(row[k]);
    return row;
  };
  const prepare = db.prepare.bind(db);
  db.prepare = (sql) => {
    const s = prepare(sql);
    s.setReadBigInts(true);
    const { get, all, run } = s;
    s.get = (...args) => toNum(get.apply(s, args));
    s.all = (...args) => all.apply(s, args).map(toNum);
    s.run = (...args) => toNum(run.apply(s, args));
    return s;
  };
}

export function openDb(file) {
  mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  readBigNumbers(db);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  db.exec(SCHEMA);
  // Columns added after the first release.
  const userCols = new Set(db.prepare("PRAGMA table_info(users)").all().map((c) => c.name));
  if (!userCols.has("last_active")) db.exec("ALTER TABLE users ADD COLUMN last_active INTEGER");
  if (!userCols.has("display_name")) db.exec("ALTER TABLE users ADD COLUMN display_name TEXT");
  if (!userCols.has("banned")) db.exec("ALTER TABLE users ADD COLUMN banned INTEGER NOT NULL DEFAULT 0");
  if (!userCols.has("muted_until")) db.exec("ALTER TABLE users ADD COLUMN muted_until INTEGER");
  migrate(db);
  // Balances past the cap (e.g. a huge admin gift from before it existed) are cut back to
  // it, in SQL, since reading them into JavaScript is what fails.
  db.prepare("UPDATE users SET balance_cents = ? WHERE balance_cents > ?").run(MAX_BALANCE_CENTS, MAX_BALANCE_CENTS);
  return db;
}

/** One-off data changes, tracked with SQLite's user_version. */
function migrate(db) {
  const version = db.prepare("PRAGMA user_version").get().user_version;
  if (version < 1) {
    // Battle size went from 3/5/10/15/20 cases to 5/10/.../35: keep everyone's case count.
    const NEW_LEVEL = [0, 0, 1, 2, 3];
    const set = db.prepare("UPDATE users SET perks = ? WHERE id = ?");
    tx(db, () => {
      for (const { id, perks } of db.prepare("SELECT id, perks FROM users").all()) {
        const p = JSON.parse(perks);
        if (!p.battleRounds) continue;
        p.battleRounds = NEW_LEVEL[p.battleRounds] ?? 0;
        set.run(JSON.stringify(p), id);
      }
      db.exec("PRAGMA user_version = 1");
    });
  }
}

/** Run fn inside a transaction; roll back if it throws. */
export function tx(db, fn) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const out = fn();
    db.exec("COMMIT");
    return out;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}
