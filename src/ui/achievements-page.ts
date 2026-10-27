import { ACHIEVEMENTS } from "../../shared/achievements.js";
import { priceOf } from "../catalog";
import { onPricesForPage } from "../live";
import { getState, subscribe } from "../state";
import { h, money } from "./dom";
import { icon, type IconName } from "./icons";
import { onLeave } from "./page";

const fmt = (n: number) => (n >= 100 ? Math.floor(n).toLocaleString("en-US") : String(Math.round(n * 100) / 100));

export function achievementsPage() {
  const grid = h("div", { class: "ach-grid" });
  const summary = h("p", { class: "hint" });

  const draw = () => {
    const a = getState();
    const subject = { ...a, inventoryValue: a.inventory.reduce((s, it) => s + priceOf(it), 0) };
    const done = ACHIEVEMENTS.filter((x) => a.achievements[x.id]);
    const earned = done.reduce((s, x) => s + x.reward, 0);
    summary.textContent = `${done.length} of ${ACHIEVEMENTS.length} unlocked, ${money(earned)} of ${money(ACHIEVEMENTS.reduce((s, x) => s + x.reward, 0))} in rewards earned.`;
    // Unlocked first (newest first), then by how close they are.
    const rows = ACHIEVEMENTS.map((x) => {
      const [have, need] = x.goal(subject);
      return { x, at: a.achievements[x.id] ?? 0, frac: Math.min(1, have / need), have, need };
    }).sort((p, q) => q.at - p.at || q.frac - p.frac);
    grid.replaceChildren(
      ...rows.map(({ x, at, frac, have, need }) =>
        h(
          "div",
          { class: `ach${at ? " done" : ""}` },
          h("div", { class: "ach-icon" }, icon(x.icon as IconName, 22)),
          h(
            "div",
            { class: "ach-body" },
            h("div", { class: "ach-name" }, x.name, at ? icon("check", 14) : ""),
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
          h("div", { class: "ach-reward" }, `+${money(x.reward)}`),
        ),
      ),
    );
  };
  onLeave(subscribe(draw));
  onPricesForPage(draw);
  draw();

  return h("section", { class: "page" }, h("h1", null, "Achievements"), summary, grid);
}
