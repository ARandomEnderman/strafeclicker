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

export function openDb(file) {
  mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  db.exec(SCHEMA);
  // Columns added after the first release.
  const userCols = new Set(db.prepare("PRAGMA table_info(users)").all().map((c) => c.name));
  if (!userCols.has("last_active")) db.exec("ALTER TABLE users ADD COLUMN last_active INTEGER");
  if (!userCols.has("display_name")) db.exec("ALTER TABLE users ADD COLUMN display_name TEXT");
  if (!userCols.has("banned")) db.exec("ALTER TABLE users ADD COLUMN banned INTEGER NOT NULL DEFAULT 0");
  if (!userCols.has("muted_until")) db.exec("ALTER TABLE users ADD COLUMN muted_until INTEGER");
  return db;
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
