import type { PerkId } from "../../shared/game.js";
import { PERKS, perkValue } from "../odds";
import { buyPerk, displayBalance, getState, InsufficientFunds, ServerError, subscribe } from "../state";
import { h, money, toast } from "./dom";
import { onLeave } from "./page";

const BRANCHES: { id: PerkId; icon: string; format: (v: number) => string }[] = [
  { id: "multiOpen", icon: "📦", format: (v) => `Open ×${v}` },
  { id: "clickPower", icon: "👆", format: (v) => `${money(v)} / click` },
];

/** Two branches off one root; each level unlocks the next. */
export function treePage() {
  const tree = h("div", { class: "tree" });
  let buying = false;

  const draw = () => {
    const perks = getState().perks;
    tree.replaceChildren(
      h("div", { class: "tree-root" }, h("span", null, "🌱"), h("b", null, "Start")),
      h(
        "div",
        { class: "tree-branches" },
        ...BRANCHES.map(({ id, icon, format }) => {
          const perk = PERKS[id];
          const level = perks[id];
          return h(
            "div",
            { class: "tree-branch" },
            h("div", { class: "tree-branch-head" }, h("b", null, `${icon} ${perk.name}`), h("span", null, `Now: ${format(perkValue(perks, id))}`)),
            ...perk.levels.slice(1).map((lvl, i) => {
              const n = i + 1;
              const state = n <= level ? "owned" : n === level + 1 ? "next" : "locked";
              const affordable = displayBalance() >= lvl.cost;
              return h(
                "div",
                { class: `tree-node ${state}` },
                h("div", { class: "tree-node-main" }, h("b", null, format(lvl.value)), h("span", null, `Level ${n}`)),
                state === "owned"
                  ? h("span", { class: "tree-owned" }, "✓ Owned")
                  : state === "next"
                    ? h(
                        "button",
                        {
                          class: "btn btn-primary btn-sm",
                          disabled: buying || !affordable,
                          title: affordable ? "" : `Need ${money(lvl.cost - displayBalance())} more`,
                          onclick: () => buy(id, format(lvl.value)),
                        },
                        `Buy ${money(lvl.cost)}`,
                      )
                    : h("span", { class: "tree-cost" }, `🔒 ${money(lvl.cost)}`),
              );
            }),
          );
        }),
      ),
    );
  };

  async function buy(id: PerkId, label: string) {
    buying = true;
    draw();
    try {
      await buyPerk(id);
      toast(`Unlocked: ${label}`);
    } catch (e) {
      if (e instanceof InsufficientFunds) toast("Not enough balance", "error");
      else if (e instanceof ServerError) toast(e.message, "error");
      else throw e;
    } finally {
      buying = false;
      draw();
    }
  }

  onLeave(subscribe(draw));
  draw();
  return h(
    "section",
    { class: "page narrow" },
    h("h1", null, "Upgrade tree"),
    h("p", { class: "hint" }, "Spend balance to open more cases at once and earn more per click. Each level unlocks the next."),
    tree,
  );
}
