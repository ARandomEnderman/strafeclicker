import { ACHIEVEMENTS } from "../../shared/achievements.js";
import { priceOf } from "../catalog";
import { onPricesForPage } from "../live";
import { claimAchievement, getState, ServerError, subscribe } from "../state";
import { h, money, toast } from "./dom";
import { icon, type IconName } from "./icons";
import { onLeave } from "./page";

const fmt = (n: number) => (n >= 100 ? Math.floor(n).toLocaleString("en-US") : String(Math.round(n * 100) / 100));

export function achievementsPage() {
  const grid = h("div", { class: "ach-grid" });
  const summary = h("p", { class: "hint" });
  const claimAll = h("button", { class: "btn btn-primary", onclick: () => void claim() });
  let busy = false;

  const claim = async (id?: string) => {
    if (busy) return;
    busy = true;
    draw();
    try {
      const r = await claimAchievement(id);
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
    const a = getState();
    const subject = { ...a, inventoryValue: a.inventory.reduce((s, it) => s + priceOf(it), 0) };
    const ready = ACHIEVEMENTS.filter((x) => a.achievements[x.id] && !a.claimed[x.id]);
    const done = ACHIEVEMENTS.filter((x) => a.achievements[x.id]);
    const earned = ACHIEVEMENTS.filter((x) => a.claimed[x.id]).reduce((s, x) => s + x.reward, 0);
    summary.textContent = `${done.length} of ${ACHIEVEMENTS.length} unlocked, ${money(earned)} of ${money(ACHIEVEMENTS.reduce((s, x) => s + x.reward, 0))} in rewards collected.`;
    claimAll.hidden = ready.length < 2;
    claimAll.disabled = busy;
    claimAll.textContent = `Claim all (${money(ready.reduce((s, x) => s + x.reward, 0))})`;

    // Ready to claim first, then claimed (newest first), then by how close they are.
    const rows = ACHIEVEMENTS.map((x) => {
      const [have, need] = x.goal(subject);
      const at = a.achievements[x.id] ?? 0;
      return { x, at, claimable: !!at && !a.claimed[x.id], frac: Math.min(1, have / need), have, need };
    }).sort((p, q) => +q.claimable - +p.claimable || q.at - p.at || q.frac - p.frac);

    grid.replaceChildren(
      ...rows.map(({ x, at, claimable, frac, have, need }) =>
        h(
          "div",
          { class: `ach${at ? " done" : ""}${claimable ? " ready" : ""}` },
          h("div", { class: "ach-icon" }, icon(x.icon as IconName, 22)),
          h(
            "div",
            { class: "ach-body" },
            h("div", { class: "ach-name" }, x.name, at && !claimable ? icon("check", 14) : ""),
            h("div", { class: "ach-desc" }, x.desc),
            at
              ? h("div", { class: "ach-when" }, `Unlocked ${new Date(at).toLocaleDateString()}`)
              : h(
                  "div",
                  { class: "ach-progress" },
                  h("div", { class: "ach-bar" }, h("i", { style: `width:${(frac * 100).toFixed(1)}%` })),
                  need > 1 ? h("span", null, x.usd ? `${money(have)} / ${money(need)}` : `${fmt(have)} / ${fmt(need)}`) : "",
                ),
          ),
          claimable
            ? h("button", { class: "btn btn-primary btn-sm", disabled: busy, onclick: () => void claim(x.id) }, `Claim ${money(x.reward)}`)
            : h("div", { class: `ach-reward${at ? " got" : ""}` }, at ? "Claimed" : `+${money(x.reward)}`),
        ),
      ),
    );
  };
  onLeave(subscribe(draw));
  onPricesForPage(draw);
  draw();

  return h("section", { class: "page" }, h("div", { class: "ach-top" }, h("h1", null, "Achievements"), claimAll), summary, grid);
}
