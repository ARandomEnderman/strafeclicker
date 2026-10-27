import type { Case, Item, OwnedItem } from "../types";
import { caseEV, getItem, openCost, pickTier, priceOf, priceRange, tierOdds } from "../catalog";
import { TIER_INFO } from "../odds";
import { renderSkin } from "../skin-renderer";
import { getState, InsufficientFunds, openCase, sell } from "../state";
import { h, money, toast } from "./dom";
import { displayName, dropCard, itemPreviewCard } from "./item-card";
import { playTick, playReveal } from "./sound";

const REEL_LENGTH = 60;
const WIN_INDEX = 52;
const SPIN_MS = 6500;

let fast = false;

export function casePage(c: Case) {
  const cost = openCost(c);
  const ev = caseEV(c);

  const reel = h("div", { class: "reel" });
  const reelWrap = h("div", { class: "reel-wrap" }, reel, h("div", { class: "reel-marker" }));
  const result = h("div", { class: "result" });
  const openBtn = h("button", { class: "btn btn-primary btn-lg", onclick: () => spin() }, `Open for ${money(cost)}`);
  fillReel(reel, c, null);

  async function spin() {
    let won: OwnedItem;
    try {
      won = await openCase(c);
    } catch (e) {
      if (e instanceof InsufficientFunds) return toast("Not enough balance. Top up or sell some skins.", "error");
      throw e;
    }
    openBtn.disabled = true;
    result.replaceChildren();
    fillReel(reel, c, getItem(won.itemId));
    if (!fast) await animate(reel, reelWrap);
    else snapTo(reel, reelWrap);
    playReveal(getItem(won.itemId).tier);
    showResult(won);
    openBtn.disabled = false;
  }

  function showResult(won: OwnedItem) {
    const value = priceOf(won);
    const inInv = () => getState().inventory.some((i) => i.uid === won.uid);
    const sellBtn = h(
      "button",
      {
        class: "btn",
        onclick: () => {
          if (!inInv()) return;
          sell([won.uid]);
          toast(`Sold for ${money(value)}`);
          sellBtn.disabled = true;
          sellBtn.textContent = "Sold";
        },
      },
      `Sell for ${money(value)}`,
    );
    const item = getItem(won.itemId);
    result.replaceChildren(
      h(
        "div",
        { class: `result-card tier-${item.tier}` },
        dropCard(won, { size: "lg" }),
        h(
          "div",
          { class: "result-actions" },
          h("div", { class: `result-delta ${value >= cost ? "up" : "down"}` }, `${value >= cost ? "+" : ""}${money(value - cost)}`),
          sellBtn,
          h("a", { class: "btn btn-ghost", href: "#/inventory" }, "Inventory"),
        ),
      ),
    );
  }

  return h(
    "section",
    { class: "page" },
    h("a", { class: "back", href: "#/" }, "← All cases"),
    h(
      "div",
      { class: "case-hero" },
      h("img", { src: c.image, alt: "" }),
      h(
        "div",
        null,
        h("h1", null, c.name),
        h(
          "div",
          { class: "case-stats" },
          stat("Case", money(c.price)),
          stat("Key", money(cost - c.price)),
          stat("Expected value", money(ev)),
          stat("RTP", `${((ev / cost) * 100).toFixed(1)}%`),
        ),
        h(
          "div",
          { class: "case-actions" },
          openBtn,
          h(
            "label",
            { class: "toggle" },
            h("input", { type: "checkbox", checked: fast, onchange: (e: Event) => (fast = (e.target as HTMLInputElement).checked) }),
            " Skip animation",
          ),
        ),
      ),
    ),
    reelWrap,
    result,
    contents(c),
  );
}

function stat(label: string, value: string) {
  return h("div", { class: "stat" }, h("span", null, label), h("b", null, value));
}

/** Random filler drawn with the real odds, so the reel looks like a real one. */
function fillReel(reel: HTMLElement, c: Case, winner: Item | null) {
  reel.style.transition = "none";
  reel.style.transform = "translateX(0)";
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

function targetOffset(reel: HTMLElement, wrap: HTMLElement, jitter: number) {
  const tile = reel.children[WIN_INDEX] as HTMLElement;
  return tile.offsetLeft + tile.offsetWidth / 2 - wrap.clientWidth / 2 + jitter * tile.offsetWidth * 0.42;
}

function snapTo(reel: HTMLElement, wrap: HTMLElement) {
  reel.style.transform = `translateX(${-targetOffset(reel, wrap, 0)}px)`;
}

function animate(reel: HTMLElement, wrap: HTMLElement): Promise<void> {
  const target = targetOffset(reel, wrap, Math.random() * 2 - 1);
  const pitch = (reel.children[1] as HTMLElement).offsetLeft - (reel.children[0] as HTMLElement).offsetLeft;
  void reel.offsetWidth; // flush the reset before starting the transition
  reel.style.transition = `transform ${SPIN_MS}ms cubic-bezier(0.08, 0.6, 0.1, 1)`;
  reel.style.transform = `translateX(${-target}px)`;

  return new Promise((resolve) => {
    let lastTile = -1;
    let raf = 0;
    const tick = () => {
      const x = -new DOMMatrixReadOnly(getComputedStyle(reel).transform).m41;
      const tileUnderMarker = Math.floor((x + wrap.clientWidth / 2) / pitch);
      if (tileUnderMarker !== lastTile) {
        if (lastTile !== -1) playTick();
        lastTile = tileUnderMarker;
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    const done = () => {
      cancelAnimationFrame(raf);
      resolve();
    };
    reel.addEventListener("transitionend", done, { once: true });
    setTimeout(done, SPIN_MS + 300); // in case transitionend never fires (tab hidden)
  });
}

function contents(c: Case) {
  return h(
    "div",
    { class: "contents" },
    h("h2", null, "Contents & odds"),
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
            h("b", null, tier === "gold" ? c.rareLabel : info.label),
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
  );
}
