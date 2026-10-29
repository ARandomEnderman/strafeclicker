import { login, register, ServerError } from "../state";
import { h } from "./dom";

type Mode = "login" | "register";

/** Full-screen login / sign-up card. Calls onDone once a session exists. */
/** The login / sign-up card. `add`: logging into another account for the account switcher. */
export function authPage(onDone: () => void, mode: Mode = "login", add = false) {
  const error = h("p", { class: "auth-error", role: "alert" });
  const username = h("input", { class: "search", name: "username", autocomplete: "username", required: true, minLength: 3, maxLength: 20 });
  const password = h("input", { class: "search", name: "password", type: "password", required: true, minLength: 8 });
  const submit = h("button", { class: "btn btn-primary btn-lg", type: "submit" });
  const tabs = h("div", { class: "tabs" });

  const setMode = (m: Mode) => {
    mode = m;
    submit.textContent = m === "login" ? "Log in" : "Create account";
    password.autocomplete = m === "login" ? "current-password" : "new-password";
    error.textContent = "";
    tabs.replaceChildren(
      ...(["login", "register"] as Mode[]).map((t) =>
        h("button", { type: "button", class: `tab${t === m ? " active" : ""}`, onclick: () => setMode(t) }, t === "login" ? "Log in" : "Sign up"),
      ),
    );
    hint.textContent = m === "register" ? "3–20 letters, numbers or _ · password at least 8 characters" : "";
  };
  const hint = h("p", { class: "hint" });

  const form = h(
    "form",
    {
      class: "auth-form",
      onsubmit: async (e: Event) => {
        e.preventDefault();
        submit.disabled = true;
        error.textContent = "";
        try {
          await (mode === "login" ? login : register)(username.value, password.value, add);
          onDone();
        } catch (err) {
          error.textContent = err instanceof ServerError ? err.message : "Something went wrong, try again";
          submit.disabled = false;
        }
      },
    },
    h("label", { class: "field" }, h("span", null, "Username"), username),
    h("label", { class: "field" }, h("span", null, "Password"), password),
    hint,
    error,
    submit,
  );
  setMode(mode);

  // In the switcher's popup: just the form (you're still logged in as yourself until it works).
  if (add) return h("div", { class: "auth-add" }, h("p", { class: "hint" }, "Log in to another account. You can switch back any time from the menu under your name."), tabs, form);
  return h(
    "div",
    { class: "auth" },
    h(
      "div",
      { class: "auth-card" },
      h("div", { class: "logo" }, "STRAFE", h("span", null, "CLICKER")),
      h("p", { class: "hint" }, "CS2 case simulator. Play money only. Your items and balance are saved to your account."),
      tabs,
      form,
    ),
  );
}
