import { priceOf } from "../catalog";
import { onPricesForPage } from "../live";
import { getProfile, getState, renameMe, ServerError, subscribe, type Profile } from "../state";
import { h, money, toast } from "./dom";
import { dropCard } from "./item-card";
import { onLeave } from "./page";
import { forgetProfile, profileCard } from "./profile-card";

// A player's profile: the card, their inventory (friends and yourself), and for your
// own profile the display name setting.

type Sort = "value" | "new";

export function profilePage(username: string) {
  const root = h("div", { class: "profile-page" });
  let profile: Profile | null = null;
  let sort: Sort = "value";

  const renameForm = () => {
    const input = h("input", { class: "search", maxlength: "24", value: getState().displayName, placeholder: getState().username, "aria-label": "Display name" }) as HTMLInputElement;
    return h(
      "form",
      {
        class: "rename",
        onsubmit: async (e: Event) => {
          e.preventDefault();
          try {
            await renameMe(input.value);
            forgetProfile(getState().username);
            toast(input.value.trim() ? `You're now shown as ${getState().displayName}` : "Display name reset to your username");
            void load();
          } catch (err) {
            if (err instanceof ServerError) toast(err.message, "error");
            else throw err;
          }
        },
      },
      h("label", { class: "field-label" }, "Display name"),
      h("div", { class: "rename-row" }, input, h("button", { class: "btn btn-primary", type: "submit" }, "Save")),
      h("p", { class: "hint" }, `What other players see. You still log in, and friends add you, as @${getState().username}.`),
    );
  };

  const draw = () => {
    if (!profile) return;
    const p = profile;
    const items = p.relation === "self" ? getState().inventory : (p.inventory ?? []);
    const sorted = [...items].sort((a, b) => (sort === "value" ? priceOf(b) - priceOf(a) : b.obtainedAt - a.obtainedAt));
    const sortBtn = (s: Sort, label: string) => h("button", { class: `chip${sort === s ? " active" : ""}`, onclick: () => ((sort = s), draw()) }, label);
    root.replaceChildren(
      profileCard(p, { onChange: () => void load() }),
      ...(p.relation === "self" ? [renameForm()] : []),
      ...(p.inventory || p.relation === "self"
        ? [
            h(
              "div",
              { class: "toolbar" },
              h("h2", null, `Inventory · ${items.length} items · ${money(items.reduce((s, it) => s + priceOf(it), 0))}`),
              h("div", { class: "sort" }, sortBtn("value", "Most valuable"), sortBtn("new", "Newest")),
            ),
            sorted.length ? h("div", { class: "item-grid" }, ...sorted.map((it) => dropCard(it))) : h("p", { class: "empty" }, "Nothing in this inventory."),
          ]
        : []),
    );
  };

  const load = async () => {
    try {
      profile = await getProfile(username);
      draw();
    } catch (e) {
      if (e instanceof ServerError) root.replaceChildren(h("p", { class: "empty" }, e.message));
      else throw e;
    }
  };

  onLeave(subscribe(() => profile?.relation === "self" && draw()));
  onPricesForPage(draw);
  root.append(h("p", { class: "empty" }, "Loading..."));
  void load();
  return h("section", { class: "page narrow-wide" }, root);
}
