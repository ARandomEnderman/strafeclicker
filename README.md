# StrafeClicker

A CS2 case-opening simulator. Play money only: no deposits, no withdrawals, nothing real.

- **Real cases & capsules**: all 42 CS2 weapon cases plus 229 sticker and autograph capsules, with their actual contents, float ranges, StatTrak eligibility and Doppler phases. Capsules open without a key.
- **Real odds**: Valve's published rates (Mil-Spec 79.92%, Restricted 15.98%, Classified 3.20%, Covert 0.64%, Rare Special 0.26%), 10% StatTrak, community-measured float distribution.
- **Live market prices**: the server refreshes every wear / StatTrak / phase price from Skinport (lowest current listing) once a minute, on the minute. Every browser sees the same countdown and gets the update pushed at the same moment; clients can't trigger or delay it.
- **Inventory change popup** after each update that moves your inventory's value, with the biggest movers. It also covers time away: reopen the site and it shows what changed since you last looked.
- **Price history graphs** for every item variant (click any item), recorded by the server.
- **Accounts**: sign up with a username and password (no guest accounts). Balance, inventory and every roll live on the server in SQLite; the browser only ever sees outcomes.
- **Clicker**: click to earn money ($0.05 per click to start). Up to 10 clicks per second pay in full; faster than that, each click is worth exponentially less (12 cps pays 50%, 15 cps 18%, 20 cps 3%). The server works this out from the click timings, and won't accept a timeline that runs ahead of real time.
- **Achievements**: 23 goals named in tiers (Clicker I to IV, Unboxer I to III, ...) (clicks, cases opened, rare drops, upgrades, each game, net worth), each with a one-off cash reward. The server checks them after every action; an unlocked one shows a red count on the Achievements tab and its reward is collected with Claim (or Claim all). They stay unlocked through "Reset everything" so rewards can't be farmed.
- **Plinko**: 8, 12 or 16 rows at low, medium or high risk, with Stake's multiplier tables (each pays back about 99% on average). The server picks the path; several balls can be in the air at once.
- **Flashbang**: a crash game with one round for everyone. A flashbang rides the multiplier curve (e^(0.00006 × ms): 2x after about 12 s, 10x after 38 s) until it pops; cash out before then, by hand or with an auto target. The crash point has a 1% edge (P(at least x) = 0.99 / x, capped at 1000x) and stays on the server until the pop. Rounds are 10 s apart; bets placed while a round runs (if you're not riding it) go into the next one. Everyone on the page, and anyone still riding the round wherever they are on the site, is flashed at the same moment: full white for 1.2 s, fading over 3.3 s, with a bang and ear ringing. Stakes are held in the database, so a restart refunds whatever was riding.
- **B-hop**: jump along a lane of bhop blocks and cash out before one gives way. Pick a difficulty: each jump lands safely 90% (Easy, 24 blocks), 80% (Medium, 20), 60% (Hard, 15) or 40% (Expert, 10) of the time, and the multiplier after k jumps is 0.99 / p^k. The breaking block is decided when the run starts and kept on the server; the browser only learns it by landing on it or when the run ends. Runs survive reloads. The jumper is `src/assets/ct-agent.webp`, keyed from a green-screen capture. Replace it with another picture of the same name (a green-screen `.png`/`.jpg` works too: it's keyed and cropped to the biggest figure in the browser).
- **Defuse**: a 5×5 grid hiding 1–24 C4s. Reveal tiles and cash out before you hit one; after k safe tiles the multiplier is 0.99 / (chance of surviving k picks), so it pays back 99% like the other games. Bomb positions are drawn on the server when the round starts and only shown after it ends. Rounds survive reloads.
- **Case battles**: 2, 3 or 4 players open the same cases, one per round (up to 3 per battle to start, raised to 20 by the Battle size upgrade); the highest total value takes every item (a tie is settled at random). Battles are public, friends only, or private (joined with a 6-character code or invite link). Each player pays when they take a seat, the creator can fill empty seats with bots, and cancelling refunds everyone. When the last seat fills the server rolls everything and hands the items over; every browser then plays the rounds back on the same clock.
- **Friends**: add people by username from the friends button in the top bar; they accept or decline. Friends see your friends-only battles and show as online when they have the site open.
- **Profiles**: click any player's name (live wins, flashbang, battles, friends, trades) for a mini profile: display name, @username, join date, cases opened, battles won, achievements and best item, with Add friend / Trade / Profile buttons. Friends (and you) also see online status, balance and inventory worth, and the profile page (`#/u/<username>`) shows their whole inventory. Your own profile is where you set a display name (up to 24 characters); the username stays your login and what friends add you by. Friends' online status updates live.
- **Trade**: swap items and cash with friends. Pick from both inventories, add cash on either side, send the offer; they accept or decline, you can cancel. Nothing is held while an offer is open: on accept the server checks both sides still have everything and moves it all in one transaction, or the offer fails. The Trade tab shows a red count of offers waiting for you.
- **Live wins**: the sidebar shows notable items people unbox, upgrade into or win in battles (only items; casino payouts aren't posted). Knives, gloves and Covert items always show; otherwise an item needs to be worth $25+, or 10x what its case cost and $2+. A multi-open posts only its best item. Flood control: one entry per player per 15 s, and once 8 went out in a minute only $50+ items get through (knives, gloves and $100+ items skip both limits). The rules are at the top of `server/feed.mjs`. Entries wait until the reel has landed so they never spoil your own roll.
- **Upgrader**: stake up to 10 items for one pricier skin or sticker. Chance = your value ÷ target price × 90%, between 1% and 80%.
- **Upgrade tree**: an Obsidian-style graph (drag nodes, pan, zoom). Each node shows its icon and price; hover for details, click to pin and buy. Spend balance to open up to 5 cases at once, raise click value up to $1.00, raise offline income from $0.25 to $4.00 per hour, and raise how many cases you can put in a case battle from 3 to 20. Levels and costs are in `PERKS` in `shared/game.js`.
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

- **Steam Community Market** is the main source: the lowest current listing of each item (what a buyer pays, Steam's fee included). Steam has no bulk price API and its market search returns 10 items per request, so `server/steam.mjs` collects prices continuously, at most one request every `STEAM_INTERVAL_MS` (default 4000 ms):
  - two requests in three walk the whole market (~35,000 items) in name order, so every item is refreshed every few hours;
  - one in three looks up a "hot" item (anything someone owns, then cases and capsules), so those stay minutes fresh.
  - If Steam rate-limits (HTTP 429) it pauses for 1 minute (doubling up to 15) and slows its pace by 1.5x; after 100 requests in a row without a 429 it speeds up again by 10%, never faster than `STEAM_INTERVAL_MS`. So it settles at whatever Steam allows your IP. What it has collected (and the pace it settled on) is saved to `data/steam-prices.json`, so a restart picks up where it left off.
- **Skinport** (lowest listing) fills what Steam can't: Doppler and Gamma Doppler phases (Steam lists all phases of a knife under one name) and items Steam hasn't reached yet. Skinport allows 8 requests per 5 minutes and refreshes about every 5 minutes; the server uses 6.
- `server/index.mjs` ticks at every wall-clock minute and builds the price list from whatever both sources have at that moment, so each tick carries the Steam prices collected during the last minute. The countdown resets every minute.
- When the server first switches to Steam, prices move from Skinport's to Steam's as the sweep reaches each item (Steam is usually higher), so expect one bigger jump in the graphs and the inventory-change popup.
- Price history is stored brotli-compressed in `data/history.br` (about 10× smaller than plain JSON), with changes since the last hourly repack in `data/history.ndjson`. Set `DATA_DIR` to move it. Points older than 48 hours are thinned to one per hour.
- On first start the history is backfilled with Skinport's 90/30/7-day and 24-hour sale medians, so graphs aren't empty. They're drawn dashed and left out of the change/high/low stats, since sale medians aren't the same measure as the live listing price.
- Browsers subscribe to `/api/events` (Server-Sent Events). On each tick they fetch only the prices that changed (`/api/prices?since=<version>`).

| Endpoint | |
| --- | --- |
| `GET /api/catalog` | Cases and items (no prices) |
| `GET /api/prices?since=v` | Flat price map, or just the changes since version `v` |
| `GET /api/status` | Last / next update time, version, last error |
| `GET /api/events` | SSE stream: `status`, `wins` (recent list on connect), `win`, `fb` (flashbang round), `battles`, and for your own session `account` and `friends` |
| `GET /api/history/:itemId` | Price history for every variant of an item |
| `POST /api/register` `{username, password}` | Create an account and log in |
| `POST /api/login` `{username, password}` | Log in |
| `POST /api/logout` | Log out |
| `GET /api/me` | Your account (401 when logged out) |
| `POST /api/click` `{clicks, times}` | Credit clicks; `times` are the click timestamps (ms) |
| `POST /api/open` `{caseId, count}` | Open 1–5 of a case, up to your multi-open level |
| `POST /api/sell` `{uids}` | Sell items at the current price |
| `POST /api/upgrade` `{uids, target}` | Stake items on a target variant |
| `POST /api/perk` `{perk}` | Buy the next level of `multiOpen`, `clickPower`, `offlineIncome` or `battleRounds` |
| `POST /api/plinko` `{bet, rows, risk}` | Drop a plinko ball; returns its path and payout |
| `POST /api/flashbang` `{action: "bet", bet, auto?}` / `{action: "cancel"}` / `{action: "cashout"}` | Flashbang bets; round state comes over SSE as `fb` events |
| `POST /api/bhop` `{action: "start", bet, difficulty}` / `jump` / `cashout` / `state` | B-hop runs |
| `POST /api/battle` `{action: "create", cases, size, visibility}` / `join` `{id}` or `{code}` / `bots` / `cancel` | Case battles; the list (filtered per user) comes over SSE as `battles` events |
| `POST /api/friends` `{action: "list" \| "request" \| "accept" \| "remove", username}` | Friends and requests |
| `POST /api/claim` `{id?}` | Collect an unlocked achievement's reward (all of them without `id`) |
| `POST /api/trade` `{action: "list" \| "inventory" \| "offer" \| "accept" \| "decline" \| "cancel", ...}` | Trade offers with friends (`inventory` shows a friend's items) |
| `POST /api/profile` `{username}` / `{action: "rename", name}` | A player's profile (more for friends), or set your display name |
| `POST /api/defuse` `{action: "start", bet, bombs}` / `reveal` `{tile}` / `cashout` / `state` | Defuse rounds |
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
| `server/games/` | Plinko, flashbang, b-hop, case battles |
| `server/friends.mjs` | Friend requests and lists |
| `server/trades.mjs` | Trade offers |
| `server/profiles.mjs` | Player profiles |
| `server/steam.mjs` | Steam Market price collector |
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
