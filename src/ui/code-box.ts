import { h, toast } from "./dom";
import { icon } from "./icons";

/** The join code of a lobby, with a button that copies an invite link to it. */
export function codeBox(code: string, page: string, visibility: string, extraClass = "") {
  return h(
    "div",
    { class: `bt-meta bt-codebox${extraClass ? ` ${extraClass}` : ""}` },
    h("span", null, visibility === "private" ? "Private, code" : "Code"),
    h("b", { class: "mono" }, code),
    h(
      "button",
      {
        class: "btn btn-ghost btn-sm icon-btn",
        title: "Copy invite link",
        onclick: () => {
          const link = `${location.origin}${location.pathname}#/${page}?code=${code}`;
          void navigator.clipboard?.writeText(link).then(() => toast("Invite link copied"), () => toast(link));
        },
      },
      icon("copy", 14),
    ),
  );
}
