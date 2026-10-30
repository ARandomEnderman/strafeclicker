import { serverNow } from "../live";
import { getLeaderboard, getState, ServerError } from "../state";
import { segmented } from "./bet-input";
import { h, money, mult, toast } from "./dom";
import { icon } from "./icons";
import { onLeave } from "./page";
import { gameName } from "./game-names";
import { userLink } from "./profile-card";

// Leaderboards: most wagered, biggest win and biggest loss this week (UTC) and of all
// time, and the richest players right now. The top wagerers win the prizes when the week ends.

interface Row {
  rank: number;
  user: string;
  name: string;
  value: number;
  game?: string;
  mult?: number;
}
interface Period {
  /** null for all time. */
  endsAt: number | null;
  prizes: number[];
  wagered: Row[];
  best: Row[];
  loss: Row[];
  me: { wagered: number; wageredRank: number | null; best: number; bestRank: number | null; loss: number; lossRank: number | null } | null;
  lastWinners: { user: string; name: string; wagered: number; prize: number }[];
}
interface Board {
  weekly: Period;
  alltime: Period;
  richest: { rows: (Row & { balance: number; items: number })[]; me: { rank: number; value: number } | null; updatedAt: number };
}


function left(ms: number) {
  const s = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(s / 86400);
  const hh = Math.floor((s % 86400) / 3600);
  const mm = Math.floor((s % 3600) / 60);
  return d ? `${d}d ${hh}h` : hh ? `${hh}h ${mm}m` : `${mm}m ${s % 60}s`;
}

const medal = (rank: number) => h("span", { class: `lb-rank r${rank}` }, String(rank));

function table(title: string, rows: Row[], opts: { prizes?: number[]; extra?: (r: Row) => string; empty: string }) {
  const me = getState().username;
  return h(
    "div",
    { class: "lb-card" },
    h("h2", null, title),
    rows.length
      ? h(
          "div",
          { class: "lb-rows" },
          ...rows.map((r) =>
            h(
              "div",
              { class: `lb-row${r.user === me ? " me" : ""}` },
              medal(r.rank),
              h("span", { class: "lb-name" }, userLink(r.user, r.name, { avatar: true })),
              opts.extra ? h("span", { class: "lb-extra" }, opts.extra(r)) : "",
              h("b", { class: "lb-value" }, money(r.value)),
              opts.prizes?.[r.rank - 1] ? h("span", { class: "lb-prize" }, `+${money(opts.prizes[r.rank - 1])}`) : opts.prizes ? h("span", { class: "lb-prize none" }) : "",
            ),
          ),
        )
      : h("p", { class: "empty" }, opts.empty),
  );
}

export function leaderboardPage() {
  let board: Board | null = null;
  let tab: "weekly" | "alltime" | "richest" = "weekly";
  const body = h("div", { class: "lb-body" });
  const resets = h("span", { class: "hint" });
  const tabs = segmented(
    "",
    [
      { value: "weekly", label: "This week" },
      { value: "alltime", label: "All time" },
      { value: "richest", label: "Richest" },
    ],
    tab,
    (v) => {
      tab = v as typeof tab;
      draw();
    },
  );

  const draw = () => {
    if (!board) return;
    if (tab === "richest") {
      const r = board.richest;
      resets.textContent = "Balance plus inventory value, updated every minute";
      body.replaceChildren(
        r.me ? h("p", { class: "lb-me" }, `You're #${r.me.rank} with ${money(r.me.value)}`) : "",
        table("Richest players", r.rows, { extra: (x) => `${money((x as Board["richest"]["rows"][0]).balance)} + ${money((x as Board["richest"]["rows"][0]).items)} in items`, empty: "Nobody yet." }),
      );
      return;
    }
    const p = board[tab];
    const when = tab === "weekly" ? "this week" : "yet";
    resets.textContent = p.endsAt ? `Resets in ${left(p.endsAt - serverNow())} (UTC)` : "Since the site started";
    const me = p.me;
    const mine = me
      ? [
          me.wageredRank ? `${money(me.wagered)} wagered (#${me.wageredRank})` : "",
          me.bestRank ? `biggest win ${money(me.best)} (#${me.bestRank})` : "",
          me.lossRank ? `biggest loss ${money(me.loss)} (#${me.lossRank})` : "",
        ].filter(Boolean)
      : [];
    body.replaceChildren(
      p.prizes.some((x) => x > 0)
        ? h("p", { class: "lb-prizes" }, icon("award", 16), ` Top wagerers ${when} win: `, ...p.prizes.map((x, i) => h("b", null, `#${i + 1} ${money(x)}${i < p.prizes.length - 1 ? ", " : ""}`)))
        : "",
      mine.length ? h("p", { class: "lb-me" }, `You: ${mine.join(", ")}`) : h("p", { class: "lb-me" }, `Play anything to get on the board${tab === "weekly" ? " this week" : ""}.`),
      h(
        "div",
        { class: "lb-grid" },
        table("Most wagered", p.wagered, { prizes: p.prizes, empty: `No bets ${when}${tab === "weekly" ? " yet" : ""}.` }),
        h(
          "div",
          { class: "lb-stack" },
          table("Biggest win", p.best, { extra: (r) => `${gameName(r.game ?? "")}${r.mult ? ` · ${mult(r.mult)}` : ""}`, empty: `No wins ${when}${tab === "weekly" ? " yet" : ""}.` }),
          table("Biggest loss", p.loss, { extra: (r) => gameName(r.game ?? ""), empty: `No losses ${when}${tab === "weekly" ? " yet" : ""}.` }),
        ),
      ),
      p.lastWinners.some((w) => w.prize > 0)
        ? h(
            "div",
            { class: "lb-card lb-last" },
            h("h2", null, "Last week's winners"),
            ...p.lastWinners.filter((w) => w.prize > 0).map((w, i) => h("div", { class: "lb-row" }, medal(i + 1), h("span", { class: "lb-name" }, userLink(w.user, w.name, { avatar: true })), h("span", { class: "lb-extra" }, `${money(w.wagered)} wagered`), h("b", { class: "lb-value" }, `+${money(w.prize)}`))),
          )
        : "",
    );
  };

  const load = async () => {
    try {
      board = (await getLeaderboard<Board>()).board;
      draw();
    } catch (e) {
      if (e instanceof ServerError) toast(e.message, "error");
      else throw e;
    }
  };
  void load();
  const refresh = setInterval(() => void load(), 30_000);
  const clock = setInterval(() => tab !== "richest" && board?.[tab].endsAt && (resets.textContent = `Resets in ${left(board[tab].endsAt! - serverNow())} (UTC)`), 1000);
  onLeave(() => (clearInterval(refresh), clearInterval(clock)));

  body.append(h("p", { class: "empty" }, "Loading..."));
  return h("section", { class: "page" }, h("div", { class: "ach-top" }, h("h1", null, "Leaderboards"), resets), tabs.el, body);
}
