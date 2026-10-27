import { getItem, priceOf, round2 } from "../catalog";
import { getState, sell } from "../state";
import { h, money, toast } from "./dom";
import { dropCard } from "./item-card";

type Sort = "new" | "value";
let sort: Sort = "new";

export function inventoryPage() {
  const body = h("div");
  const draw = () => {
    const inv = [...getState().inventory];
    if (sort === "value") inv.sort((a, b) => priceOf(b) - priceOf(a));
    const total = round2(inv.reduce((s, it) => s + priceOf(it), 0));
    const { stats } = getState();

    body.replaceChildren(
      h(
        "div",
        { class: "case-stats" },
        h("div", { class: "stat" }, h("span", null, "Items"), h("b", null, inv.length)),
        h("div", { class: "stat" }, h("span", null, "Inventory value"), h("b", null, money(total))),
        h("div", { class: "stat" }, h("span", null, "Cases opened"), h("b", null, stats.opened)),
        h("div", { class: "stat" }, h("span", null, "Spent"), h("b", null, money(stats.spent))),
        h("div", { class: "stat" }, h("span", null, "Unboxed value"), h("b", null, money(stats.unboxedValue))),
        stats.best ? h("div", { class: "stat" }, h("span", null, "Best pull"), h("b", null, `${stats.best.name} · ${money(stats.best.value)}`)) : null,
      ),
      h(
        "div",
        { class: "toolbar" },
        h("div", { class: "sort" }, sortBtn("new", "Newest"), sortBtn("value", "Value")),
        inv.length
          ? h(
              "button",
              {
                class: "btn",
                onclick: () => {
                  if (!confirm(`Sell all ${inv.length} items for ${money(total)}?`)) return;
                  toast(`Sold everything for ${money(sell(inv.map((i) => i.uid)))}`);
                  draw();
                },
              },
              `Sell all · ${money(total)}`,
            )
          : null,
      ),
      inv.length
        ? h(
            "div",
            { class: "item-grid inv" },
            ...inv.map((it) =>
              dropCard(it, {
                extra: h(
                  "button",
                  {
                    class: "btn btn-sm",
                    title: `Seed ${it.seed} · nonce ${it.proof.nonce}`,
                    onclick: () => {
                      toast(`Sold ${getItem(it.itemId).name} for ${money(sell([it.uid]))}`);
                      draw();
                    },
                  },
                  "Sell",
                ),
              }),
            ),
          )
        : h("p", { class: "empty" }, "Nothing here yet. ", h("a", { href: "#/" }, "Open a case"), "."),
    );
  };

  const sortBtn = (s: Sort, label: string) =>
    h(
      "button",
      {
        class: `chip${sort === s ? " active" : ""}`,
        onclick: () => {
          sort = s;
          draw();
        },
      },
      label,
    );

  draw();
  return h("section", { class: "page" }, h("h1", null, "Inventory"), body);
}
