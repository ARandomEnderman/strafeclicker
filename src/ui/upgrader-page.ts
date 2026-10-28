import type { Drop, Item, OwnedItem } from "../types";
import { getCatalog, getItem, priceOf, round2 } from "../catalog";
import { onPricesForPage } from "../live";
import {
  UPGRADE_MAX_CHANCE,
  UPGRADE_MAX_ITEMS,
  UPGRADE_MIN_CHANCE,
  UPGRADE_RTP,
  WEAR_NAME,
  upgradeChance,
  variants,
} from "../odds";
import { renderSkin } from "../skin-renderer";
import { getState, holdToastsFor, ServerError, subscribe, upgrade } from "../state";
import { h, money, toast } from "./dom";
import { displayName, dropCard, fullName } from "./item-card";
import { onLeave } from "./page";
import { playReveal } from "./sound";

type Variant = Pick<Drop, "itemId" | "phase" | "wear" | "stattrak">;

const MULTIPLIERS = [1.5, 2, 3, 5, 10, 25];
const SHOW_TARGETS = 60;
const SPIN_MS = 4200;

let minMult = 2;
let query = "";

export function upgraderPage() {
  const selected = new Set<string>();
  let target: Variant | null = null;
  let spinning = false;
  // The win zone is centred on the bottom of the ring (180°), half on each side; the arrow rests there.
  const START_DEG = 180;
  let rotation = START_DEG;
  /** The last spin's chance, so its zone stays on the ring (with the arrow on it) until you pick again. */
  let landed: number | null = null;

  const inputSlot = h("div", { class: "upg-slot" });
  const targetSlot = h("div", { class: "upg-slot" });
  const dial = h("div", { class: "upg-dial" });
  const goBtn = h("button", { class: "btn btn-primary btn-lg", onclick: () => go() }, "Upgrade");
  const invGrid = h("div", { class: "item-grid upg-grid" });
  const targetGrid = h("div", { class: "item-grid upg-grid" });
  const multChips = h("div", { class: "sort" });

  const inputValue = () => round2(inputs().reduce((s, it) => s + priceOf(it), 0));
  const inputs = () => getState().inventory.filter((it) => selected.has(it.uid));
  const chance = () => (target ? upgradeChance(inputValue(), priceOf(target)) : 0);
  const chanceOk = (c: number) => c >= UPGRADE_MIN_CHANCE && c <= UPGRADE_MAX_CHANCE;

  // ---------- dial ----------

  const svgNS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(svgNS, "svg");
  svg.setAttribute("viewBox", "0 0 220 220");
  svg.setAttribute("class", "upg-svg");
  const track = document.createElementNS(svgNS, "circle");
  Object.entries({ cx: 110, cy: 110, r: 92, class: "upg-track" }).forEach(([k, v]) => track.setAttribute(k, String(v)));
  const arc = document.createElementNS(svgNS, "path");
  arc.setAttribute("class", "upg-arc");
  const pointer = document.createElementNS(svgNS, "g");
  pointer.setAttribute("class", "upg-pointer");
  // An arrowhead straddling the ring and pointing at the centre, drawn at the top and
  // rotated into place; a thin needle runs from it towards the middle.
  const needle = document.createElementNS(svgNS, "path");
  needle.setAttribute("d", "M110 34 L110 56");
  needle.setAttribute("class", "upg-needle");
  const tri = document.createElementNS(svgNS, "path");
  tri.setAttribute("d", "M110 38 L96 2 L110 10 L124 2 Z");
  tri.setAttribute("class", "upg-arrow");
  pointer.append(needle, tri);
  pointer.style.transform = `rotate(${START_DEG}deg)`;
  svg.append(track, arc, pointer);
  const centre = h("div", { class: "upg-centre" });
  dial.append(svg, centre);

  const arcPath = (fraction: number) => {
    if (fraction <= 0) return "";
    const a = Math.min(fraction, 0.9999) * 2 * Math.PI;
    const mid = (START_DEG * Math.PI) / 180;
    const pt = (t: number) => `${(110 + 92 * Math.sin(t)).toFixed(2)} ${(110 - 92 * Math.cos(t)).toFixed(2)}`;
    return `M${pt(mid - a / 2)} A92 92 0 ${a > Math.PI ? 1 : 0} 1 ${pt(mid + a / 2)}`;
  };

  const drawDial = () => {
    const c = chance();
    if (target || selected.size) {
      landed = null;
      dial.classList.remove("won", "lost");
    }
    arc.setAttribute("d", arcPath(landed ?? (chanceOk(c) ? c : 0)));
    const mult = target && inputValue() > 0 ? priceOf(target) / inputValue() : 0;
    centre.replaceChildren(
      h("b", null, target && selected.size ? `${(c * 100).toFixed(2)}%` : "–"),
      h("span", null, mult ? `×${mult.toFixed(2)}` : "chance"),
    );
    goBtn.disabled = spinning || !selected.size || !target || !chanceOk(c);
    if (target && selected.size && !chanceOk(c)) {
      goBtn.textContent = c > UPGRADE_MAX_CHANCE ? `Max ${UPGRADE_MAX_CHANCE * 100}% chance` : `Min ${UPGRADE_MIN_CHANCE * 100}% chance`;
    } else goBtn.textContent = "Upgrade";
  };

  // ---------- slots ----------

  const drawSlots = () => {
    const inp = inputs();
    inputSlot.replaceChildren(
      h("div", { class: "upg-label" }, "Your items"),
      inp.length
        ? h(
            "div",
            { class: "upg-stack" },
            ...inp.slice(0, 4).map((it) => h("div", { class: "upg-thumb", style: `--rarity:${getItem(it.itemId).color}` }, renderSkin({ item: getItem(it.itemId), phase: it.phase, size: "sm" }))),
          )
        : h("div", { class: "upg-empty" }, "Pick up to ", String(UPGRADE_MAX_ITEMS), " items below"),
      h("div", { class: "upg-value" }, inp.length ? `${inp.length} item${inp.length === 1 ? "" : "s"} · ${money(inputValue())}` : ""),
    );
    targetSlot.replaceChildren(
      h("div", { class: "upg-label" }, "Target"),
      target
        ? h(
            "div",
            { class: "upg-stack" },
            h("div", { class: "upg-thumb big", style: `--rarity:${getItem(target.itemId).color}` }, renderSkin({ item: getItem(target.itemId), phase: target.phase, size: "md" })),
          )
        : h("div", { class: "upg-empty" }, "Pick a target below"),
      h("div", { class: "upg-value" }, target ? `${variantName(target)} · ${money(priceOf(target))}` : ""),
    );
  };

  // ---------- lists ----------

  const drawInventory = () => {
    for (const uid of selected) if (!getState().inventory.some((it) => it.uid === uid)) selected.delete(uid);
    const inv = [...getState().inventory].sort((a, b) => priceOf(b) - priceOf(a));
    invGrid.replaceChildren(
      ...(inv.length
        ? inv.map((it) =>
            pickCard(getItem(it.itemId), it, priceOf(it), selected.has(it.uid), () => {
              if (spinning) return;
              if (selected.has(it.uid)) selected.delete(it.uid);
              else if (selected.size < UPGRADE_MAX_ITEMS) selected.add(it.uid);
              else return toast(`Up to ${UPGRADE_MAX_ITEMS} items`, "error");
              redraw();
            }),
          )
        : [h("p", { class: "empty" }, "Your inventory is empty. ", h("a", { href: "#/" }, "Open a case"), " first.")]),
    );
  };

  // Every priced variant of every item, cheapest first; rebuilt when prices move.
  let allTargets: { v: Variant; price: number; name: string }[] = [];
  const buildTargets = () => {
    allTargets = Object.values(getCatalog().items)
      .flatMap((item) => variants(item).map((v) => ({ v, price: priceOf(v), name: variantName(v).toLowerCase() })))
      .filter((t) => t.price > 0)
      .sort((a, b) => a.price - b.price);
  };

  const drawTargets = () => {
    multChips.replaceChildren(
      ...MULTIPLIERS.map((m) =>
        h(
          "button",
          {
            class: `chip${m === minMult ? " active" : ""}`,
            onclick: () => {
              minMult = m;
              drawTargets();
            },
          },
          `×${m}+`,
        ),
      ),
    );
    const value = inputValue();
    if (!value) {
      targetGrid.replaceChildren(h("p", { class: "empty" }, "Select items first; targets are priced from what you stake."));
      return;
    }
    // Only targets the chance limits allow, starting at the chosen multiplier.
    const lo = Math.max(value * minMult, (value * UPGRADE_RTP) / UPGRADE_MAX_CHANCE);
    const hi = (value * UPGRADE_RTP) / UPGRADE_MIN_CHANCE;
    const q = query.trim().toLowerCase();
    const shown: typeof allTargets = [];
    for (const t of allTargets) {
      if (t.price < lo || (q && !t.name.includes(q))) continue;
      if (t.price > hi || shown.length >= SHOW_TARGETS) break;
      shown.push(t);
    }
    targetGrid.replaceChildren(
      ...(shown.length
        ? shown.map((t) =>
            pickCard(getItem(t.v.itemId), t.v, t.price, !!target && sameVariant(target, t.v), () => {
              if (spinning) return;
              target = target && sameVariant(target, t.v) ? null : t.v;
              redraw();
            }),
          )
        : [h("p", { class: "empty" }, "Nothing matches. Try a lower multiplier or another search.")]),
    );
  };

  const redraw = () => {
    drawSlots();
    drawDial();
    drawInventory();
    drawTargets();
  };

  // ---------- spin ----------

  async function go() {
    if (spinning || !target) return;
    spinning = true;
    drawDial();
    const staked = inputs();
    const t = target;
    let result: Awaited<ReturnType<typeof upgrade>>;
    try {
      holdToastsFor(SPIN_MS + 600);
      result = await upgrade([...selected], t);
      onLeave(result.reveal); // leaving mid-spin still puts a won item in the inventory
    } catch (e) {
      spinning = false;
      drawDial();
      if (e instanceof ServerError) return toast(e.message, "error");
      throw e;
    }
    // The server only says won or lost; land the pointer somewhere that matches.
    const winDeg = result.chance * 360;
    const land = result.won ? winDeg * (0.1 + 0.8 * Math.random()) : winDeg + (360 - winDeg) * (0.05 + 0.9 * Math.random());
    dial.classList.remove("won", "lost");
    // `land` is measured from the zone's left edge; spin forward five turns and stop there.
    const stop = (((START_DEG - winDeg / 2 + land - rotation) % 360) + 360) % 360;
    rotation += 360 * 5 + stop;
    pointer.style.transition = `transform ${SPIN_MS}ms cubic-bezier(0.15, 0.85, 0.2, 1)`;
    pointer.style.transform = `rotate(${rotation}deg)`;
    await new Promise((r) => setTimeout(r, SPIN_MS + 100));

    selected.clear();
    spinning = false;
    result.reveal();
    if (result.won && result.item) {
      playReveal(getItem(result.item.itemId).tier);
      showOutcome(true, result.item, staked);
    } else showOutcome(false, null, staked);
    target = null;
    dial.classList.add(result.won ? "won" : "lost");
    landed = result.chance;
    redraw();
  }

  const outcome = h("div", { class: "result" });
  function showOutcome(won: boolean, item: OwnedItem | null, staked: OwnedItem[]) {
    const stakedValue = staked.reduce((s, it) => s + priceOf(it), 0);
    outcome.replaceChildren(
      h(
        "div",
        { class: `result-card ${won ? "tier-gold" : ""}` },
        won && item
          ? dropCard(item, { size: "lg" })
          : h("div", { class: "upg-lost" }, h("b", null, "Upgrade failed"), h("span", null, `Lost ${staked.length} item${staked.length === 1 ? "" : "s"} worth ${money(stakedValue)}`)),
        h(
          "div",
          { class: "result-actions" },
          won && item
            ? h("div", { class: "result-delta up" }, `+${money(priceOf(item) - stakedValue)}`)
            : h("div", { class: "result-delta down" }, `-${money(stakedValue)}`),
          h("a", { class: "btn btn-ghost", href: "#/inventory" }, "Inventory"),
        ),
      ),
    );
  }

  buildTargets();
  redraw();
  onLeave(subscribe(() => !spinning && (drawSlots(), drawDial(), drawInventory())));
  onPricesForPage(() => {
    buildTargets();
    if (!spinning) redraw();
  });

  return h(
    "section",
    { class: "page" },
    h("h1", null, "Upgrader"),
    h("p", { class: "hint" }, "Stake items for a pricier one. Lose and they're gone."),
    h("div", { class: "upg-top" }, inputSlot, h("div", { class: "upg-mid" }, dial, goBtn), targetSlot),
    outcome,
    h(
      "div",
      { class: "upg-cols" },
      h("div", null, h("h2", null, "Your items"), invGrid),
      h(
        "div",
        null,
        h("h2", null, "Target"),
        h(
          "div",
          { class: "toolbar" },
          h("input", {
            class: "search",
            type: "search",
            placeholder: "Search skins & stickers",
            value: query,
            oninput: (e: Event) => {
              query = (e.target as HTMLInputElement).value;
              drawTargets();
            },
          }),
          multChips,
        ),
        targetGrid,
      ),
    ),
  );
}

const sameVariant = (a: Variant, b: Variant) => a.itemId === b.itemId && a.phase === b.phase && a.wear === b.wear && a.stattrak === b.stattrak;

function variantName(v: Variant) {
  const item = getItem(v.itemId);
  const n = displayName(item, v);
  return `${n.weapon} | ${n.finish}${v.wear ? ` (${WEAR_NAME[v.wear]})` : ""}`;
}

/** Small selectable card: picture, name, price. */
function pickCard(item: Item, v: Variant | OwnedItem, price: number, active: boolean, onclick: () => void) {
  const name = displayName(item, v);
  return h(
    "button",
    { class: `pick-card${active ? " active" : ""}`, style: `--rarity:${item.color}`, onclick, title: "uid" in v ? fullName(v) : variantName(v) },
    h("div", { class: "item-art" }, renderSkin({ item, phase: v.phase, size: "sm" })),
    h("div", { class: `item-weapon${v.stattrak ? " st" : ""}` }, name.weapon),
    h("div", { class: "item-finish" }, name.finish),
    h("div", { class: "item-sub" }, v.wear ? h("span", null, v.wear) : null, h("span", { class: "item-price" }, money(price))),
  );
}
