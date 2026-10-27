import { getCase, getCatalog, getItem, resolveDrop } from "../catalog";
import { rollFloats, sha256Hex } from "../fair";
import { getState, rotateSeed } from "../state";
import { h, toast } from "./dom";
import { displayName } from "./item-card";
import { WEAR_NAME } from "../odds";

export function fairPage() {
  const body = h("div");

  const draw = () => {
    const f = getState().fair;
    const clientInput = h("input", { class: "search mono", value: f.clientSeed, maxLength: 64 });
    body.replaceChildren(
      h(
        "div",
        { class: "panel" },
        h("h2", null, "Current seeds"),
        row("Server seed (SHA-256)", f.serverSeedHash),
        row("Next nonce", String(f.nonce)),
        h("label", { class: "field" }, h("span", null, "Client seed"), clientInput),
        h(
          "button",
          {
            class: "btn btn-primary",
            onclick: async () => {
              await rotateSeed(clientInput.value);
              toast("Server seed revealed, new one generated");
              draw();
            },
          },
          "Reveal server seed & rotate",
        ),
      ),
      verifier(),
      h(
        "div",
        { class: "panel", hidden: !f.revealed.length },
        h("h2", null, "Revealed seeds"),
        ...f.revealed.map((r) =>
          h(
            "div",
            { class: "revealed" },
            row("Server seed", r.serverSeed),
            row("Hash", r.serverSeedHash),
            row("Client seed", r.clientSeed),
            row("Nonces", r.lastNonce < 0 ? "unused" : `0 – ${r.lastNonce}`),
          ),
        ),
      ),
    );
  };

  draw();
  return h(
    "section",
    { class: "page narrow" },
    h("h1", null, "Provably fair"),
    h(
      "p",
      { class: "hint" },
      "Each opening computes HMAC-SHA256(server seed, \"client seed:nonce\") and splits it into eight numbers in [0, 1): " +
        "rarity tier, item, phase, wear bucket, float within the bucket, StatTrak, pattern seed. " +
        "The server seed's hash is committed before you open; rotating reveals it so every past roll can be checked.",
    ),
    body,
  );
}

function row(label: string, value: string) {
  return h("div", { class: "kv" }, h("span", null, label), h("code", null, value));
}

function verifier() {
  const caseSelect = h(
    "select",
    { class: "search" },
    ...casesUsedFirst().map((c) => h("option", { value: c.id }, c.name)),
  );
  const server = h("input", { class: "search mono", placeholder: "Revealed server seed" });
  const client = h("input", { class: "search mono", placeholder: "Client seed" });
  const nonce = h("input", { class: "search mono", type: "number", min: 0, value: 0 });
  const out = h("div", { class: "verify-out" });

  return h(
    "div",
    { class: "panel" },
    h("h2", null, "Verify a roll"),
    h("label", { class: "field" }, h("span", null, "Case"), caseSelect),
    h("label", { class: "field" }, h("span", null, "Server seed"), server),
    h("label", { class: "field" }, h("span", null, "Client seed"), client),
    h("label", { class: "field" }, h("span", null, "Nonce"), nonce),
    h(
      "button",
      {
        class: "btn",
        onclick: async () => {
          const c = getCase(caseSelect.value)!;
          const d = resolveDrop(c, await rollFloats(server.value.trim(), client.value.trim(), Number(nonce.value)));
          const item = getItem(d.itemId);
          const n = displayName(item, d);
          out.replaceChildren(
            row("Hash of server seed", await sha256Hex(server.value.trim())),
            row("Result", `${n.weapon} | ${n.finish}${d.wear ? ` (${WEAR_NAME[d.wear]})` : ""}`),
            row("Float / seed", `${d.float?.toFixed(6) ?? "—"} / ${d.seed}`),
          );
        },
      },
      "Verify",
    ),
    out,
  );
}

function casesUsedFirst() {
  // Cases you've actually opened are the ones worth checking, so list them first.
  const used = new Set(getState().inventory.map((i) => i.caseId));
  return [...getCatalog().cases].sort((a, b) => Number(used.has(b.id)) - Number(used.has(a.id)));
}
