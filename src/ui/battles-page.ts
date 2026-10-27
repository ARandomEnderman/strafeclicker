import { battles, onBattles, type Battle } from "../battles";
import { getCase, openableCases, openCost, round2 } from "../catalog";
import { BATTLE_SIZES, PERKS, perkValue } from "../odds";
import { battleAction, displayBalance, getState, InsufficientFunds, ServerError } from "../state";
import { segmented } from "./bet-input";
import { h, money, toast } from "./dom";
import { icon } from "./icons";
import { onLeave } from "./page";

// Lobby: open battles to join, running ones to watch, and the form to start one.

type Visibility = Battle["visibility"];
export const VISIBILITY_LABEL: Record<Visibility, string> = { public: "Public", friends: "Friends only", private: "Private" };

/** @param code a join code from a shared link (#/battles?code=...) */
export function battlesPage(code: string | null = null) {
  const list = h("div", { class: "battle-list" });

  // ---------- create ----------
  let picked: string[] = [];
  let size = 2;
  let visibility: Visibility = "public";
  let query = "";
  const pickedEl = h("div", { class: "bt-picked" });
  const limitEl = h("span", { class: "bt-limit" });
  const costEl = h("b");
  const createBtn = h("button", { class: "btn btn-primary", onclick: () => void create() });
  const grid = h("div", { class: "bt-case-grid" });
  const search = h("input", { class: "search", placeholder: "Search cases and capsules", oninput: (e: Event) => ((query = (e.target as HTMLInputElement).value), drawGrid()) });

  /** Most cases this player may put in a battle (the Battle size upgrade). */
  const maxCases = () => perkValue(getState().perks, "battleRounds");
  const cost = () => round2(picked.reduce((s, id) => s + openCost(getCase(id)!), 0));
  const drawPicked = () => {
    pickedEl.replaceChildren(
      ...(picked.length
        ? picked.map((id, i) =>
            h(
              "button",
              { class: "bt-pick", title: `Remove ${getCase(id)!.name}`, onclick: () => (picked.splice(i, 1), drawPicked()) },
              h("img", { src: getCase(id)!.image, alt: "" }),
              h("span", null, money(openCost(getCase(id)!))),
            ),
          )
        : [h("div", { class: "fb-empty" }, `Add up to ${maxCases()} cases from the list below, one per round.`)]),
    );
    const next = PERKS.battleRounds.levels[getState().perks.battleRounds + 1];
    limitEl.replaceChildren(
      `${picked.length} / ${maxCases()} cases`,
      ...(next ? [" · ", h("a", { href: "#/tree" }, `Upgrade to ${next.value}`)] : []),
    );
    costEl.textContent = money(cost());
    createBtn.textContent = picked.length ? `Create for ${money(cost())}` : "Create battle";
    createBtn.disabled = !picked.length || cost() > displayBalance();
  };
  const drawGrid = () => {
    const q = query.toLowerCase();
    grid.replaceChildren(
      ...openableCases()
        .filter((c) => c.name.toLowerCase().includes(q))
        .slice(0, 60)
        .map((c) =>
          h(
            "button",
            {
              class: "bt-case",
              title: c.name,
              onclick: () => {
                if (picked.length >= maxCases()) {
                  const next = PERKS.battleRounds.levels[getState().perks.battleRounds + 1];
                  return toast(next ? `Up to ${maxCases()} cases. Battle size in the upgrade tree raises it to ${next.value}.` : `Up to ${maxCases()} cases`, "error");
                }
                picked.push(c.id);
                drawPicked();
              },
            },
            h("img", { src: c.image, alt: "", loading: "lazy" }),
            h("span", { class: "bt-case-name" }, c.name),
            h("span", { class: "bt-case-cost" }, money(openCost(c))),
          ),
        ),
    );
  };
  const sizeSeg = segmented<number>(
    "Players",
    BATTLE_SIZES.map((n) => ({ value: n, label: Array(n).fill("1").join("v") })),
    size,
    (v) => (size = v),
  );

  const visSeg = segmented<Visibility>(
    "Who can join",
    (["public", "friends", "private"] as Visibility[]).map((v) => ({ value: v, label: v === "friends" ? "Friends" : VISIBILITY_LABEL[v] })),
    visibility,
    (v) => (visibility = v),
  );

  const create = async () => {
    try {
      const { id } = await battleAction("create", { cases: picked, size, visibility });
      picked = [];
      drawPicked();
      location.hash = `#/battles/${id}`;
    } catch (e) {
      if (e instanceof InsufficientFunds) toast("Not enough balance", "error");
      else if (e instanceof ServerError) toast(e.message, "error");
      else throw e;
    }
  };

  // ---------- list ----------
  const card = (b: Battle) => {
    const me = getState().username;
    const seated = b.slots.filter(Boolean).length;
    const mine = b.slots.some((s) => s?.user === me);
    const caseStrip = h(
      "div",
      { class: "bt-strip" },
      ...b.cases.slice(0, 6).map((id) => h("img", { src: getCase(id)?.image ?? "", alt: "", title: getCase(id)?.name ?? id })),
      b.cases.length > 6 ? h("span", { class: "bt-more" }, `+${b.cases.length - 6}`) : "",
    );
    const status =
      b.status === "waiting" ? `${seated}/${b.size} players` : b.status === "running" ? "In progress" : `Won by ${b.slots[b.winner!]?.user ?? "?"}`;
    return h(
      "a",
      { class: `bt-card ${b.status}${mine ? " mine" : ""}`, href: `#/battles/${b.id}` },
      h(
        "div",
        { class: "bt-card-head" },
        h("b", null, `${Array(b.size).fill("1").join("v")}`),
        h("span", null, `${b.cases.length} round${b.cases.length === 1 ? "" : "s"} · by ${b.creator}`),
        b.visibility !== "public" ? h("span", { class: "bt-vis" }, icon(b.visibility === "friends" ? "friends" : "lock", 12), VISIBILITY_LABEL[b.visibility]) : "",
      ),
      caseStrip,
      h("div", { class: "bt-card-foot" }, h("span", { class: "bt-cost" }, money(b.cost)), h("span", { class: `bt-status ${b.status}` }, status)),
    );
  };
  const draw = () => {
    const all = battles();
    const groups: [string, Battle[]][] = [
      ["Open", all.filter((b) => b.status === "waiting")],
      ["In progress", all.filter((b) => b.status === "running")],
      ["Finished", all.filter((b) => b.status === "done")],
    ];
    list.replaceChildren(
      ...groups.flatMap(([title, bs]) => (bs.length ? [h("h2", null, title), h("div", { class: "bt-grid" }, ...bs.map(card))] : [])),
      ...(all.length ? [] : [h("p", { class: "empty" }, "No battles yet. Create one.")]),
    );
  };
  // ---------- join with a code ----------
  const codeInput = h("input", { class: "search code-field", placeholder: "Code", maxlength: "6", value: code ?? "", "aria-label": "Battle code" }) as HTMLInputElement;
  const joinCode = async () => {
    const c = codeInput.value.trim();
    if (!c) return;
    try {
      const { id } = await battleAction("join", { code: c });
      location.hash = `#/battles/${id}`;
    } catch (e) {
      if (e instanceof InsufficientFunds) toast("Not enough balance", "error");
      else if (e instanceof ServerError) toast(e.message, "error");
      else throw e;
    }
  };
  const codeForm = h(
    "form",
    { class: "bt-code", onsubmit: (e: Event) => (e.preventDefault(), void joinCode()) },
    h("span", { class: "field-label" }, "Got a code for a private battle?"),
    codeInput,
    h("button", { class: "btn", type: "submit" }, "Join"),
  );

  onLeave(onBattles(draw));
  draw();
  drawGrid();
  drawPicked();

  return h(
    "section",
    { class: "page" },
    h("h1", null, "Case battles"),
    h("p", { class: "hint" }, "Everyone opens the same cases, one per round. The highest total value takes every item. Bots can fill empty seats."),
    codeForm,
    h(
      "div",
      { class: "bt-create" },
      h("div", { class: "bt-create-head" }, icon("battles", 18), h("b", null, "New battle"), limitEl),
      pickedEl,
      h("div", { class: "bt-create-row" }, sizeSeg.el, visSeg.el, h("div", { class: "bt-total" }, h("span", null, "Cost per player"), costEl), createBtn),
      search,
      grid,
    ),
    list,
  );
}
