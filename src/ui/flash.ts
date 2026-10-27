import { soundEnabled } from "./sound";

// The flashbang going off: the whole screen turns white, holds, then fades like a CS2
// full flash (about 4.5 s), with a bang and an ear-ringing tone.

const HOLD_MS = 1200;
const FADE_MS = 3300;

let overlay: HTMLDivElement | null = null;
let ctx: AudioContext | null = null;

export function flashScreen() {
  overlay ??= document.body.appendChild(Object.assign(document.createElement("div"), { className: "flash-overlay" }));
  overlay.getAnimations().forEach((a) => a.cancel());
  overlay.animate(
    [
      { opacity: 0, offset: 0 },
      { opacity: 1, offset: 0.01 },
      { opacity: 1, offset: HOLD_MS / (HOLD_MS + FADE_MS), easing: "cubic-bezier(.3,0,.2,1)" },
      { opacity: 0, offset: 1 },
    ],
    { duration: HOLD_MS + FADE_MS },
  );
  bang();
}

/** A burst of filtered noise for the pop, then a fading ~3.4 kHz ring. */
function bang() {
  if (!soundEnabled()) return;
  ctx ??= new AudioContext();
  const t = ctx.currentTime;

  const len = Math.floor(ctx.sampleRate * 0.6);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3);
  const noise = ctx.createBufferSource();
  noise.buffer = buf;
  const lp = ctx.createBiquadFilter();
  lp.type = "lowpass";
  lp.frequency.setValueAtTime(5000, t);
  lp.frequency.exponentialRampToValueAtTime(300, t + 0.5);
  const ng = ctx.createGain();
  ng.gain.setValueAtTime(0.5, t);
  ng.gain.exponentialRampToValueAtTime(0.001, t + 0.6);
  noise.connect(lp).connect(ng).connect(ctx.destination);
  noise.start(t);

  // Thump underneath.
  const thump = ctx.createOscillator();
  thump.frequency.setValueAtTime(120, t);
  thump.frequency.exponentialRampToValueAtTime(40, t + 0.25);
  const tg = ctx.createGain();
  tg.gain.setValueAtTime(0.4, t);
  tg.gain.exponentialRampToValueAtTime(0.001, t + 0.3);
  thump.connect(tg).connect(ctx.destination);
  thump.start(t);
  thump.stop(t + 0.3);

  // Tinnitus.
  const ring = ctx.createOscillator();
  ring.type = "sine";
  ring.frequency.value = 3400;
  const rg = ctx.createGain();
  rg.gain.setValueAtTime(0.0001, t);
  rg.gain.exponentialRampToValueAtTime(0.05, t + 0.15);
  rg.gain.setValueAtTime(0.05, t + (HOLD_MS / 1000));
  rg.gain.exponentialRampToValueAtTime(0.0001, t + (HOLD_MS + FADE_MS) / 1000);
  ring.connect(rg).connect(ctx.destination);
  ring.start(t);
  ring.stop(t + (HOLD_MS + FADE_MS) / 1000);
}
