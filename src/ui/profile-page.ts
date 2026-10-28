import { priceOf } from "../catalog";
import { onPricesForPage } from "../live";
import { PROFILE_BANNERS, SHOWCASE_MAX } from "../../shared/game.js";
import { changePassword, getProfile, getState, renameMe, ServerError, setShowcase, subscribe, type Profile } from "../state";
import { h, money, toast } from "./dom";
import { dropCard } from "./item-card";
import { itemPicker } from "./item-picker";
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

  // Your own showcase: pick up to four items and a banner colour.
  let editing = false;
  let picker: ReturnType<typeof itemPicker> | null = null;
  onLeave(() => picker?.destroy());
  const showcaseEditor = (p: Profile) => {
    picker?.destroy();
    const pk = itemPicker({ max: SHOWCASE_MAX, includeLocked: true, initial: p.showcase.items.map((it) => it.uid) });
    picker = pk;
    let banner = p.showcase.banner;
    const swatches = h(
      "div",
      { class: "banner-swatches" },
      ...PROFILE_BANNERS.map((b) =>
        h("button", {
          type: "button",
          class: `banner-swatch banner-${b}${b === banner ? " active" : ""}`,
          title: b,
          onclick: (e: Event) => {
            banner = b;
            swatches.querySelectorAll(".banner-swatch").forEach((x) => x.classList.toggle("active", x === e.currentTarget));
          },
        }),
      ),
    );
    const save = async () => {
      try {
        await setShowcase(pk.uids(), banner);
        forgetProfile(getState().username);
        editing = false;
        toast("Showcase saved");
        void load();
      } catch (err) {
        if (err instanceof ServerError) toast(err.message, "error");
        else throw err;
      }
    };
    return h(
      "div",
      { class: "showcase-editor" },
      h("div", { class: "field-label" }, "Banner"),
      swatches,
      h("div", { class: "field-label" }, `Pick up to ${SHOWCASE_MAX} items to show off`),
      pk.el,
      h("div", { class: "bt-actions" }, h("button", { class: "btn btn-primary", onclick: () => void save() }, "Save showcase"), h("button", { class: "btn btn-ghost", onclick: () => ((editing = false), draw()) }, "Cancel")),
    );
  };
  const showcase = (p: Profile) => {
    const self = p.relation === "self";
    if (self && editing) return [h("h2", null, "Showcase"), showcaseEditor(p)];
    if (!p.showcase.items.length && !self) return [];
    return [
      h("div", { class: "toolbar" }, h("h2", null, "Showcase"), self ? h("button", { class: "btn btn-sm", onclick: () => ((editing = true), draw()) }, "Edit showcase") : ""),
      p.showcase.items.length
        ? h("div", { class: "item-grid showcase-grid" }, ...p.showcase.items.map((it) => dropCard(it)))
        : h("p", { class: "empty" }, "Pin your best items here for everyone to see."),
    ];
  };

  // Your own profile: change your password (other devices get logged out).
  const passwordForm = () => {
    const field = (placeholder: string, autocomplete: string) => h("input", { class: "search", type: "password", placeholder, autocomplete, maxlength: "200" }) as HTMLInputElement;
    const next = field("New password (8+ characters)", "new-password");
    const again = field("New password again", "new-password");
    return h(
      "form",
      {
        class: "rename password-form",
        onsubmit: async (e: Event) => {
          e.preventDefault();
          if (next.value !== again.value) return toast("The new passwords don't match", "error");
          try {
            await changePassword(next.value);
            toast("Password changed. Other devices were logged out.");
            next.value = again.value = "";
          } catch (err) {
            if (err instanceof ServerError) toast(err.message, "error");
            else throw err;
          }
        },
      },
      h("label", { class: "field-label" }, "Change password"),
      h("div", { class: "password-row" }, next, again, h("button", { class: "btn btn-primary", type: "submit" }, "Change")),
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
      ...showcase(p),
      ...(p.relation === "self" ? [renameForm(), passwordForm()] : []),
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

  onLeave(subscribe(() => profile?.relation === "self" && !editing && draw()));
  onPricesForPage(draw);
  root.append(h("p", { class: "empty" }, "Loading..."));
  void load();
  return h("section", { class: "page narrow-wide" }, root);
}
