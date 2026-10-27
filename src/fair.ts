// Provably-fair rolls, the same scheme real case sites use:
//   rolls = HMAC-SHA256(key = serverSeed, msg = `${clientSeed}:${nonce}`)
// The server seed's SHA-256 is shown up front; once rotated the seed itself is
// revealed so every past roll can be recomputed. (Here the "server" is your
// browser, so it's a demo of the mechanism rather than a real guarantee.)

const enc = new TextEncoder();

export function randomHex(bytes: number): string {
  const buf = crypto.getRandomValues(new Uint8Array(bytes));
  return [...buf].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", enc.encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Eight independent uniform floats in [0, 1) for one roll. */
export async function rollFloats(serverSeed: string, clientSeed: string, nonce: number): Promise<number[]> {
  const key = await crypto.subtle.importKey("raw", enc.encode(serverSeed), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  const sig = new DataView(await crypto.subtle.sign("HMAC", key, enc.encode(`${clientSeed}:${nonce}`)));
  return Array.from({ length: 8 }, (_, i) => sig.getUint32(i * 4) / 2 ** 32);
}
