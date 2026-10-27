# StrafeClicker

A CS2 case-opening simulator. Play money only: no deposits, no withdrawals, nothing real.

- **Real cases & capsules**: all 42 CS2 weapon cases plus 229 sticker and autograph capsules, with their actual contents, float ranges, StatTrak eligibility and Doppler phases. Capsules open without a key.
- **Real odds**: Valve's published rates (Mil-Spec 79.92%, Restricted 15.98%, Classified 3.20%, Covert 0.64%, Rare Special 0.26%), 10% StatTrak, community-measured float distribution.
- **Live market prices**: the server refreshes every wear / StatTrak / phase price from Skinport (lowest current listing) once a minute, on the minute. Every browser sees the same countdown and gets the update pushed at the same moment; clients can't trigger or delay it.
- **Inventory change popup** after each update that moves your inventory's value, with the biggest movers. It also covers time away: reopen the site and it shows what changed since you last looked.
- **Price history graphs** for every item variant (click any item), recorded by the server.
- **Accounts**: sign up with a username and password (no guest accounts). Balance, inventory and every roll live on the server in SQLite; the browser only ever sees outcomes.
- **Clicker**: click to earn money ($0.05 per click to start). Up to 10 clicks per second pay in full; faster than that, each click is worth exponentially less (12 cps pays 50%, 15 cps 18%, 20 cps 3%). The server works this out from the click timings, and won't accept a timeline that runs ahead of real time.
- **Achievements**: 23 goals named in tiers (Clicker I to IV, Unboxer I to III, ...) (clicks, cases opened, rare drops, upgrades, each game, net worth), each with a one-off cash reward. Checked by the server after every action; they stay unlocked through "Reset everything" so rewards can't be farmed.
- **Plinko**: 8, 12 or 16 rows at low, medium or high risk, with Stake's multiplier tables (each pays back about 99% on average). The server picks the path; several balls can be in the air at once.
- **Flashbang**: a crash game with one round for everyone. A flashbang rides the multiplier curve (e^(0.00006 × ms): 2x after about 12 s, 10x after 38 s) until it pops; cash out before then, by hand or with an auto target. The crash point has a 1% edge (P(at least x) = 0.99 / x, capped at 1000x) and stays on the server until the pop. Rounds are 10 s apart; bets placed while a round runs (if you're not riding it) go into the next one. Everyone on the page, and anyone still riding the round wherever they are on the site, is flashed at the same moment: full white for 1.2 s, fading over 3.3 s, with a bang and ear ringing. Stakes are held in the database, so a restart refunds whatever was riding.
- **Live wins**: the sidebar shows everyone's big wins as they happen (at least 2x the stake, and $5+ or 10x+), held back until the reel or animation has finished so it never spoils your own roll.
- **Upgrader**: stake up to 10 items for one pricier skin or sticker. Chance = your value ÷ target price × 90%, between 1% and 80%.
- **Upgrade tree**: an Obsidian-style graph (drag nodes, pan, zoom). Each node shows its icon and price; hover for details, click to pin and buy. Spend balance to open up to 5 cases at once, raise click value up to $1.00, and raise offline income from $0.25 to $4.00 per hour. Levels and costs are in `PERKS` in `shared/game.js`.
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

## Run on ZimaOS (Docker + Cloudflare Tunnel)

On the Zima box (SSH or its terminal):

```sh
cd /DATA
git clone -b claude/inspiring-thompson-a4htcj https://github.com/ARandomEnderman/strafeclicker.git
cd strafeclicker
docker compose up -d --build
docker logs -f strafeclicker      # wait for "listening on http://localhost:3000", then Ctrl+C
```

No `git` on the box? Download the code instead:
`wget -O sc.tar.gz https://github.com/ARandomEnderman/strafeclicker/archive/refs/heads/claude/inspiring-thompson-a4htcj.tar.gz && tar xzf sc.tar.gz`

- Open `http://<zima-ip>:3000` on your network to check it works.
- In the Cloudflared app, point the public hostname at `http://<zima-ip>:3000`.
- Everything is stored in `/DATA/AppData/strafeclicker` (accounts database, compressed price history). Back up that folder.
- Update later with `git pull && docker compose up -d --build`. Data is kept.
- Port 3000 taken? Change the left side of `"3000:3000"` in `docker-compose.yml`, e.g. `"3100:3000"`.
- `TRUST_PROXY=1` is already set in the compose file. Don't port-forward the port on your router; the tunnel doesn't need it.

## How prices work

- `server/index.mjs` ticks at every wall-clock minute. Each tick fetches Skinport's main listing; every 5th tick also fetches the tradable-only listing that fills gaps. That's 6 requests per 5 minutes, under Skinport's limit of 8.
- Skinport refreshes its listings about every 5 minutes, so most ticks find nothing new, and real skin prices move slowly: roughly 1–2% of items change per half hour. The countdown still resets every minute.
- The price is the lowest current listing. Skinport's "suggested price" is only a fallback for items with nothing listed, because it barely changes during the day.
- Price history is stored brotli-compressed in `data/history.br` (about 10× smaller than plain JSON), with changes since the last hourly repack in `data/history.ndjson`. Set `DATA_DIR` to move it. Points older than 48 hours are thinned to one per hour.
- On first start the history is backfilled with Skinport's 90/30/7-day and 24-hour sale medians, so graphs aren't empty. They're drawn dashed and left out of the change/high/low stats, since sale medians aren't the same measure as the live listing price.
- Browsers subscribe to `/api/events` (Server-Sent Events). On each tick they fetch only the prices that changed (`/api/prices?since=<version>`).

| Endpoint | |
| --- | --- |
| `GET /api/catalog` | Cases and items (no prices) |
| `GET /api/prices?since=v` | Flat price map, or just the changes since version `v` |
| `GET /api/status` | Last / next update time, version, last error |
| `GET /api/events` | SSE stream: `status`, `wins` (recent list on connect), `win`, `fb` (flashbang round) and, for your own session, `account` |
| `GET /api/history/:itemId` | Price history for every variant of an item |
| `POST /api/register` `{username, password}` | Create an account and log in |
| `POST /api/login` `{username, password}` | Log in |
| `POST /api/logout` | Log out |
| `GET /api/me` | Your account (401 when logged out) |
| `POST /api/click` `{clicks, times}` | Credit clicks; `times` are the click timestamps (ms) |
| `POST /api/open` `{caseId, count}` | Open 1–5 of a case, up to your multi-open level |
| `POST /api/sell` `{uids}` | Sell items at the current price |
| `POST /api/upgrade` `{uids, target}` | Stake items on a target variant |
| `POST /api/perk` `{perk}` | Buy the next level of `multiOpen`, `clickPower` or `offlineIncome` |
| `POST /api/plinko` `{bet, rows, risk}` | Drop a plinko ball; returns its path and payout |
| `POST /api/flashbang` `{action: "bet", bet, auto?}` / `{action: "cancel"}` / `{action: "cashout"}` | Flashbang bets; round state comes over SSE as `fb` events |
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
| `server/feed.mjs` | Live big-wins feed |
| `server/games/` | Plinko and the other casino games |
| `shared/achievements.js` | Achievement list, goals and rewards |
| `shared/game.js` | Odds, float generation, upgrade chance, perk table (server rolls with it, browser displays it) |
| `server/data.mjs` | Case contents + Skinport prices |
| `server/history.mjs` | Price history log |
| `scripts/build-data.mjs` | Regenerates `server/snapshot.json.gz` |
| `src/odds.ts` | Re-exports the shared rules plus rarity labels |
| `src/catalog.ts` | Pricing and expected value |
| `src/live.ts` | Listens for server price updates |
| `src/state.ts` | Mirrors the server account, sends actions |
| `src/skin-renderer.ts` | Skin picture plug point |
| `src/ui/` | Pages (cases, clicker, upgrader, upgrade tree, inventory), sidebar feed, countdown, popup, price chart |

Icons are from [Lucide](https://lucide.dev) (ISC licence); `src/ui/icons.ts` lists the ones used.
