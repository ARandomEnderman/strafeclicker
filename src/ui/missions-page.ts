import { serverNow } from "../live";
import { claimMission, getState, initState, redeemPromo, ServerError, subscribe } from "../state";
import { h, money, toast } from "./dom";
import { icon } from "./icons";
import { onLeave } from "./page";

// Daily missions (three a day, reset at midnight UTC) and the promo code box.

const TIERS = ["Easy", "Medium", "Hard"];

function left(ms: number) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const hh = Math.floor(s / 3600);
  const mm = Math.floor((s % 3600) / 60);
  return hh ? `${hh}h ${mm}m` : `${mm}m ${s % 60}s`;
}

export function missionsPage() {
  const list = h("div", { class: "mission-list" });
  const resets = h("span", { class: "hint" });
  let busy = false;

  const claim = async (id?: string) => {
    if (busy) return;
    busy = true;
    try {
      const r = await claimMission(id);
      toast(`Claimed ${money(r.reward)}`);
    } catch (e) {
      if (e instanceof ServerError) toast(e.message, "error");
      else throw e;
    } finally {
      busy = false;
      draw();
    }
  };

  const draw = () => {
    const ms = getState().missions;
    list.replaceChildren(
      ...ms.list.map((m) => {
        const frac = Math.min(1, m.progress / m.target);
        const fmt = (x: number) => (m.money ? money(x) : x.toLocaleString("en-US"));
        return h(
          "div",
          { class: `mission tier${m.tier}${m.done ? " done" : ""}${m.claimed ? " claimed" : ""}` },
          h("div", { class: "mission-tier" }, TIERS[m.tier]),
          h("div", { class: "mission-label" }, m.label),
          h("div", { class: "ach-progress" }, h("div", { class: "ach-bar" }, h("i", { style: `width:${(frac * 100).toFixed(1)}%` })), h("span", null, `${fmt(m.progress)} / ${fmt(m.target)}`)),
          m.claimed
            ? h("div", { class: "mission-claimed" }, icon("check", 14), ` Claimed ${money(m.reward)}`)
            : h("button", { class: "btn btn-primary btn-sm", disabled: !m.done || busy, onclick: () => void claim(m.id) }, m.done ? `Claim ${money(m.reward)}` : `Reward ${money(m.reward)}`),
        );
      }),
    );
  };
  const tick = () => (resets.textContent = `New missions in ${left(getState().missions.resetsAt - serverNow())}`);
  let refreshing = false;
  const timer = setInterval(() => {
    tick();
    // Past midnight: fetch the new day's missions.
    if (!refreshing && serverNow() > getState().missions.resetsAt + 2000) {
      refreshing = true;
      void initState().finally(() => (refreshing = false));
    }
  }, 1000);
  onLeave(() => clearInterval(timer));
  onLeave(subscribe(draw));
  draw();
  tick();

  // ---------- promo codes ----------
  const code = h("input", { class: "search promo-input", placeholder: "Enter a promo code", maxlength: "24", autocomplete: "off" }) as HTMLInputElement;
  const redeem = async () => {
    if (!code.value.trim()) return;
    try {
      const r = await redeemPromo(code.value);
      toast(`Code redeemed: ${r.reward}`);
      code.value = "";
    } catch (e) {
      if (e instanceof ServerError) toast(e.message, "error");
      else throw e;
    }
  };
  code.addEventListener("keydown", (e) => e.key === "Enter" && void redeem());

  return h(
    "section",
    { class: "page" },
    h("div", { class: "ach-top" }, h("h1", null, "Daily missions"), resets),
    h("p", { class: "hint" }, "Three new tasks every day. Finish one and claim its reward here."),
    list,
    h(
      "div",
      { class: "promo-box" },
      h("h2", null, icon("ticket", 18), " Promo code"),
      h("div", { class: "promo-row" }, code, h("button", { class: "btn btn-primary", onclick: () => void redeem() }, "Redeem")),
    ),
  );
}
