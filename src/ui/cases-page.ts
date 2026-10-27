import { caseEV, getCatalog, openCost } from "../catalog";
import { h, money } from "./dom";

type Sort = "new" | "cheap" | "pricey" | "rtp";
let sort: Sort = "new";
let query = "";

export function casesPage() {
  const grid = h("div", { class: "case-grid" });

  const draw = () => {
    const cases = getCatalog()
      .cases.filter((c) => c.name.toLowerCase().includes(query.toLowerCase()))
      .map((c) => ({ c, cost: openCost(c), rtp: caseEV(c) / openCost(c) }));
    if (sort === "cheap") cases.sort((a, b) => a.cost - b.cost);
    if (sort === "pricey") cases.sort((a, b) => b.cost - a.cost);
    if (sort === "rtp") cases.sort((a, b) => b.rtp - a.rtp);

    grid.replaceChildren(
      ...cases.map(({ c, cost, rtp }) =>
        h(
          "a",
          { class: "case-card", href: `#/case/${c.id}` },
          h("img", { src: c.image, alt: "", loading: "lazy" }),
          h("div", { class: "case-name" }, c.name),
          h(
            "div",
            { class: "case-foot" },
            h("span", { class: "case-cost" }, money(cost)),
            h("span", { class: "case-rtp", title: "Expected value ÷ cost to open" }, `RTP ${(rtp * 100).toFixed(0)}%`),
          ),
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
  return h(
    "section",
    { class: "page" },
    h(
      "div",
      { class: "toolbar" },
      h("h1", null, "Cases"),
      h("input", {
        class: "search",
        type: "search",
        placeholder: "Search cases",
        value: query,
        oninput: (e: Event) => {
          query = (e.target as HTMLInputElement).value;
          draw();
        },
      }),
      h("div", { class: "sort" }, sortBtn("new", "Newest"), sortBtn("cheap", "Cheapest"), sortBtn("pricey", "Priciest"), sortBtn("rtp", "Best RTP")),
    ),
    h("p", { class: "hint" }, `Cost = case price + ${money(getCatalog().keyPrice)} key. Odds are Valve's published drop rates.`),
    grid,
  );
}
