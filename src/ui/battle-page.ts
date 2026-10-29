import { SPIN_EASING } from "./case-page";
import { battleById, onBattles, type Battle } from "../battles";
import { getCase, getItem, imageOf } from "../catalog";
import { serverNow } from "../live";
import { BATTLE_ROUND_MS, BATTLE_SPIN_MS, BATTLE_WIN_AT, battleReel } from "../odds";
import { battleAction, getState, holdToastsFor, InsufficientFunds, ServerError } from "../state";
import type { Drop, Item } from "../types";
import { h, money, toast } from "./dom";
import { displayName } from "./item-card";
import { icon } from "./icons";
import { onLeave } from "./page";
import { userLink } from "./profile-card";
import { playReveal, playTick } from "./sound";

// One battle. Every browser plays the rounds back on the same clock
// (startAt + round × BATTLE_ROUND_MS), so everyone watching sees the same reel stop at
// the same moment.

const TILE = 96; // px per reel tile
const EASING = SPIN_EASING;

function tile(item: Item, image: string) {
  return h("div", { class: "bt-tile", style: `--rarity:${item.color}` }, h("img", { src: image, alt: "", loading: "lazy" }));
}

/** A compact line for an item someone unboxed in the battle. */
function wonRow(d: Drop, value: number) {
  const item = getItem(d.itemId);
  const n = displayName(item, d);
  return h(
    "div",
    { class: "bt-won", style: `--rarity:${item.color}`, title: `${n.weapon} | ${n.finish}` },
    h("img", { src: imageOf(d), alt: "" }),
    h("div", { class: "bt-won-name" }, h("span", null, n.weapon), h("span", null, n.finish)),
    h("b", null, money(value)),
  );
}

export function battlePage(id: number) {
  const root = h("div", { class: "bt-view" });
  let builtFor = "";
  let raf = 0;
  onLeave(() => cancelAnimationFrame(raf));

  const draw = () => {
    const b = battleById(id);
    if (!b) {
      root.replaceChildren(h("p", { class: "empty" }, "This battle doesn't exist, is private, or has finished a while ago. ", h("a", { href: "#/battles" }, "Back to battles")));
      return;
    }
    // Waiting battles redraw on every change; once running, the scene is built once.
    const key = `${b.status === "waiting" ? JSON.stringify(b.slots) : "started"}`;
    if (key === builtFor) return;
    builtFor = key;
    if (b.status === "waiting") drawWaiting(b);
    else drawPlayback(b);
  };

  // ---------- waiting room ----------
  const act = async (action: "join" | "bots" | "cancel") => {
    try {
      await battleAction(action, { id });
      if (action === "cancel") location.hash = "#/battles";
    } catch (e) {
      if (e instanceof InsufficientFunds) toast("Not enough balance", "error");
      else if (e instanceof ServerError) toast(e.message, "error");
      else throw e;
    }
  };

  const header = (b: Battle, round = -1) =>
    h(
      "div",
      { class: "bt-head" },
      h("a", { class: "back", href: "#/battles" }, "Battles"),
      h("h1", null, `${Array(b.size).fill("1").join("v")} battle`),
      h(
        "div",
        { class: "bt-rounds" },
        ...b.cases.map((cid, i) =>
          h("div", { class: `bt-round${i === round ? " current" : ""}${round > i ? " past" : ""}`, title: getCase(cid)?.name }, h("img", { src: getCase(cid)?.image ?? "", alt: "" })),
        ),
      ),
      h("div", { class: "bt-meta" }, h("span", null, "Cost per player"), h("b", null, money(b.cost))),
      b.code && b.status === "waiting"
        ? h(
            "div",
            { class: "bt-meta bt-codebox" },
            h("span", null, b.visibility === "private" ? "Private, code" : "Code"),
            h("b", { class: "mono" }, b.code),
            h(
              "button",
              {
                class: "btn btn-ghost btn-sm icon-btn",
                title: "Copy invite link",
                onclick: () => {
                  const link = `${location.origin}${location.pathname}#/battles?code=${b.code}`;
                  void navigator.clipboard?.writeText(link).then(() => toast("Invite link copied"), () => toast(link));
                },
              },
              icon("copy", 14),
            ),
          )
        : b.visibility === "friends"
          ? h("div", { class: "bt-meta" }, h("span", null, "Visibility"), h("b", null, "Friends only"))
          : "",
    );

  const drawWaiting = (b: Battle) => {
    const me = getState().username;
    const seated = b.slots.some((s) => s?.user === me);
    const creator = b.creator === me;
    root.replaceChildren(
      header(b),
      h(
        "div",
        { class: "bt-cols", style: `--n:${b.size}` },
        ...b.slots.map((s) =>
          h(
            "div",
            { class: `bt-col${s ? "" : " empty"}` },
            h("div", { class: "bt-player" }, icon(s?.bot ? "box" : "user", 16), s && !s.bot ? userLink(s.user, s.name) : h("b", null, s?.name ?? "Open seat")),
            s
              ? h("div", { class: "bt-wait" }, "Ready")
              : seated
                ? h("div", { class: "bt-wait" }, "Waiting for a player")
                : h("button", { class: "btn btn-primary", onclick: () => void act("join") }, `Join for ${money(b.cost)}`),
          ),
        ),
      ),
      creator
        ? h(
            "div",
            { class: "bt-actions" },
            h("button", { class: "btn", onclick: () => void act("bots") }, icon("box", 14), " Fill with bots and start"),
            h("button", { class: "btn btn-ghost", onclick: () => confirm("Cancel this battle? Everyone gets their money back.") && void act("cancel") }, "Cancel battle"),
          )
        : "",
    );
  };

  // ---------- playback ----------
  const drawPlayback = (b: Battle) => {
    const rounds = b.rounds!;
    const n = b.size;
    const totals = Array(n).fill(0);
    const totalEls = b.slots.map(() => h("b", { class: "bt-total-val" }, money(0)));
    const winsEls = b.slots.map(() => h("div", { class: "bt-wins" }));
    const reelWraps = b.slots.map(() => h("div", { class: "bt-reel" }));
    const cols = b.slots.map((s, i) =>
      h(
        "div",
        { class: "bt-col" },
        h("div", { class: "bt-player" }, icon(s!.bot ? "box" : "user", 16), s!.bot ? h("b", null, s!.name) : userLink(s!.user, s!.name), totalEls[i]),
        reelWraps[i],
        winsEls[i],
      ),
    );
    const banner = h("div", { class: "bt-banner" });
    const headEl = header(b, 0);
    root.replaceChildren(headEl, banner, h("div", { class: "bt-cols", style: `--n:${n}` }, ...cols));

    let shown = -1; // last round whose result is on screen
    let spinning = -1;
    const reveal = (r: number) => {
      rounds[r].forEach((x, i) => {
        totals[i] += x.value;
        totalEls[i].textContent = money(totals[i]);
        winsEls[i].prepend(wonRow(x.drop, x.value));
      });
      shown = r;
    };
    const spin = (r: number, elapsed: number) => {
      const c = getCase(b.cases[r])!;
      rounds[r].forEach((x, i) => {
        // The server sends each strip (battles from before it did get one made here).
        const reel = x.reel ?? battleReel(c, x.drop.itemId, Math.random);
        const strip = h("div", { class: "bt-strip-v" });
        reel.ids.forEach((itemId, k) => {
          const item = getItem(itemId);
          strip.append(tile(item, k === BATTLE_WIN_AT ? imageOf(x.drop) : item.image));
        });
        reelWraps[i].replaceChildren(strip, h("div", { class: "bt-marker" }));
        const hgt = reelWraps[i].clientHeight || 240;
        const end = hgt / 2 - (BATTLE_WIN_AT + reel.stop) * TILE;
        const anim = strip.animate([{ transform: `translateY(${hgt / 2 - 2.5 * TILE}px)` }, { transform: `translateY(${end}px)` }], {
          duration: BATTLE_SPIN_MS,
          easing: EASING,
          fill: "forwards",
        });
        anim.currentTime = Math.min(elapsed, BATTLE_SPIN_MS);
        if (i === 0) {
          let lastTile = -1;
          const tick = () => {
            if (anim.playState !== "running") return;
            const y = new DOMMatrixReadOnly(getComputedStyle(strip).transform).m42;
            const t = Math.floor((hgt / 2 - y) / TILE);
            if (t !== lastTile) {
              if (lastTile >= 0) playTick();
              lastTile = t;
            }
            requestAnimationFrame(tick);
          };
          requestAnimationFrame(tick);
        }
      });
      spinning = r;
      headEl.querySelectorAll(".bt-round").forEach((el, k) => {
        el.classList.toggle("current", k === r);
        el.classList.toggle("past", k < r);
      });
    };

    const finish = () => {
      const w = b.winner!;
      cols.forEach((c, i) => c.classList.toggle("winner", i === w));
      cols.forEach((c, i) => c.classList.toggle("loser", i !== w));
      const pot = b.totals!.reduce((s, t) => s + t, 0);
      banner.textContent = `${b.slots[w]!.name ?? b.slots[w]!.user} wins ${money(pot)}`;
      banner.classList.add("show");
      const best = rounds.flat().reduce((x, y) => (y.value > x.value ? y : x));
      playReveal(getItem(best.drop.itemId).tier);
      if (b.slots[w]!.user === getState().username) toast(`You won the battle: ${money(pot)} in items`);
    };

    // Follow the shared clock.
    const loop = () => {
      const t = serverNow() - b.startAt!;
      const r = Math.floor(t / BATTLE_ROUND_MS);
      const into = t - r * BATTLE_ROUND_MS;
      if (t < 0) {
        banner.textContent = `Starting in ${Math.ceil(-t / 1000)}`;
        banner.classList.add("show");
      } else {
        if (banner.textContent?.startsWith("Starting")) banner.classList.remove("show");
        // Catch up on rounds that finished before we opened the page.
        for (let k = shown + 1; k < Math.min(r, rounds.length); k++) reveal(k);
        if (r < rounds.length) {
          if (spinning !== r) spin(r, into);
          if (into >= BATTLE_SPIN_MS && shown < r) reveal(r);
        } else if (!banner.classList.contains("done")) {
          banner.classList.add("done");
          finish();
          return;
        }
      }
      raf = requestAnimationFrame(loop);
    };
    // A finished battle opened later just shows the result.
    if (serverNow() > b.startAt! + rounds.length * BATTLE_ROUND_MS) {
      rounds.forEach((_, r) => reveal(r));
      reelWraps.forEach((w, i) => w.replaceChildren(h("div", { class: "bt-final" }, money(b.totals![i]))));
      banner.classList.add("done");
      finish();
    } else {
      holdToastsFor(b.startAt! + rounds.length * BATTLE_ROUND_MS - serverNow() + 500);
      raf = requestAnimationFrame(loop);
    }
  };

  onLeave(onBattles(draw));
  draw();
  return h("section", { class: "page" }, root);
}
