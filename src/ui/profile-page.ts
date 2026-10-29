import { priceOf } from "../catalog";
import { onPricesForPage } from "../live";
import { PROFILE_BANNERS, SHOWCASE_MAX } from "../../shared/game.js";
import { changePassword, getProfile, getState, renameMe, ServerError, setLook, setShowcase, subscribe, type Profile } from "../state";
import { h, money, toast } from "./dom";
import { dropCard } from "./item-card";
import { itemPicker } from "./item-picker";
import { onLeave } from "./page";
import { avatar, forgetProfile, profileCard } from "./profile-card";

// A player's profile: the card, their inventory (friends and yourself), and for your
// own profile the editor (name, picture, bio, banner) and the password form.

type Sort = "value" | "new";

export function profilePage(username: string) {
  const root = h("div", { class: "profile-page" });
  let profile: Profile | null = null;
  let sort: Sort = "value";

  // Your own profile's editor: display name first, then your picture (colour and up to
  // three symbols), a short bio and the banner colour. One Save for all of it.
  let editingProfile = false;
  const COLOURS = ["#e5484d", "#f76b15", "#f5a524", "#ffc53d", "#46a758", "#12a594", "#0090ff", "#3e63dd", "#8e4ec6", "#d6409f", "#8d8d8d", "#e6e9f0"];
  const profileEditor = (p: Profile) => {
    const me = getState();
    let color: string | null = p.look.color;
    let banner = p.showcase.banner;
    const name = h("input", { class: "search", maxlength: "24", value: me.displayName === me.username ? "" : me.displayName, placeholder: me.username, "aria-label": "Display name" }) as HTMLInputElement;
    const symbols = h("input", { class: "search pe-symbols", value: p.look.symbols ?? "", placeholder: [...me.displayName][0]?.toUpperCase() ?? "", "aria-label": "Up to three symbols" }) as HTMLInputElement;
    const bio = h("textarea", { class: "search pe-bio", maxlength: "160", rows: "2", placeholder: "A line about you (optional)" }, p.bio ?? "") as HTMLTextAreaElement;
    const count = h("span", { class: "pe-count" });
    const preview = h("div", { class: "pe-preview" });
    const custom = h("input", { type: "color", class: "pe-custom", value: color ?? "#3e63dd", title: "Any colour" }) as HTMLInputElement;
    const swatchRow = h("div", { class: "pe-swatches" });
    const graphemes = (v: string) => [...new Intl.Segmenter().segment(v.replace(/\s/g, ""))].map((x) => x.segment);
    const redraw = () => {
      const sym = graphemes(symbols.value).slice(0, 3).join("");
      preview.replaceChildren(avatar(me.username, name.value.trim() || me.username, 72, { c: color, s: sym || null }));
      count.textContent = `${bio.value.length}/160`;
      swatchRow.replaceChildren(
        h("button", { type: "button", class: `pe-swatch auto${color == null ? " active" : ""}`, title: "Picked from your name", onclick: () => ((color = null), redraw()) }, "Auto"),
        ...COLOURS.map((c) => h("button", { type: "button", class: `pe-swatch${color === c ? " active" : ""}`, style: `background:${c}`, title: c, "aria-label": `Colour ${c}`, onclick: () => ((color = c), redraw()) })),
        custom,
      );
    };
    // Keep it to three symbols as you type.
    symbols.addEventListener("input", () => {
      const g = graphemes(symbols.value);
      if (g.length > 3) symbols.value = g.slice(0, 3).join("");
      redraw();
    });
    custom.addEventListener("input", () => ((color = custom.value), redraw()));
    name.addEventListener("input", redraw);
    bio.addEventListener("input", redraw);
    const bannerRow = h(
      "div",
      { class: "banner-swatches" },
      ...PROFILE_BANNERS.map((b) =>
        h("button", {
          type: "button",
          class: `banner-swatch banner-${b}${b === banner ? " active" : ""}`,
          title: b,
          onclick: (e: Event) => {
            banner = b;
            bannerRow.querySelectorAll(".banner-swatch").forEach((x) => x.classList.toggle("active", x === e.currentTarget));
          },
        }),
      ),
    );
    const save = async () => {
      try {
        if ((name.value.trim() || me.username) !== me.displayName) await renameMe(name.value);
        await setLook({ color, symbols: graphemes(symbols.value).slice(0, 3).join(""), bio: bio.value, banner });
        forgetProfile(me.username);
        editingProfile = false;
        toast("Profile saved");
        void load();
      } catch (err) {
        if (err instanceof ServerError) toast(err.message, "error");
        else throw err;
      }
    };
    redraw();
    return h(
      "div",
      { class: "profile-editor" },
      h("h2", null, "Edit profile"),
      h("label", { class: "field-label" }, "Display name"),
      name,
      h("p", { class: "hint" }, `What other players see. You still log in, and friends add you, as @${me.username}.`),
      h("div", { class: "field-label" }, "Picture"),
      h(
        "div",
        { class: "pe-picture" },
        preview,
        h("div", { class: "pe-picture-opts" }, swatchRow, h("label", { class: "pe-symbols-row" }, h("span", null, "Up to 3 symbols instead of your initial:"), symbols)),
      ),
      h("div", { class: "field-label" }, "Bio ", count),
      bio,
      h("div", { class: "field-label" }, "Banner"),
      bannerRow,
      h("div", { class: "bt-actions" }, h("button", { class: "btn btn-primary", onclick: () => void save() }, "Save profile"), h("button", { class: "btn btn-ghost", onclick: () => ((editingProfile = false), draw()) }, "Cancel")),
    );
  };

  // Your own showcase: pick up to four items.
  let editing = false;
  let picker: ReturnType<typeof itemPicker> | null = null;
  onLeave(() => picker?.destroy());
  const showcaseEditor = (p: Profile) => {
    picker?.destroy();
    const pk = itemPicker({ max: SHOWCASE_MAX, includeLocked: true, initial: p.showcase.items.map((it) => it.uid) });
    picker = pk;
    const save = async () => {
      try {
        await setShowcase(pk.uids(), p.showcase.banner);
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
      ...(p.relation === "self"
        ? [editingProfile ? profileEditor(p) : h("div", { class: "toolbar" }, h("button", { class: "btn", onclick: () => ((editingProfile = true), draw()) }, "Edit profile"))]
        : []),
      ...showcase(p),
      ...(p.relation === "self" ? [passwordForm()] : []),
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

  onLeave(subscribe(() => profile?.relation === "self" && !editing && !editingProfile && draw()));
  onPricesForPage(draw);
  root.append(h("p", { class: "empty" }, "Loading..."));
  void load();
  return h("section", { class: "page narrow-wide" }, root);
}
