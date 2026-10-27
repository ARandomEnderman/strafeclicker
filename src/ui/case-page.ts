import type { Case, Item, OwnedItem } from "../types";
import { casePrice, getItem, keyCost, openCost, priceOf, priceRange } from "../catalog";
import { onPricesForPage } from "../live";
import { PERKS, TIER_INFO, needsKey, perkValue, pickWeighted, tierLabel, tierOdds } from "../odds";
import { renderSkin } from "../skin-renderer";
import { getState, holdToastsFor, InsufficientFunds, openCases, sell, ServerError } from "../state";
import { h, money, toast } from "./dom";
import { icon } from "./icons";
import { displayName, dropCard, itemPreviewCard } from "./item-card";
import { onLeave } from "./page";
import { playTick, playReveal } from "./sound";

// The reel copies CS2's own case-opening popup (panorama popup_capability_decodable.js/.css):
// 38 tiles, the scroll starts on tile 35 and stops on the dropped item at tile 3, a random
// 10–90% across it, over 6 s with cubic-bezier(0.075, 0.82, 0.165, 1), then the item is
// revealed. CS2 lays tiles out right-to-left; ours go left-to-right, so its tile i is our 37 - i.
// Our tiles are narrower than CS2's, so PAD extra filler tiles on each side keep the
// strip full edge to edge; the 32-tile trip from start to winner is unchanged.
const CS2_TILES = 38;
const PAD = 8;
const REEL_LENGTH = CS2_TILES + 2 * PAD;
const WIN_INDEX = PAD + (CS2_TILES - 1 - 3);
const START_INDEX = PAD + (CS2_TILES - 1 - 35);
const SPIN_MS = 6000;
const SPIN_EASING = "cubic-bezier(0.075, 0.82, 0.165, 1)";
/** CS2's per-item display weights for filler tiles, by rarity (Mil-Spec / High Grade first). */
const FILLER_WEIGHT = { milspec: 1250, restricted: 250, classified: 50, covert: 10, gold: 0 } as const;

let fast = false;

export function casePage(c: Case) {
  const reels = h("div", { class: "reels" });
  const result = h("div", { class: "result" });
  const openBtn = h("button", { class: "btn btn-primary btn-lg", onclick: () => spin() });
  const countPicker = h("div", { class: "sort count-picker" });
  const stats = h("div", { class: "case-stats" });
  const contentsEl = h("div", { class: "contents" });
  let spinning = false;
  let count = Math.min(lastCount, maxCount());

  const makeReels = (n: number) => {
    reels.classList.toggle("multi", n > 1);
    reels.replaceChildren(
      ...Array.from({ length: n }, () => {
        const reel = h("div", { class: "reel" });
        fillReel(reel, c, null);
        return h("div", { class: "reel-wrap" }, reel, h("div", { class: "reel-marker" }));
      }),
    );
  };

  // Everything price-dependent is redrawn when the server pushes new prices.
  const drawPrices = () => {
    const cost = openCost(c);
    const price = casePrice(c);
    openBtn.textContent = price == null ? "Not on the market" : `Open ${count > 1 ? `${count} ` : ""}for ${money(cost * count)}`;
    openBtn.disabled = price == null || spinning;
    stats.replaceChildren(
      ...[
        stat(c.kind === "case" ? "Case" : "Capsule", price == null ? "—" : money(price)),
        needsKey(c) ? stat("Key", money(keyCost(c))) : null,
      ].filter((el) => el != null),
    );
    contentsEl.replaceChildren(...contents(c));
  };

  // ×1 … ×5; levels you haven't bought yet are locked and point at the upgrade tree.
  const drawCount = () => {
    const max = maxCount();
    countPicker.replaceChildren(
      ...PERKS.multiOpen.levels.map(({ value }) =>
        value <= max
          ? h(
              "button",
              {
                class: `chip${value === count ? " active" : ""}`,
                disabled: spinning,
                onclick: () => {
                  count = lastCount = value;
                  makeReels(count);
                  drawCount();
                  drawPrices();
                },
              },
              `×${value}`,
            )
          : h("a", { class: "chip locked", href: "#/tree", title: "Unlock in the upgrade tree" }, icon("lock", 12), ` ×${value}`),
      ),
    );
  };

  makeReels(count);
  drawCount();
  drawPrices();
  onPricesForPage(drawPrices);

  let reveal: (() => void) | undefined;
  onLeave(() => reveal?.());
  async function spin() {
    if (spinning) return;
    reveal = undefined;
    spinning = true;
    openBtn.disabled = true;
    drawCount();
    try {
      let won: OwnedItem[];
      try {
        holdToastsFor(SPIN_MS + 800);
        const opened = await openCases(c, count);
        won = opened.items;
        reveal = opened.reveal;
      } catch (e) {
        if (e instanceof InsufficientFunds) return toast("Not enough balance. Earn some on the Clicker page or sell items.", "error");
        if (e instanceof ServerError) return toast(e.message, "error");
        throw e;
      }
      result.replaceChildren();
      if (reels.children.length !== won.length) makeReels(won.length);
      const wraps = [...reels.children] as HTMLElement[];
      wraps.forEach((wrap, i) => fillReel(wrap.firstElementChild as HTMLElement, c, getItem(won[i].itemId)));
      if (!fast) await Promise.all(wraps.map((wrap, i) => animate(wrap.firstElementChild as HTMLElement, i === 0)));
      else wraps.forEach((wrap) => snapTo(wrap.firstElementChild as HTMLElement));
      wraps.forEach((wrap) => ensureLanded(wrap.firstElementChild as HTMLElement, wrap));
      const best = won.map((w) => getItem(w.itemId)).sort((a, b) => TIER_RANK[b.tier] - TIER_RANK[a.tier])[0];
      playReveal(best.tier);
      reveal();
      showResult(won);
    } finally {
      // Leaving mid-spin (or an error) still puts the items in the inventory.
      reveal?.();
      spinning = false;
      drawCount();
      drawPrices();
    }
  }

  function showResult(won: OwnedItem[]) {
    const cost = openCost(c) * won.length;
    const value = won.reduce((s, w) => s + priceOf(w), 0);
    const unsold = () => won.filter((w) => getState().inventory.some((i) => i.uid === w.uid));
    const sellBtn = (items: OwnedItem[], label: string) => {
      const btn: HTMLButtonElement = h(
        "button",
        {
          class: "btn",
          onclick: async () => {
            const left = items.filter((w) => unsold().includes(w));
            if (!left.length) return;
            btn.disabled = true;
            toast(`Sold for ${money(await sell(left.map((w) => w.uid)))}`);
            btn.textContent = "Sold";
          },
        },
        label,
      );
      return btn;
    };
    const delta = h("div", { class: `result-delta ${value >= cost ? "up" : "down"}` }, `${value >= cost ? "+" : ""}${money(value - cost)}`);

    if (won.length === 1) {
      const item = getItem(won[0].itemId);
      result.replaceChildren(
        h(
          "div",
          { class: `result-card tier-${item.tier}` },
          dropCard(won[0], { size: "lg" }),
          h("div", { class: "result-actions" }, delta, sellBtn(won, `Sell for ${money(value)}`), h("a", { class: "btn btn-ghost", href: "#/inventory" }, "Inventory")),
        ),
      );
      return;
    }
    result.replaceChildren(
      h(
        "div",
        { class: "result-multi" },
        h(
          "div",
          { class: "result-multi-head" },
          h("div", null, h("b", null, `${won.length} drops · ${money(value)}`), " ", delta),
          h("div", { class: "result-actions row" }, sellBtn(won, `Sell all for ${money(value)}`), h("a", { class: "btn btn-ghost", href: "#/inventory" }, "Inventory")),
        ),
        h("div", { class: "item-grid" }, ...won.map((w) => dropCard(w, { extra: sellBtn([w], "Sell") }))),
      ),
    );
  }

  return h(
    "section",
    { class: "page" },
    h("a", { class: "back", href: `#/?kind=${c.kind}` }, c.kind === "case" ? "← All cases" : "← All capsules"),
    h(
      "div",
      { class: "case-hero" },
      h("img", { src: c.image, alt: "" }),
      h(
        "div",
        null,
        h("h1", null, c.name),
        stats,
        h(
          "div",
          { class: "case-actions" },
          openBtn,
          countPicker,
          h(
            "label",
            { class: "toggle" },
            h("input", { type: "checkbox", checked: fast, onchange: (e: Event) => (fast = (e.target as HTMLInputElement).checked) }),
            " Skip animation",
          ),
        ),
      ),
    ),
    reels,
    result,
    contentsEl,
  );
}

const TIER_RANK = { milspec: 0, restricted: 1, classified: 2, covert: 3, gold: 4 } as const;
const maxCount = () => perkValue(getState().perks, "multiOpen");
/** Remembered across case pages, like the "skip animation" toggle. */
let lastCount = 1;

function stat(label: string, value: string) {
  return h("div", { class: "stat" }, h("span", null, label), h("b", null, value));
}

/**
 * Filler is drawn like CS2 does it: every item in the case (never the gold special item)
 * weighted by its rarity, so a tile is only gold when you actually won one.
 */
function fillReel(reel: HTMLElement, c: Case, winner: Item | null) {
  resetReel(reel);
  const pool: [string, number][] = Object.values(c.contents)
    .flat()
    .map((id) => [id, FILLER_WEIGHT[getItem(id).tier]] as [string, number])
    .filter(([, w]) => w > 0);
  const tiles: HTMLElement[] = [];
  for (let i = 0; i < REEL_LENGTH; i++) {
    const item = winner && i === WIN_INDEX ? winner : getItem(pickWeighted(pool, Math.random()));
    tiles.push(reelTile(item, c));
  }
  reel.replaceChildren(...tiles);
  // Idle reels rest on the start tile, where the spin begins.
  requestAnimationFrame(() => reel.isConnected && !reel.getAnimations().length && (reel.style.transform = `translateX(${xFor(reel, START_INDEX, 0.5)}px)`));
}

function reelTile(item: Item, c: Case) {
  // Like in-game, knives and gloves stay hidden behind the gold tile until revealed.
  if (item.tier === "gold") {
    return h("div", { class: "reel-tile", style: `--rarity:${item.color}` }, h("div", { class: "rare-tile" }, "★"), h("div", { class: "reel-name" }, c.rareLabel));
  }
  const name = displayName(item);
  return h(
    "div",
    { class: "reel-tile", style: `--rarity:${item.color}` },
    h("div", { class: "item-art" }, renderSkin({ item, size: "sm" })),
    h("div", { class: "reel-name" }, `${name.weapon} | ${name.finish}`),
  );
}

// Positions are measured as drawn (getBoundingClientRect) rather than with offsetLeft,
// which engines disagree on inside transformed or scrolled containers.

const markerCentre = (wrap: HTMLElement) => {
  const m = wrap.querySelector(".reel-marker")!.getBoundingClientRect();
  return m.left + m.width / 2;
};

const currentX = (reel: HTMLElement) => new DOMMatrixReadOnly(getComputedStyle(reel).transform).m41;

function resetReel(reel: HTMLElement) {
  reel.getAnimations().forEach((a) => a.cancel());
  reel.style.transform = "translateX(0px)";
  if (reel.parentElement) reel.parentElement.scrollLeft = 0;
}

/** Translation that puts the marker `fraction` of the way across tile i (0 = its left edge). */
function xFor(reel: HTMLElement, i: number, fraction: number) {
  const wrap = reel.parentElement as HTMLElement;
  const t = (reel.children[i] as HTMLElement).getBoundingClientRect();
  return currentX(reel) - (t.left + t.width * fraction - markerCentre(wrap));
}

function snapTo(reel: HTMLElement) {
  resetReel(reel);
  reel.style.transform = `translateX(${xFor(reel, WIN_INDEX, 0.5)}px)`;
}

/** Last line of defence: if the reel came to rest off the winning tile, move it there. */
function ensureLanded(reel: HTMLElement, wrap: HTMLElement) {
  const t = (reel.children[WIN_INDEX] as HTMLElement).getBoundingClientRect();
  const m = markerCentre(wrap);
  if (m >= t.left && m <= t.right) return;
  console.warn("Reel stopped off the winning tile; snapping it into place", { tileLeft: t.left, tileRight: t.right, marker: m });
  reel.style.transform = `translateX(${xFor(reel, WIN_INDEX, 0.5)}px)`;
}

async function animate(reel: HTMLElement, sound = true): Promise<void> {
  resetReel(reel);
  const start = xFor(reel, START_INDEX, 0.5);
  // CS2: Math.floor(Math.random() * 81 + 10) / 100, i.e. 10%–90% across the tile.
  const slack = Math.floor(Math.random() * 81 + 10) / 100;
  const target = xFor(reel, WIN_INDEX, slack);
  // Measured with the reel at 0: where the marker sits along the strip, and the tile pitch.
  const first = (reel.children[0] as HTMLElement).getBoundingClientRect();
  const pitch = (reel.children[1] as HTMLElement).getBoundingClientRect().left - first.left;
  const markerInReel = markerCentre(reel.parentElement as HTMLElement) - first.left;

  const anim = reel.animate([{ transform: `translateX(${start}px)` }, { transform: `translateX(${target}px)` }], {
    duration: SPIN_MS,
    easing: SPIN_EASING,
    fill: "forwards",
  });
  // Tick each time a new tile passes the marker (CS2's own fixed tick timetable doesn't
  // line up with our narrower tiles).
  let lastTile = Math.floor((markerInReel - start) / pitch);
  let raf = 0;
  const tick = () => {
    const tile = Math.floor((markerInReel - currentX(reel)) / pitch);
    if (tile !== lastTile) {
      if (sound) playTick();
      lastTile = tile;
    }
    raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);
  // If the tab is hidden the animation can stall; finish it rather than hang.
  const guard = setTimeout(() => anim.finish(), SPIN_MS + 2000);
  await anim.finished.catch(() => undefined);
  clearTimeout(guard);
  cancelAnimationFrame(raf);

  reel.style.transform = `translateX(${target}px)`;
  anim.cancel();
}

function contents(c: Case) {
  return [
    h("h2", null, "Contents & odds"),
    h("p", { class: "hint" }, "Click any item to see its price history."),
    ...tierOdds(c)
      .slice()
      .reverse()
      .map(([tier, p]) => {
        const pool = c.contents[tier];
        const info = TIER_INFO[tier];
        return h(
          "div",
          { class: "tier-block" },
          h(
            "div",
            { class: "tier-head", style: `--rarity:${info.color}` },
            h("b", null, tierLabel(c, tier)),
            h("span", null, `${(p * 100).toFixed(2)}% · ${pool.length} items · ${(p / pool.length * 100).toFixed(4)}% each`),
          ),
          h(
            "div",
            { class: "item-grid" },
            ...pool.map((id) => {
              const item = getItem(id);
              const [lo, hi] = priceRange(item);
              return itemPreviewCard(item, lo === hi ? money(lo) : `${money(lo)} – ${money(hi)}`);
            }),
          ),
        );
      }),
  ];
}
