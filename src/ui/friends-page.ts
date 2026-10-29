import { friendLists, loadFriends, onFriends, set } from "../friends";
import { friendsAction, ServerError } from "../state";
import { h, NO_AUTOFILL, toast } from "./dom";
import { icon } from "./icons";
import { onLeave } from "./page";
import { avatar, userLink } from "./profile-card";
import type { Friend } from "../friends";

export function friendsPage() {
  const input = h("input", { class: "search", ...NO_AUTOFILL, name: "friend-search", placeholder: "Add a friend by name", "aria-label": "Player to add as a friend" }) as HTMLInputElement;
  const body = h("div", { class: "friends" });

  const run = async (action: "request" | "accept" | "remove", user: string, done?: string) => {
    try {
      set(await friendsAction(action, user));
      if (done) toast(done);
    } catch (e) {
      if (e instanceof ServerError) toast(e.message, "error");
      else throw e;
    }
  };

  const form = h(
    "form",
    {
      class: "friend-add",
      onsubmit: (e: Event) => {
        e.preventDefault();
        const name = input.value.trim();
        if (!name) return;
        void run("request", name, `Friend request sent to ${name}`).then(() => (input.value = ""));
      },
    },
    input,
    h("button", { class: "btn btn-primary", type: "submit" }, icon("user", 14), " Add friend"),
  );

  const row = (f: Friend, ...actions: HTMLElement[]) =>
    h(
      "div",
      { class: "friend" },
      h("span", { class: "friend-avatar" }, avatar(f.user, f.name, 32), h("span", { class: `dot${f.online ? " on" : ""}`, title: f.online ? "Online" : "Offline" })),
      h("div", { class: "friend-names" }, userLink(f.user, f.name), h("span", null, f.name !== f.user ? `@${f.user}` : f.online ? "Online" : "Offline")),
      h("div", { class: "friend-actions" }, ...actions),
    );

  const draw = () => {
    const l = friendLists();
    const section = (title: string, rows: HTMLElement[], empty?: string) =>
      rows.length || empty ? [h("h2", null, title), ...(rows.length ? rows : [h("p", { class: "fb-empty" }, empty!)])] : [];
    body.replaceChildren(
      ...section(
        "Requests",
        l.incoming.map((f) =>
          row(
            f,
            h("button", { class: "btn btn-primary btn-sm", onclick: () => void run("accept", f.user, `You and ${f.user} are now friends`) }, "Accept"),
            h("button", { class: "btn btn-ghost btn-sm", onclick: () => void run("remove", f.user) }, "Decline"),
          ),
        ),
      ),
      ...section(
        `Friends (${l.friends.filter((f) => f.online).length} online, ${l.friends.length} total)`,
        [...l.friends].sort((a, b) => +b.online - +a.online).map((f) => row(f, h("a", { class: "btn btn-sm", href: `#/u/${encodeURIComponent(f.user)}` }, "Inventory"), h("a", { class: "btn btn-sm", href: `#/trade?with=${encodeURIComponent(f.user)}` }, "Trade"), h("button", { class: "btn btn-ghost btn-sm", onclick: () => confirm(`Remove ${f.user} from your friends?`) && void run("remove", f.user) }, "Remove"))),
        "No friends yet. Add someone by their username.",
      ),
      ...section(
        "Sent",
        l.outgoing.map((f) => row(f, h("button", { class: "btn btn-ghost btn-sm", onclick: () => void run("remove", f.user) }, "Cancel"))),
      ),
    );
  };
  onLeave(onFriends(draw));
  void loadFriends();
  draw();

  return h("section", { class: "page narrow" }, h("h1", null, "Friends"), h("p", { class: "hint" }, "Friends can join your friends-only case battles."), form, body);
}
