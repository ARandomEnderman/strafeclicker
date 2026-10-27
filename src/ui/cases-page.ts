import type { Case } from "../types";
import { getCatalog, openableCases, openCost } from "../catalog";
import { onPricesForPage } from "../live";
import { h, money } from "./dom";

type Sort = "new" | "cheap" | "pricey";
let sort: Sort = "new";
let query = "";

const KINDS: { kind: Case["kind"]; label: string }[] = [
  { kind: "case", label: "Cases" },
  { kind: "capsule", label: "Sticker capsules" },
  { kind: "autograph", label: "Autograph capsules" },
];

export function casesPage(kind: Case["kind"] = "case") {
  const grid = h("div", { class: "case-grid" });

  const draw = () => {
    const cases = openableCases()
      .filter((c) => c.kind === kind && c.name.toLowerCase().includes(query.toLowerCase()))
      .map((c) => ({ c, cost: openCost(c) }));
    if (sort === "cheap") cases.sort((a, b) => a.cost - b.cost);
    if (sort === "pricey") cases.sort((a, b) => b.cost - a.cost);

    grid.replaceChildren(
      ...cases.map(({ c, cost }) =>
        h(
          "a",
          { class: "case-card", href: `#/case/${c.id}` },
          h("img", { src: c.image, alt: "", loading: "lazy" }),
          h("div", { class: "case-name" }, c.name),
          h("div", { class: "case-foot" }, h("span", { class: "case-cost" }, money(cost))),
        ),
      ),
    );
  };

  const sortBtn = (s: Sort, label: string) =>
    h(
      "button",
      {
        class: `chip${sort === s ? " active" : ""}`,
        onclick: (e: Event) => {
          sort = s;
          document.querySelectorAll(".sort .chip").forEach((b) => b.classList.toggle("active", b === e.currentTarget));
          draw();
        },
      },
      label,
    );

  draw();
  onPricesForPage(draw);
  return h(
    "section",
    { class: "page" },
    h(
      "div",
      { class: "tabs" },
      ...KINDS.map((k) =>
        h(
          "a",
          { class: `tab${k.kind === kind ? " active" : ""}`, href: `#/?kind=${k.kind}` },
          k.label,
          h("span", { class: "badge" }, openableCases().filter((c) => c.kind === k.kind).length),
        ),
      ),
    ),
    h(
      "div",
      { class: "toolbar" },
      h("input", {
        class: "search",
        type: "search",
        placeholder: kind === "case" ? "Search cases" : "Search capsules",
        value: query,
        oninput: (e: Event) => {
          query = (e.target as HTMLInputElement).value;
          draw();
        },
      }),
      h("div", { class: "sort" }, sortBtn("new", "Newest"), sortBtn("cheap", "Cheapest"), sortBtn("pricey", "Priciest")),
    ),
    h(
      "p",
      { class: "hint" },
      kind === "case"
        ? `Cost = case price + ${money(getCatalog().keyPrice)} key. Odds are Valve's published drop rates.`
        : "Capsules open without a key. Each rarity step is 1/5 as likely as the one below, like cases.",
    ),
    grid,
  );
}
