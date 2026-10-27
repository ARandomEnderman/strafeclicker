# StrafeClicker

A CS2 case-opening simulator. Play money only: no deposits, no withdrawals, nothing real.

- **Real cases & contents**: all 42 CS2 weapon cases, with their actual skins, float ranges, StatTrak eligibility and Doppler phases.
- **Real odds**: Valve's published rates (Mil-Spec 79.92%, Restricted 15.98%, Classified 3.20%, Covert 0.64%, Rare Special 0.26%), 10% StatTrak, community-measured float distribution.
- **Live market prices**: the server refreshes every wear / StatTrak / phase price from Skinport (lowest current listing) once a minute, on the minute. Every browser sees the same countdown and gets the update pushed at the same moment; clients can't trigger or delay it.
- **Inventory change popup** after each update that moves your inventory's value, with the biggest movers. It also covers time away: reopen the site and it shows what changed since you last looked.
- **Price history graphs** for every item variant (click any item), recorded by the server.
- **Provably fair**: rolls are `HMAC-SHA256(serverSeed, "clientSeed:nonce")`, with a seed reveal + verifier page.

## Run

```sh
npm install
npm run dev        # http://localhost:3000 (Vite + API on one port)

npm run build
npm start          # production: serves dist/ + API, PORT defaults to 3000
```

Behind an HTTP proxy on Node 22, prefix with `NODE_USE_ENV_PROXY=1` so `fetch` uses it.

Needs a host that runs Node (a VPS, Fly.io, Render, Railway…). Static hosting like GitHub Pages won't work anymore because the price schedule lives on the server.

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

`server/snapshot.json` is a committed set of contents and prices. The server falls back to it if GitHub is unreachable and starts from its prices until the first tick. Regenerate it with `npm run data`.

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
| `server/index.mjs` | HTTP server, price ticks, SSE |
| `server/data.mjs` | Case contents + Skinport prices |
| `server/history.mjs` | Price history log |
| `scripts/build-data.mjs` | Regenerates `server/snapshot.json` |
| `src/odds.ts` | Drop rates, wear buckets, phase weights |
| `src/catalog.ts` | Rolling a drop, pricing, expected value |
| `src/live.ts` | Listens for server price updates |
| `src/fair.ts` | Provably-fair RNG |
| `src/state.ts` | Balance, inventory, stats (localStorage) |
| `src/skin-renderer.ts` | Skin picture plug point |
| `src/ui/` | Pages, countdown, popup, price chart |
