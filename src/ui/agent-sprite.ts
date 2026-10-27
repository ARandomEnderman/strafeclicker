// The b-hop jumper: src/assets/ct-agent.webp, keyed from a side-on green-screen
// capture. Swap in another picture with the same name (or .png/.jpg): one that already
// has transparency is used as-is; a green-screen one is keyed in the browser and
// cropped to the biggest figure in it. Without any, a simple silhouette stands in.

const found = import.meta.glob("../assets/ct-agent.{png,jpg,jpeg,webp}", { eager: true, query: "?url", import: "default" }) as Record<string, string>;
const SOURCE = Object.values(found)[0] ?? null;

const PLACEHOLDER =
  "data:image/svg+xml," +
  encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 60 120">
  <g fill="#1d2433" stroke="#0b0e14" stroke-width="2" stroke-linejoin="round">
    <path d="M24 70 L18 112 L28 112 L32 82 L36 112 L46 112 L40 70 Z"/>
    <path d="M20 34 Q32 28 44 34 L46 72 L18 72 Z"/>
    <path d="M40 42 L58 46 L58 52 L40 50 Z"/>
    <circle cx="32" cy="20" r="11"/>
  </g>
  <rect x="35" y="16" width="9" height="5" rx="2" fill="#3a4157"/>
</svg>`);

let sprite: Promise<string> | null = null;

/** URL of the jumper image (keyed and cropped once, then cached). */
export function agentSprite(): Promise<string> {
  sprite ??= SOURCE ? keyOut(SOURCE).catch(() => PLACEHOLDER) : Promise.resolve(PLACEHOLDER);
  return sprite;
}

async function keyOut(src: string): Promise<string> {
  const img = new Image();
  img.src = src;
  await img.decode();
  const w = img.naturalWidth;
  const hgt = img.naturalHeight;
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = hgt;
  const c = canvas.getContext("2d", { willReadFrequently: true })!;
  c.drawImage(img, 0, 0);
  // Already transparent (keyed beforehand): use it as it is.
  if (c.getImageData(0, 0, 1, 1).data[3] < 255) return src;
  const data = c.getImageData(0, 0, w, hgt);
  const px = data.data;

  // Chroma key: how much greener than red/blue a pixel is decides its transparency,
  // with a soft ramp for the edges, and green spill pulled out of what's left.
  for (let i = 0; i < px.length; i += 4) {
    const r = px[i];
    const g = px[i + 1];
    const b = px[i + 2];
    const spill = g - Math.max(r, b);
    if (spill > 90) px[i + 3] = 0;
    else if (spill > 30) px[i + 3] = Math.round(255 * (1 - (spill - 30) / 60));
    if (spill > 0) px[i + 1] = Math.max(r, b);
  }

  // Crop to the largest connected figure (the picture may hold several, plus a
  // timestamp), found on a coarse grid of opaque cells.
  const CELL = 4;
  const gw = Math.ceil(w / CELL);
  const gh = Math.ceil(hgt / CELL);
  const solid = new Uint8Array(gw * gh);
  for (let y = 0; y < hgt; y += 2) {
    for (let x = 0; x < w; x += 2) if (px[(y * w + x) * 4 + 3] > 128) solid[Math.floor(y / CELL) * gw + Math.floor(x / CELL)] = 1;
  }
  const label = new Int32Array(gw * gh).fill(-1);
  let best = { n: 0, x0: 0, y0: 0, x1: gw - 1, y1: gh - 1 };
  const stack: number[] = [];
  for (let start = 0; start < solid.length; start++) {
    if (!solid[start] || label[start] >= 0) continue;
    const box = { n: 0, x0: gw, y0: gh, x1: 0, y1: 0 };
    stack.push(start);
    label[start] = start;
    while (stack.length) {
      const i = stack.pop()!;
      const x = i % gw;
      const y = (i - x) / gw;
      box.n++;
      box.x0 = Math.min(box.x0, x);
      box.x1 = Math.max(box.x1, x);
      box.y0 = Math.min(box.y0, y);
      box.y1 = Math.max(box.y1, y);
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= gw || ny >= gh) continue;
        const j = ny * gw + nx;
        if (solid[j] && label[j] < 0) {
          label[j] = start;
          stack.push(j);
        }
      }
    }
    if (box.n > best.n) best = box;
  }
  const pad = 2;
  const sx = Math.max(0, (best.x0 - pad) * CELL);
  const sy = Math.max(0, (best.y0 - pad) * CELL);
  const sw = Math.min(w, (best.x1 + 1 + pad) * CELL) - sx;
  const sh = Math.min(hgt, (best.y1 + 1 + pad) * CELL) - sy;
  c.putImageData(data, 0, 0);

  // Scale down to something sensible for the page.
  const scale = Math.min(1, 360 / sh);
  const out = document.createElement("canvas");
  out.width = Math.round(sw * scale);
  out.height = Math.round(sh * scale);
  out.getContext("2d")!.drawImage(canvas, sx, sy, sw, sh, 0, 0, out.width, out.height);
  return out.toDataURL("image/png");
}
