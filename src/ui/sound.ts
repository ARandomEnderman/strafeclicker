import type { Tier } from "../types";

const KEY = "strafeclicker:sound";
let ctx: AudioContext | null = null;
let enabled = (() => {
  try {
    return localStorage.getItem(KEY) !== "off";
  } catch {
    return true;
  }
})();

export const soundEnabled = () => enabled;
export function setSound(on: boolean) {
  enabled = on;
  try {
    localStorage.setItem(KEY, on ? "on" : "off");
  } catch {
    // ignore
  }
}

function beep(freq: number, ms: number, gain: number, type: OscillatorType = "square") {
  if (!enabled) return;
  ctx ??= new AudioContext();
  const osc = ctx.createOscillator();
  const g = ctx.createGain();
  osc.type = type;
  osc.frequency.value = freq;
  g.gain.setValueAtTime(gain, ctx.currentTime);
  g.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + ms / 1000);
  osc.connect(g).connect(ctx.destination);
  osc.start();
  osc.stop(ctx.currentTime + ms / 1000);
}

export const playTick = () => beep(1800, 25, 0.03);

const REVEAL_FREQ: Record<Tier, number[]> = {
  milspec: [440],
  restricted: [523, 659],
  classified: [523, 659, 784],
  covert: [523, 659, 784, 1046],
  gold: [523, 659, 784, 1046, 1318],
};

export function playReveal(tier: Tier) {
  REVEAL_FREQ[tier].forEach((f, i) => setTimeout(() => beep(f, 220, 0.06, "triangle"), i * 90));
}
