import { getItem, imageOf, priceOf, round2 } from "../catalog";
import { jackpotState, onJackpot, type JackpotState } from "../jackpot";
import { serverNow } from "../live";
import { JP_MAX_ITEMS, JP_MIN_DEPOSIT, JP_SPIN_MS, JP_TIMER_MS } from "../odds";
import { getState, InsufficientFunds, jackpotAction, ServerError, subscribe } from "../state";
import { h, money, toast } from "./dom";
import { displayName } from "./item-card";
import { onLeave } from "./page";
import { avatar, hue, userLink } from "./profile-card";
import { playReveal, playTick } from "./sound";

// Jackpot: one pot for everyone, a wheel with a slice per deposit (in ticket order).
// The wheel stops with the winning ticket under the pointer, on every screen.

const SVG = "http://www.w3.org/2000/svg";
const R = 150;
const SPINS = 6;
const EASING = "cubic-bezier(0.12, 0.8, 0.2, 1)";

function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>) {
  const el = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
}

/** A pie slice from angle a0 to a1 (degrees, clockwise from the top). */
function slice(a0: number, a1: number, color: string) {
  const rad = (a: number) => ((a - 90) * Math.PI) / 180;
  if (a1 - a0 >= 359.99) return svg("circle", { cx: 0, cy: 0, r: R, fill: color });
  const [x0, y0] = [Math.cos(rad(a0)) * R, Math.sin(rad(a0)) * R];
  const [x1, y1] = [Math.cos(rad(a1)) * R, Math.sin(rad(a1)) * R];
  return svg("path", { d: `M0 0 L${x0} ${y0} A${R} ${R} 0 ${a1 - a0 > 180 ? 1 : 0} 1 ${x1} ${y1} Z`, fill: color, stroke: "#0d0f14", "stroke-width": 2 });
}

export function jackpotPage() {
  // ---------- wheel ----------
  const wheel = svg("g", {});
  const root = svg("svg", { viewBox: `${-R - 10} ${-R - 20} ${2 * R + 20} ${2 * R + 30}`, class: "jp-svg" });
  root.append(wheel, svg("path", { d: `M-12 ${-R - 16} L12 ${-R - 16} L0 ${-R + 8} Z`, class: "jp-pointer" }));
  const center = h("div", { class: "jp-center" });
  const wheelBox = h("div", { class: "jp-wheel" }, root, center);

  let anim: Animation | null = null;
  let animRound = -1;
  const drawWheel = (s: JackpotState) => {
    wheel.replaceChildren();
    if (!s.total) {
      wheel.append(svg("circle", { cx: 0, cy: 0, r: R, class: "jp-empty" }));
    } else {
      let a = 0;
      for (const d of s.deposits) {
        const da = (d.value / s.total) * 360;
        wheel.append(slice(a, a + da, `hsl(${hue(d.user)} 55% 45%)`));
        a += da;
      }
    }
    wheel.append(svg("circle", { cx: 0, cy: 0, r: R * 0.62, class: "jp-hole" }));
    if ((s.phase === "spinning" || s.phase === "result") && s.ticket != null && animRound !== s.round) {
      animRound = s.round;
      const end = SPINS * 360 - (s.ticket / s.total) * 360;
      anim?.cancel();
      anim = wheel.animate([{ transform: "rotate(0deg)" }, { transform: `rotate(${end}deg)` }], { duration: JP_SPIN_MS, easing: EASING, fill: "forwards" });
      anim.currentTime = Math.min(JP_SPIN_MS, Math.max(0, serverNow() - (s.spinAt ?? 0)));
      let last = -1;
      const tick = () => {
        if (!anim || anim.playState !== "running") return;
        const deg = Number(anim.currentTime ?? 0) / JP_SPIN_MS;
        const step = Math.floor((anim.effect?.getComputedTiming().progress ?? deg) * end / 15);
        if (step !== last) {
          if (last >= 0) playTick();
          last = step;
        }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    } else if (s.phase === "waiting" || s.phase === "open") {
      anim?.cancel();
      anim = null;
      animRound = -1;
    }
  };

  // ---------- deposit ----------
  const picked = new Set<string>();
  const grid = h("div", { class: "trade-grid jp-grid" });
  const depositBtn = h("button", { class: "btn btn-primary", onclick: () => void deposit() });
  const withdrawBtn = h("button", { class: "btn btn-ghost", onclick: () => void withdraw() }, "Take my items back");
  const drawDeposit = () => {
    const s = jackpotState();
    const open = !!s && (s.phase === "waiting" || s.phase === "open");
    const inv = getState().inventory.filter((it) => !it.locked).sort((a, b) => priceOf(b) - priceOf(a));
    for (const uid of [...picked]) if (!inv.some((it) => it.uid === uid)) picked.delete(uid);
    grid.replaceChildren(
      ...(inv.length
        ? inv.map((it) => {
            const item = getItem(it.itemId);
            const n = displayName(item, it);
            return h(
              "button",
              {
                type: "button",
                class: `trade-item${picked.has(it.uid) ? " selected" : ""}`,
                style: `--rarity:${item.color}`,
                onclick: () => {
                  if (picked.has(it.uid)) picked.delete(it.uid);
                  else if (picked.size >= JP_MAX_ITEMS) return toast(`Up to ${JP_MAX_ITEMS} items per deposit`, "error");
                  else picked.add(it.uid);
                  drawDeposit();
                },
              },
              h("img", { src: imageOf(it), alt: "", loading: "lazy" }),
              h("span", { class: "trade-item-name" }, n.weapon),
              h("span", { class: "trade-item-finish" }, `${n.finish}${it.wear ? ` · ${it.wear}` : ""}`),
              h("b", null, money(priceOf(it))),
            );
          })
        : [h("p", { class: "fb-empty" }, "Your inventory is empty. Open some cases first.")]),
    );
    const value = round2(inv.filter((it) => picked.has(it.uid)).reduce((x, it) => x + priceOf(it), 0));
    depositBtn.textContent = picked.size ? `Deposit ${picked.size} item${picked.size === 1 ? "" : "s"} (${money(value)})` : "Pick items to deposit";
    depositBtn.disabled = !open || !picked.size || value < JP_MIN_DEPOSIT;
    withdrawBtn.hidden = !(s?.phase === "waiting" && s.players.some((p) => p.user === getState().username));
  };

  const deposit = async () => {
    try {
      await jackpotAction({ uids: [...picked] });
      picked.clear();
      drawDeposit();
    } catch (e) {
      if (e instanceof InsufficientFunds) toast("Not enough balance", "error");
      else if (e instanceof ServerError) toast(e.message, "error");
      else throw e;
    }
  };
  const withdraw = async () => {
    try {
      await jackpotAction({ action: "withdraw" });
    } catch (e) {
      if (e instanceof ServerError) toast(e.message, "error");
      else throw e;
    }
  };

  // ---------- players + history ----------
  const players = h("div", { class: "jp-players" });
  const history = h("div", { class: "jp-history" });
  const drawPlayers = (s: JackpotState) => {
    const me = getState().username;
    const done = s.phase === "result";
    players.replaceChildren(
      h("div", { class: "fb-players-head" }, h("b", null, `${s.players.length} player${s.players.length === 1 ? "" : "s"} · ${s.players.reduce((x, p) => x + p.items.length, 0)} items`), h("span", null, money(s.total))),
      ...(s.players.length
        ? [...s.players]
            .sort((a, b) => b.value - a.value)
            .map((p) =>
              h(
                "div",
                { class: `jp-player${p.user === me ? " me" : ""}${done && p.user === s.winner ? " winner" : ""}`, style: `--h:${hue(p.user)}` },
                h("div", { class: "jp-player-head" }, avatar(p.user, p.name, 28), userLink(p.user, p.name), h("b", null, money(p.value)), h("span", { class: "jp-chance" }, `${(p.chance * 100).toFixed(1)}%`)),
                h("div", { class: "jp-items" }, ...p.items.map((it) => h("img", { src: imageOf(it), alt: "", title: `${getItem(it.itemId).name} · ${money(it.value)}`, style: `--rarity:${getItem(it.itemId).color}` }))),
              ),
            )
        : [h("p", { class: "fb-empty" }, "The pot is empty. Be the first in.")]),
    );
    history.replaceChildren(
      ...(s.history.length ? [h("div", { class: "fb-players-head" }, h("b", null, "Recent winners"))] : []),
      ...s.history.map((r) => h("div", { class: "jp-hist" }, userLink(r.user, r.name), h("span", null, `${r.chance.toFixed(1)}% chance`), h("b", null, money(r.pot)))),
    );
  };

  // ---------- centre text + clock ----------
  const big = h("div", { class: "jp-pot" });
  const sub = h("div", { class: "jp-sub" });
  center.append(sub, big);
  let raf = 0;
  let revealed = -1;
  const loop = () => {
    const s = jackpotState();
    if (s) {
      if (s.phase === "waiting") {
        sub.textContent = s.players.length ? "Waiting for a second player" : "Waiting for deposits";
        big.textContent = money(s.total);
      } else if (s.phase === "open") {
        const left = Math.max(0, (s.endsAt ?? 0) - serverNow());
        sub.textContent = `Spinning in ${(left / 1000).toFixed(1)}s`;
        big.textContent = money(s.total);
        wheelBox.style.setProperty("--left", String(left / JP_TIMER_MS));
      } else {
        const landed = s.phase === "result" || serverNow() - (s.spinAt ?? 0) >= JP_SPIN_MS;
        const w = s.players.find((p) => p.user === s.winner);
        sub.textContent = landed && w ? `${w.name} wins with ${(w.chance * 100).toFixed(1)}%` : "Spinning...";
        big.textContent = money(s.total);
        if (landed && revealed !== s.round) {
          revealed = s.round;
          if (w?.user === getState().username) {
            playReveal("gold");
            toast(`You won the jackpot: ${money(s.total)} in items`);
          }
        }
      }
      wheelBox.classList.toggle("timing", s.phase === "open");
    }
    raf = requestAnimationFrame(loop);
  };
  raf = requestAnimationFrame(loop);
  onLeave(() => cancelAnimationFrame(raf));

  const onState = (s: JackpotState) => {
    drawWheel(s);
    drawPlayers(s);
    drawDeposit();
  };
  onLeave(onJackpot(onState));
  onLeave(subscribe(drawDeposit));
  const s0 = jackpotState();
  if (s0) onState(s0);
  drawDeposit();

  return h(
    "section",
    { class: "page game-page" },
    h("h1", null, "Jackpot"),
    h("p", { class: "hint" }, "Throw skins into the pot. The more you put in, the better your odds. The winner takes everything."),
    h(
      "div",
      { class: "jp-layout" },
      h("div", { class: "game-stage jp-stage" }, wheelBox, history),
      h("div", { class: "jp-side" }, players),
    ),
    h(
      "div",
      { class: "bt-create jp-deposit" },
      h("div", { class: "bt-create-head" }, h("b", null, "Deposit"), h("span", { class: "bt-limit" }, `Up to ${JP_MAX_ITEMS} items at a time, at least ${money(JP_MIN_DEPOSIT)}`)),
      h("div", { class: "trade-actions" }, withdrawBtn, depositBtn),
      grid,
    ),
  );
}
