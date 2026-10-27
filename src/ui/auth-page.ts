import { login, register, ServerError } from "../state";
import { h } from "./dom";

type Mode = "login" | "register";

/** Full-screen login / sign-up card. Calls onDone once a session exists. */
export function authPage(onDone: () => void, mode: Mode = "login") {
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
          await (mode === "login" ? login : register)(username.value, password.value);
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
