import { flipById, flips, onFlips, type Flip, type FlipPlayer } from "../flips";
import { serverNow } from "../live";
import { FLIP_MS } from "../odds";
import { coinflipAction, getState, InsufficientFunds, ServerError } from "../state";
import { betInput, segmented } from "./bet-input";
import { h, money, toast } from "./dom";
import { icon } from "./icons";
import { onLeave } from "./page";
import { avatar, userLink } from "./profile-card";
import { playReveal, playTick } from "./sound";

// Coinflip lobby (#/coinflip) and one flip (#/coinflip/<id>). The coin follows the
// server's clock, so both players see it land at the same moment.

type Side = "t" | "ct";
type Visibility = Flip["visibility"];
const SIDE_NAME: Record<Side, string> = { t: "T", ct: "CT" };
const other = (s: Side): Side => (s === "t" ? "ct" : "t");
const SPINS = 8;

const act = async (action: "create" | "join" | "bot" | "cancel", body: object) => {
  try {
    return await coinflipAction(action, body);
  } catch (e) {
    if (e instanceof InsufficientFunds) toast("Not enough balance", "error");
    else if (e instanceof ServerError) toast(e.message, "error");
    else throw e;
    return null;
  }
};

function coin(size: number) {
  return h(
    "div",
    { class: "coin", style: `--size:${size}px` },
    h("div", { class: "coin-face t" }, "T"),
    h("div", { class: "coin-face ct" }, "CT"),
  );
}

const playerEl = (p: FlipPlayer | null, side: Side) =>
  h(
    "div",
    { class: `cf-player ${side}` },
    p ? avatar(p.user, p.name, 36) : h("span", { class: "avatar cf-empty" }, "?"),
    h("div", { class: "cf-player-names" }, p ? (p.bot ? h("b", null, p.name) : userLink(p.user, p.name)) : h("b", { class: "cf-waiting" }, "Waiting..."), h("span", { class: `cf-side ${side}` }, SIDE_NAME[side])),
  );

// ---------- lobby ----------

export function coinflipPage(code: string | null = null) {
  const list = h("div", { class: "cf-list" });
  const bet = betInput();
  let side: Side = "t";
  let visibility: Visibility = "public";
  const sideSeg = segmented<Side>("Your side", [{ value: "t", label: "T" }, { value: "ct", label: "CT" }], side, (v) => (side = v));
  const visSeg = segmented<Visibility>(
    "Who can join",
    [
      { value: "public", label: "Public" },
      { value: "friends", label: "Friends" },
      { value: "private", label: "Private" },
    ],
    visibility,
    (v) => (visibility = v),
  );
  const create = async () => {
    const r = await act("create", { bet: bet.value(), side, visibility });
    if (r) location.hash = `#/coinflip/${r.id}`;
  };

  const codeInput = h("input", { class: "search code-field", placeholder: "Code", maxlength: "6", value: code ?? "", "aria-label": "Coinflip code" }) as HTMLInputElement;
  const codeForm = h(
    "form",
    {
      class: "bt-code",
      onsubmit: async (e: Event) => {
        e.preventDefault();
        if (!codeInput.value.trim()) return;
        const r = await act("join", { code: codeInput.value.trim() });
        if (r) location.hash = `#/coinflip/${r.id}`;
      },
    },
    h("span", { class: "field-label" }, "Got a code for a private coinflip?"),
    codeInput,
    h("button", { class: "btn", type: "submit" }, "Join"),
  );

  const card = (f: Flip) => {
    const me = getState().username;
    const mine = f.creator.user === me;
    const inIt = mine || f.joiner?.user === me;
    const won = f.status === "done" ? (f.winner === "creator" ? f.creator : f.joiner) : null;
    let action: HTMLElement;
    if (f.status === "waiting" && mine) action = h("a", { class: "btn btn-sm", href: `#/coinflip/${f.id}` }, "Open");
    else if (f.status === "waiting") action = h("button", { class: "btn btn-primary btn-sm", onclick: async () => (await act("join", { id: f.id })) && (location.hash = `#/coinflip/${f.id}`) }, `Join as ${SIDE_NAME[other(f.side)]}`);
    else action = h("a", { class: "btn btn-sm", href: `#/coinflip/${f.id}` }, f.status === "flipping" ? "Watch" : "View");
    return h(
      "div",
      { class: `cf-card ${f.status}${inIt ? " mine" : ""}` },
      playerEl(f.creator, f.side),
      h("div", { class: "cf-mid" }, h("b", { class: "cf-stake" }, money(f.stake * 2)), h("span", null, won ? `${won.name} won` : f.status === "flipping" ? "Flipping..." : f.visibility !== "public" ? (f.visibility === "friends" ? "Friends only" : "Private") : "Open")),
      playerEl(f.joiner, other(f.side)),
      action,
    );
  };

  const draw = () => {
    const all = flips();
    const open = all.filter((f) => f.status !== "done");
    const done = all.filter((f) => f.status === "done");
    list.replaceChildren(
      h("h2", null, "Open"),
      ...(open.length ? open.map(card) : [h("p", { class: "fb-empty" }, "No open coinflips. Start one.")]),
      ...(done.length ? [h("h2", null, "Recent"), ...done.map(card)] : []),
    );
  };
  onLeave(onFlips(draw));
  draw();

  return h(
    "section",
    { class: "page" },
    h("h1", null, "Coinflip"),
    h("p", { class: "hint" }, "Stake an amount on T or CT. Whoever joins matches it and gets the other side; the winner takes both. No house cut."),
    codeForm,
    h(
      "div",
      { class: "bt-create" },
      h("div", { class: "bt-create-head" }, icon("coins", 18), h("b", null, "New coinflip")),
      h("div", { class: "bt-create-row" }, h("div", { class: "cf-bet" }, bet.el), sideSeg.el, visSeg.el, h("button", { class: "btn btn-primary", onclick: () => void create() }, "Create")),
    ),
    list,
  );
}

// ---------- one flip ----------

export function coinflipView(id: number) {
  const root = h("div", { class: "cf-view" });
  let builtFor = "";
  let raf = 0;
  onLeave(() => cancelAnimationFrame(raf));

  const draw = () => {
    const f = flipById(id);
    if (!f) {
      root.replaceChildren(h("p", { class: "empty" }, "This coinflip doesn't exist, is private, or was cancelled. ", h("a", { href: "#/coinflip" }, "Back to coinflips")));
      return;
    }
    const key = f.status === "waiting" ? `w${f.joiner?.user ?? ""}` : "flip";
    if (key === builtFor) return;
    builtFor = key;
    const me = getState().username;
    const mine = f.creator.user === me;
    const c = coin(160);
    const banner = h("div", { class: "cf-banner" });
    const actions =
      f.status === "waiting"
        ? mine
          ? [
              h("button", { class: "btn", onclick: () => void act("bot", { id }) }, icon("box", 14), " Call a bot"),
              h("button", { class: "btn btn-ghost", onclick: () => confirm("Cancel this coinflip? You get your stake back.") && void act("cancel", { id }).then((r) => r && (location.hash = "#/coinflip")) }, "Cancel"),
            ]
          : [h("button", { class: "btn btn-primary", onclick: () => void act("join", { id }) }, `Join as ${SIDE_NAME[other(f.side)]} for ${money(f.stake)}`)]
        : [];
    root.replaceChildren(
      h("a", { class: "back", href: "#/coinflip" }, "Coinflips"),
      h(
        "div",
        { class: "cf-stage" },
        playerEl(f.creator, f.side),
        h("div", { class: "cf-center" }, c, h("div", { class: "cf-pot" }, money(f.stake * 2)), banner),
        playerEl(f.joiner, other(f.side)),
      ),
      ...(f.code && f.status === "waiting" ? [h("div", { class: "bt-meta bt-codebox cf-code" }, h("span", null, "Private, code"), h("b", { class: "mono" }, f.code))] : []),
      ...(actions.length ? [h("div", { class: "bt-actions cf-actions" }, ...actions)] : []),
    );
    if (f.status === "waiting") {
      banner.textContent = mine ? "Waiting for someone to join..." : "";
      return;
    }

    // The flip: a few turns in the air, landing on the result face.
    const end = SPINS * 360 + (f.result === "ct" ? 180 : 0);
    const anim = c.animate(
      [
        { transform: "translateY(0) rotateY(0deg)", offset: 0 },
        { transform: `translateY(-70px) rotateY(${end * 0.5}deg)`, offset: 0.45, easing: "cubic-bezier(.4,0,1,1)" },
        { transform: `translateY(0) rotateY(${end}deg)`, offset: 1 },
      ],
      { duration: FLIP_MS, easing: "cubic-bezier(.2,.6,.3,1)", fill: "forwards" },
    );
    anim.pause();
    let lastHalf = -1;
    const winner = f.winner === "creator" ? f.creator : f.joiner!;
    const loop = () => {
      const t = serverNow() - f.startAt!;
      if (t < 0) {
        banner.textContent = `Flipping in ${Math.ceil(-t / 1000)}`;
      } else if (t < FLIP_MS) {
        anim.currentTime = t;
        banner.textContent = "";
        const half = Math.floor(((anim.effect?.getComputedTiming().progress ?? 0) * end) / 180);
        if (half !== lastHalf) {
          if (lastHalf >= 0) playTick();
          lastHalf = half;
        }
      } else {
        anim.currentTime = FLIP_MS;
        banner.textContent = `${SIDE_NAME[f.result!]} · ${winner.name} wins ${money(f.stake * 2)}`;
        banner.className = `cf-banner done ${f.result}`;
        root.querySelectorAll(".cf-player").forEach((el, i) => el.classList.toggle("winner", (i === 0) === (f.winner === "creator")));
        if (t < FLIP_MS + 2000) playReveal(winner.user === me ? "covert" : "milspec");
        return;
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
  };
  onLeave(onFlips(draw));
  draw();
  return h("section", { class: "page" }, root);
}
