import { onServerEvent } from "../live";
import { clansAction, getState, InsufficientFunds, ServerError, type Clan, type ClanOverview } from "../state";
import { onTags } from "../tags";
import { segmented } from "./bet-input";
import { h, money, toast } from "./dom";
import { icon } from "./icons";
import { onLeave } from "./page";
import { userLink } from "./profile-card";

// Clans: your clan (members, join requests, settings), the weekly clan board, and
// making or joining one. #/clans/<id> shows another clan.

async function run<T>(fn: () => Promise<T>, ok?: string): Promise<T | null> {
  try {
    const r = await fn();
    if (ok) toast(ok);
    return r;
  } catch (e) {
    if (e instanceof InsufficientFunds) toast(e.message || "Not enough balance", "error");
    else if (e instanceof ServerError) toast(e.message, "error");
    else throw e;
    return null;
  }
}

function clanCard(c: Clan, reload: () => void) {
  const owner = c.myRole === "owner";
  const memberRow = (m: Clan["members"][0]) =>
    h(
      "div",
      { class: "clan-member" },
      h("span", { class: `dot${m.online ? " on" : ""}` }),
      userLink(m.user, m.name, { avatar: true }),
      m.role === "owner" ? h("span", { class: "clan-role" }, "Owner") : "",
      owner && m.user !== getState().username
        ? h("button", { class: "btn btn-sm btn-ghost", onclick: async () => confirm(`Kick ${m.name} from ${c.name}?`) && (await run(() => clansAction("kick", { username: m.user }), `${m.name} was kicked`)) && reload() }, "Kick")
        : "",
    );
  const actions: HTMLElement[] = [];
  if (c.myRole) {
    actions.push(
      h(
        "button",
        {
          class: "btn btn-ghost",
          onclick: async () =>
            confirm(c.members.length === 1 ? "You're the last member, so leaving disbands the clan. Leave?" : `Leave ${c.name}?${owner ? " The longest-standing member becomes owner." : ""}`) &&
            (await run(() => clansAction("leave"), "You left the clan")) &&
            reload(),
        },
        "Leave clan",
      ),
    );
  } else if (c.requested) actions.push(h("span", { class: "hint" }, "Request sent. The owner decides."));
  else if (c.members.length < c.max)
    actions.push(
      h(
        "button",
        { class: "btn btn-primary", onclick: async () => (await run(() => clansAction<{ requested?: boolean }>("join", { id: c.id }), c.open ? `You joined ${c.name}` : "Request sent")) && reload() },
        c.open ? "Join clan" : "Ask to join",
      ),
    );
  return h(
    "div",
    { class: "clan-card" },
    h("div", { class: "clan-head" }, h("span", { class: "clan-tag big" }, c.tag), h("div", null, h("h2", null, c.name), h("span", { class: "hint" }, `${c.members.length} / ${c.max} members · ${c.open ? "Open to anyone" : "Join by request"} · ${money(c.weekWagered)} wagered this week`))),
    owner
      ? h(
          "div",
          { class: "admin-row" },
          segmented<"open" | "closed">(
            "Who can join",
            [
              { value: "open", label: "Anyone" },
              { value: "closed", label: "By request" },
            ],
            c.open ? "open" : "closed",
            (v) => void run(() => clansAction("settings", { open: v === "open" }), "Saved").then(reload),
          ).el,
        )
      : "",
    owner && c.requests.length
      ? h(
          "div",
          { class: "clan-requests" },
          h("h3", null, `Join requests (${c.requests.length})`),
          ...c.requests.map((r) =>
            h(
              "div",
              { class: "clan-member" },
              userLink(r.user, r.name, { avatar: true }),
              h("button", { class: "btn btn-sm btn-primary", onclick: async () => (await run(() => clansAction("accept", { username: r.user }), `${r.name} joined`)) && reload() }, "Accept"),
              h("button", { class: "btn btn-sm btn-ghost", onclick: async () => (await run(() => clansAction("decline", { username: r.user }))) && reload() }, "Decline"),
            ),
          ),
        )
      : "",
    h("div", { class: "clan-members" }, ...c.members.map(memberRow)),
    actions.length ? h("div", { class: "bt-actions" }, ...actions) : "",
  );
}

export function clansPage() {
  const root = h("div", { class: "clans" });
  const load = async () => {
    const r = await run(() => clansAction<ClanOverview>("overview"));
    if (r) draw(r);
  };
  const draw = (o: ClanOverview) => {
    const name = h("input", { class: "search", placeholder: "Clan name", maxlength: "24" }) as HTMLInputElement;
    const tag = h("input", { class: "search code-field", placeholder: "TAG", maxlength: "4" }) as HTMLInputElement;
    let open = true;
    const create = h(
      "div",
      { class: "bt-create" },
      h("div", { class: "bt-create-head" }, icon("friends", 18), h("b", null, "Start a clan"), h("span", { class: "bt-limit" }, `Costs ${money(o.cost)} · up to ${o.max} members`)),
      h(
        "div",
        { class: "bt-create-row" },
        name,
        tag,
        segmented<"open" | "closed">(
          "Who can join",
          [
            { value: "open", label: "Anyone" },
            { value: "closed", label: "By request" },
          ],
          "open",
          (v) => (open = v === "open"),
        ).el,
        h("button", { class: "btn btn-primary", onclick: async () => (await run(() => clansAction("create", { name: name.value, tag: tag.value, open }), "Clan created")) && void load() }, "Create"),
      ),
    );
    root.replaceChildren(
      h("h1", null, "Clans"),
      o.mine ? clanCard(o.mine, () => void load()) : create,
      h("h2", null, "Top clans this week"),
      o.board.length
        ? h(
            "div",
            { class: "lb-rows clan-board" },
            ...o.board.map((c) =>
              h(
                "a",
                { class: `lb-row${o.mine?.id === c.id ? " me" : ""}`, href: `#/clans/${c.id}` },
                h("span", { class: `lb-rank r${c.rank}` }, String(c.rank)),
                h("span", { class: "clan-tag" }, c.tag),
                h("span", { class: "lb-name" }, c.name),
                h("span", { class: "lb-extra" }, `${c.members} member${c.members === 1 ? "" : "s"}${c.open ? "" : " · by request"}`),
                h("b", { class: "lb-value" }, money(c.wagered)),
              ),
            ),
          )
        : h("p", { class: "empty" }, "No clans yet. Start the first one."),
    );
  };
  // Kicked, or someone joined: refresh.
  onLeave(onTags(() => void load()));
  onLeave(onServerEvent("clan", () => void load()));
  root.append(h("p", { class: "empty" }, "Loading..."));
  void load();
  return h("section", { class: "page narrow-wide" }, root);
}

export function clanView(id: number) {
  const root = h("div", { class: "clans" });
  const load = async () => {
    const r = await run(() => clansAction<{ clan: Clan }>("view", { id }));
    if (r) root.replaceChildren(h("div", { class: "bt-crumbs" }, h("a", { href: "#/clans" }, "Clans")), clanCard(r.clan, () => void load()));
    else root.replaceChildren(h("p", { class: "empty" }, "That clan doesn't exist any more. ", h("a", { href: "#/clans" }, "Back to clans")));
  };
  onLeave(onTags(() => void load()));
  root.append(h("p", { class: "empty" }, "Loading..."));
  void load();
  return h("section", { class: "page narrow-wide" }, root);
}
