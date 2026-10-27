# StrafeClicker

A CS2 case-opening simulator. Play money only: no deposits, no withdrawals, nothing real.

- **Real cases & contents**: all 42 CS2 weapon cases, with their actual skins, float ranges, StatTrak eligibility and Doppler phases.
- **Real odds**: Valve's published rates (Mil-Spec 79.92%, Restricted 15.98%, Classified 3.20%, Covert 0.64%, Rare Special 0.26%), 10% StatTrak, community-measured float distribution.
- **Real prices**: every wear / StatTrak / phase priced from the Skinport market. Each case shows its expected value and RTP.
- **Provably fair**: rolls are `HMAC-SHA256(serverSeed, "clientSeed:nonce")`, with a seed reveal + verifier page.

## Run

```sh
npm install
npm run dev        # http://localhost:5173
npm run build      # static site in dist/
```

## Refresh market data

`public/data/catalog.json` is a committed snapshot. To rebuild it with current prices:

```sh
npm run data
```

Behind an HTTP proxy on Node 22, prefix it with `NODE_USE_ENV_PROXY=1`. Skinport rate-limits to 8 requests / 5 minutes.

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
| `scripts/build-data.mjs` | Fetches case contents + prices, writes the catalog |
| `src/odds.ts` | Drop rates, wear buckets, phase weights |
| `src/catalog.ts` | Rolling a drop, pricing, expected value |
| `src/fair.ts` | Provably-fair RNG |
| `src/state.ts` | Balance, inventory, stats (localStorage) |
| `src/skin-renderer.ts` | Skin picture plug point |
| `src/ui/` | Pages: cases, case + spinner, inventory, fairness |
