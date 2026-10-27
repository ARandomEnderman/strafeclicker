import type { Case, Item, OwnedItem } from "../types";
import { caseEV, casePrice, getItem, keyCost, openCost, priceOf, priceRange } from "../catalog";
import { onPricesForPage } from "../live";
import { PERKS, TIER_INFO, needsKey, perkValue, pickTier, tierLabel, tierOdds } from "../odds";
import { renderSkin } from "../skin-renderer";
import { getState, InsufficientFunds, openCases, sell, ServerError } from "../state";
import { h, money, toast } from "./dom";
import { displayName, dropCard, itemPreviewCard } from "./item-card";
import { playTick, playReveal } from "./sound";

const REEL_LENGTH = 60;
const WIN_INDEX = 52;
const SPIN_MS = 6500;

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
    const ev = caseEV(c);
    const price = casePrice(c);
    openBtn.textContent = price == null ? "Not on the market" : `Open ${count > 1 ? `${count} ` : ""}for ${money(cost * count)}`;
    openBtn.disabled = price == null || spinning;
    stats.replaceChildren(
      ...[
        stat(c.kind === "case" ? "Case" : "Capsule", price == null ? "—" : money(price)),
        needsKey(c) ? stat("Key", money(keyCost(c))) : null,
        stat("Expected value", money(ev)),
        stat("RTP", price == null ? "—" : `${((ev / cost) * 100).toFixed(1)}%`),
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
          : h("a", { class: "chip locked", href: "#/tree", title: "Unlock in the upgrade tree" }, `🔒 ×${value}`),
      ),
    );
  };

  makeReels(count);
  drawCount();
  drawPrices();
  onPricesForPage(drawPrices);

  async function spin() {
    if (spinning) return;
    spinning = true;
    openBtn.disabled = true;
    drawCount();
    try {
      let won: OwnedItem[];
      try {
        won = await openCases(c, count);
      } catch (e) {
        if (e instanceof InsufficientFunds) return toast("Not enough balance. Earn some on the Clicker page or sell items.", "error");
        if (e instanceof ServerError) return toast(e.message, "error");
        throw e;
      }
      result.replaceChildren();
      if (reels.children.length !== won.length) makeReels(won.length);
      const wraps = [...reels.children] as HTMLElement[];
      wraps.forEach((wrap, i) => fillReel(wrap.firstElementChild as HTMLElement, c, getItem(won[i].itemId)));
      if (!fast) await Promise.all(wraps.map((wrap, i) => animate(wrap.firstElementChild as HTMLElement, wrap, i === 0)));
      else wraps.forEach((wrap) => snapTo(wrap.firstElementChild as HTMLElement, wrap));
      wraps.forEach((wrap) => ensureLanded(wrap.firstElementChild as HTMLElement, wrap));
      const best = won.map((w) => getItem(w.itemId)).sort((a, b) => TIER_RANK[b.tier] - TIER_RANK[a.tier])[0];
      playReveal(best.tier);
      showResult(won);
    } finally {
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

/** Random filler drawn with the real odds, so the reel looks like a real one. */
function fillReel(reel: HTMLElement, c: Case, winner: Item | null) {
  resetReel(reel);
  const tiles: HTMLElement[] = [];
  for (let i = 0; i < REEL_LENGTH; i++) {
    let item: Item;
    if (winner && i === WIN_INDEX) item = winner;
    else {
      const pool = c.contents[pickTier(c, Math.random())];
      item = getItem(pool[Math.floor(Math.random() * pool.length)]);
    }
    tiles.push(reelTile(item, c));
  }
  reel.replaceChildren(...tiles);
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

/** How far tile i's centre is to the right of the marker, as currently drawn. */
function tileOffset(reel: HTMLElement, wrap: HTMLElement, i: number) {
  const t = (reel.children[i] as HTMLElement).getBoundingClientRect();
  return t.left + t.width / 2 - markerCentre(wrap);
}

const currentX = (reel: HTMLElement) => new DOMMatrixReadOnly(getComputedStyle(reel).transform).m41;

function resetReel(reel: HTMLElement) {
  reel.getAnimations().forEach((a) => a.cancel());
  reel.style.transform = "translateX(0px)";
  if (reel.parentElement) reel.parentElement.scrollLeft = 0;
}

/** Translation that puts the winning tile under the marker, nudged by jitter (±0.42 tile). */
function winX(reel: HTMLElement, wrap: HTMLElement, jitter: number) {
  const width = (reel.children[WIN_INDEX] as HTMLElement).getBoundingClientRect().width;
  return currentX(reel) - tileOffset(reel, wrap, WIN_INDEX) - jitter * width * 0.42;
}

function snapTo(reel: HTMLElement, wrap: HTMLElement) {
  resetReel(reel);
  reel.style.transform = `translateX(${winX(reel, wrap, 0)}px)`;
}

/** Last line of defence: if the reel came to rest off the winning tile, move it there. */
function ensureLanded(reel: HTMLElement, wrap: HTMLElement) {
  const t = (reel.children[WIN_INDEX] as HTMLElement).getBoundingClientRect();
  const m = markerCentre(wrap);
  if (m >= t.left && m <= t.right) return;
  console.warn("Reel stopped off the winning tile; snapping it into place", { tileLeft: t.left, tileRight: t.right, marker: m });
  reel.style.transform = `translateX(${winX(reel, wrap, 0)}px)`;
}

async function animate(reel: HTMLElement, wrap: HTMLElement, sound = true): Promise<void> {
  resetReel(reel);
  const target = winX(reel, wrap, Math.random() * 2 - 1);
  const first = (reel.children[0] as HTMLElement).getBoundingClientRect();
  const pitch = (reel.children[1] as HTMLElement).getBoundingClientRect().left - first.left;
  const markerInReel = markerCentre(wrap) - first.left;

  const anim = reel.animate([{ transform: "translateX(0px)" }, { transform: `translateX(${target}px)` }], {
    duration: SPIN_MS,
    easing: "cubic-bezier(0.08, 0.6, 0.1, 1)",
    fill: "forwards",
  });

  let lastTile = -1;
  let raf = 0;
  const tick = () => {
    const tileUnderMarker = Math.floor((markerInReel - currentX(reel)) / pitch);
    if (tileUnderMarker !== lastTile) {
      if (lastTile !== -1 && sound) playTick();
      lastTile = tileUnderMarker;
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
