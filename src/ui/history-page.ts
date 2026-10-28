import { betHistory, ServerError, type BetRecord } from "../state";
import { h, money } from "./dom";
import { gameName } from "./game-names";

// Your last 100 bets and case openings across every game (kept for 30 days).

const when = (t: number) => {
  const d = new Date(t);
  const today = new Date().toDateString() === d.toDateString();
  return today ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : d.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
};

export function historyPage() {
  const body = h("div", null, h("p", { class: "empty" }, "Loading..."));
  let bets: BetRecord[] = [];
  let game = "all";

  const draw = () => {
    const shown = game === "all" ? bets : bets.filter((b) => b.game === game);
    const wagered = shown.reduce((s, b) => s + b.stake, 0);
    const profit = shown.reduce((s, b) => s + b.payout - b.stake, 0);
    const wins = shown.filter((b) => b.payout > b.stake).length;
    const games = [...new Set(bets.map((b) => b.game))].sort((a, b) => gameName(a).localeCompare(gameName(b)));
    body.replaceChildren(
      h(
        "div",
        { class: "case-stats" },
        h("div", { class: "stat" }, h("span", null, "Bets"), h("b", null, shown.length)),
        h("div", { class: "stat" }, h("span", null, "Wagered"), h("b", null, money(wagered))),
        h("div", { class: "stat" }, h("span", null, "Profit"), h("b", { class: profit >= 0 ? "up" : "down" }, `${profit >= 0 ? "+" : "-"}${money(Math.abs(profit))}`)),
        h("div", { class: "stat" }, h("span", null, "Won"), h("b", null, shown.length ? `${Math.round((wins / shown.length) * 100)}%` : "-")),
      ),
      h(
        "div",
        { class: "toolbar" },
        h(
          "select",
          {
            class: "search hist-game",
            onchange: (e: Event) => {
              game = (e.target as HTMLSelectElement).value;
              draw();
            },
          },
          h("option", { value: "all" }, "All games"),
          ...games.map((g) => h("option", { value: g, selected: g === game }, gameName(g))),
        ),
        h("button", { class: "btn btn-sm", onclick: () => void load() }, "Refresh"),
      ),
      shown.length
        ? h(
            "div",
            { class: "hist-wrap" },
            h(
              "table",
              { class: "hist-table" },
              h("thead", null, h("tr", null, h("th", null, "Time"), h("th", null, "Game"), h("th", null, "Bet"), h("th", null, "Multiplier"), h("th", null, "Payout"), h("th", null, "Profit"))),
              h(
                "tbody",
                null,
                ...shown.map((b) => {
                  const p = b.payout - b.stake;
                  return h(
                    "tr",
                    null,
                    h("td", { class: "hist-time" }, when(b.at)),
                    h("td", null, gameName(b.game), b.n > 1 ? h("span", { class: "hist-n" }, ` x${b.n}`) : ""),
                    h("td", null, money(b.stake)),
                    h("td", null, `${(b.payout / b.stake).toFixed(2)}x`),
                    h("td", null, money(b.payout)),
                    h("td", { class: p > 0 ? "up" : p < 0 ? "down" : "" }, `${p >= 0 ? "+" : "-"}${money(Math.abs(p))}`),
                  );
                }),
              ),
            ),
          )
        : h("p", { class: "empty" }, bets.length ? "No bets in that game." : "No bets yet. Play something and it shows up here."),
    );
  };

  const load = async () => {
    try {
      bets = await betHistory(100);
      draw();
    } catch (e) {
      if (e instanceof ServerError) body.replaceChildren(h("p", { class: "empty" }, e.message));
      else throw e;
    }
  };
  void load();

  return h("section", { class: "page" }, h("h1", null, "Bet history"), h("p", { class: "hint" }, "Your last 100 bets and case openings across every game. Case openings count their items at market value."), body);
}
