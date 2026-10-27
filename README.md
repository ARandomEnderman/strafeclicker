# StrafeClicker

A CS2 case-opening simulator. Play money only: no deposits, no withdrawals, nothing real.

- **Real cases & capsules**: all 42 CS2 weapon cases plus 229 sticker and autograph capsules, with their actual contents, float ranges, StatTrak eligibility and Doppler phases. Capsules open without a key.
- **Real odds**: Valve's published rates (Mil-Spec 79.92%, Restricted 15.98%, Classified 3.20%, Covert 0.64%, Rare Special 0.26%), 10% StatTrak, community-measured float distribution.
- **Live market prices**: the server refreshes every wear / StatTrak / phase price from Skinport (lowest current listing) once a minute, on the minute. Every browser sees the same countdown and gets the update pushed at the same moment; clients can't trigger or delay it.
- **Inventory change popup** after each update that moves your inventory's value, with the biggest movers. It also covers time away: reopen the site and it shows what changed since you last looked.
- **Price history graphs** for every item variant (click any item), recorded by the server.
- **Accounts**: sign up with a username and password (no guest accounts). Balance, inventory and every roll live on the server in SQLite; the browser only ever sees outcomes.
- **Clicker**: click to earn money ($0.05 per click to start). The server caps clicks at a burst of 20, then 15 per second.
- **Upgrader**: stake up to 10 items for one pricier skin or sticker. Chance = your value ÷ target price × 90%, between 1% and 80%.
- **Upgrade tree**: an Obsidian-style graph (drag nodes, pan, zoom). Spend balance to open up to 5 cases at once, raise click value up to $1.00, and raise offline income from $0.25 to $4.00 per hour. Levels and costs are in `PERKS` in `shared/game.js`.
- **Offline income**: time away (gaps of 5+ minutes, up to 12 hours) is paid out when you come back, with a welcome-back popup.

## Run

```sh
npm install
npm run dev        # http://localhost:3000 (Vite + API on one port)

npm run build
npm start          # production: serves dist/ + API, PORT defaults to 3000
```

Behind an HTTP proxy on Node 22, prefix with `NODE_USE_ENV_PROXY=1` so `fetch` uses it.

Needs a host that runs Node (a VPS, Fly.io, Render, Railway…). Static hosting like GitHub Pages won't work anymore because the price schedule lives on the server.

Needs **Node 22.13 or newer** (it uses Node's built-in SQLite, so there's nothing extra to install).

## Accounts

- Everything is stored in `data/strafeclicker.db` (SQLite): users, inventories and login sessions. Back up that file to back up everyone's stuff.
- Passwords are hashed with scrypt. Sessions are random tokens in an HttpOnly cookie, valid for 30 days; only their hash is stored.
- Failed logins are limited to 15 per IP every 10 minutes (per IP, not per username, so nobody can lock someone else's account). Behind a reverse proxy or Cloudflare Tunnel, set `TRUST_PROXY=1` so the real client IP is used (it reads Cloudflare's `CF-Connecting-IP`, otherwise the last `X-Forwarded-For` entry).
- Everyone starts at $0 (`STARTING_BALANCE` in `server/game.mjs`).
- Anonymous accounts from older versions (`data/accounts.json`) are imported on first start. Signing up from the same browser carries that account's balance and items over.

## How prices work

- `server/index.mjs` ticks at every wall-clock minute. Each tick fetches Skinport's main listing; every 5th tick also fetches the tradable-only listing that fills gaps. That's 6 requests per 5 minutes, under Skinport's limit of 8.
- Skinport refreshes its listings about every 5 minutes, so most ticks find nothing new, and real skin prices move slowly: roughly 1–2% of items change per half hour. The countdown still resets every minute.
- The price is the lowest current listing. Skinport's "suggested price" is only a fallback for items with nothing listed, because it barely changes during the day.
- Changed prices are appended to `data/history.ndjson` (set `DATA_DIR` to move it). Points older than 48 hours are thinned to one per hour.
- On first start the history is backfilled with Skinport's 90/30/7-day and 24-hour sale medians, so graphs aren't empty. They're drawn dashed and left out of the change/high/low stats, since sale medians aren't the same measure as the live listing price.
- Browsers subscribe to `/api/events` (Server-Sent Events). On each tick they fetch only the prices that changed (`/api/prices?since=<version>`).

| Endpoint | |
| --- | --- |
| `GET /api/catalog` | Cases and items (no prices) |
| `GET /api/prices?since=v` | Flat price map, or just the changes since version `v` |
| `GET /api/status` | Last / next update time, version, last error |
| `GET /api/events` | SSE stream of `status` events |
| `GET /api/history/:itemId` | Price history for every variant of an item |
| `POST /api/register` `{username, password}` | Create an account and log in |
| `POST /api/login` `{username, password}` | Log in |
| `POST /api/logout` | Log out |
| `GET /api/me` | Your account (401 when logged out) |
| `POST /api/click` `{clicks}` | Credit clicks (capped per second) |
| `POST /api/open` `{caseId, count}` | Open 1–5 of a case, up to your multi-open level |
| `POST /api/sell` `{uids}` | Sell items at the current price |
| `POST /api/upgrade` `{uids, target}` | Stake items on a target variant |
| `POST /api/perk` `{perk}` | Buy the next level of `multiOpen`, `clickPower` or `offlineIncome` |
| `POST /api/reset` | Wipe your balance, items and upgrades (keeps the login) |

POST bodies must be `application/json`, which also stops other sites from posting forms to it.

`server/snapshot.json.gz` is a committed set of contents and prices. The server falls back to it if GitHub is unreachable and starts from its prices until the first tick. Regenerate it with `npm run data`.

## Plugging in a skin texture generator

All skin pictures go through `src/skin-renderer.ts`. By default it shows the official inventory icon. To use a generator:

```ts
import { setSkinRenderer } from "./skin-renderer";

setSkinRenderer(({ item, phase, float, seed, stattrak, size }) => {
  const canvas = document.createElement("canvas");
  // item.pattern / item.paintIndex identify the finish; float and seed are set for actual drops
  return canvas;
});
```

The returned element is placed in a fixed 4:3 box and should fill it.

## Layout

| Path | What |
| --- | --- |
| `server/index.mjs` | HTTP server, price ticks, SSE, account cookies |
| `server/game.mjs` | Every money action: open, sell, click, upgrade, perks |
| `server/auth.mjs` | Sign-up, login, sessions |
| `server/db.mjs` | SQLite schema |
| `shared/game.js` | Odds, float generation, upgrade chance, perk table (server rolls with it, browser displays it) |
| `server/data.mjs` | Case contents + Skinport prices |
| `server/history.mjs` | Price history log |
| `scripts/build-data.mjs` | Regenerates `server/snapshot.json.gz` |
| `src/odds.ts` | Re-exports the shared rules plus rarity labels |
| `src/catalog.ts` | Pricing and expected value |
| `src/live.ts` | Listens for server price updates |
| `src/state.ts` | Mirrors the server account, sends actions |
| `src/skin-renderer.ts` | Skin picture plug point |
| `src/ui/` | Pages (cases, clicker, upgrader, upgrade tree, inventory), countdown, popup, price chart |
