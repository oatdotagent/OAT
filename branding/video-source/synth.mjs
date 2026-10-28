// Original score for the OAT teaser, synthesized sample-by-sample from the shared timeline.
// Arc: D(add9) calm -> Bm11 lift on "OAT" -> G6/9 tension under the riser -> bright D on "COMING SOON".
import { writeFileSync } from 'node:fs';
import { DURATION, T } from './timeline.mjs';

const SR = 48000;
const N = Math.ceil((DURATION + 0.05) * SR);
const L = new Float32Array(N), R = new Float32Array(N); // dry bus
const vL = new Float32Array(N), vR = new Float32Array(N); // reverb send
const TAU = Math.PI * 2;
const hz = (m) => 440 * Math.pow(2, (m - 69) / 12);
const n = (name) => { const [, p, o] = name.match(/^([A-G]#?)(-?\d)$/); return 12 * (+o + 1) + ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'].indexOf(p); };
let seed = 7; const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296) * 2 - 1;
const smooth = (x) => x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x);
const add = (i, l, r, send) => { if (i < 0 || i >= N) return; L[i] += l; R[i] += r; vL[i] += l * send; vR[i] += r * send; };

// ---------- Pad: additive, alias-free warm saw; brightness follows the story ----------
const chords = [
  { at: 0.0, notes: ['D3', 'A3', 'E4', 'F#4'] },
  { at: T.wordmark, notes: ['B2', 'F#3', 'A3', 'D4', 'E4'] },
  { at: T.riser[0], notes: ['G2', 'D3', 'A3', 'B3', 'E4'] },
  { at: T.comingSoon, notes: ['D3', 'A3', 'D4', 'E4', 'F#4', 'A4'] },
];
const brightness = (t) => 2.2 + 2.5 * smooth((t - 0.5) / 4) + 1.5 * smooth((t - T.riser[0]) / (T.riser[1] - T.riser[0])) + 1.2 * Math.exp(-Math.max(0, t - T.comingSoon) * 0.6) * (t >= T.comingSoon ? 1 : 0);
const padLevel = (t) => {
  const swell = smooth(t / T.auroraIn[1]);
  const duck = t >= T.comingSoon - 0.12 && t < T.comingSoon ? 0.25 : 1; // tiny breath before the drop
  const tail = 1 - smooth((t - (DURATION - 2.4)) / 2.4);
  return 0.055 * swell * duck * tail;
};
chords.forEach((c, ci) => {
  const start = c.at, end = chords[ci + 1]?.at ?? DURATION;
  const fadeIn = ci === 0 ? 0.01 : 0.9, fadeOut = ci === chords.length - 1 ? 0.01 : 0.9;
  c.notes.forEach((name, ni) => {
    const f0 = hz(n(name));
    for (const det of [-0.07, 0, 0.07]) { // detuned voices, cents/100 in semitones
      const f = f0 * Math.pow(2, det / 12);
      const pan = 0.5 + 0.35 * det / 0.07 * (ni % 2 ? -1 : 1);
      const ph = Array.from({ length: 12 }, () => Math.random() * TAU);
      const i0 = Math.floor(Math.max(0, start - fadeIn) * SR), i1 = Math.min(N, Math.floor((end + fadeOut) * SR));
      for (let i = i0; i < i1; i++) {
        const t = i / SR;
        const env = smooth((t - (start - fadeIn)) / (fadeIn * 2)) * (1 - smooth((t - (end - fadeOut)) / (fadeOut * 2)));
        if (env <= 0) continue;
        const b = brightness(t);
        let s = 0;
        for (let h = 1; h <= 12; h++) { if (f * h > 9000) break; s += Math.sin(ph[h - 1] + TAU * f * h * t) * Math.exp(-h / b) / h; }
        const trem = 1 + 0.06 * Math.sin(TAU * 0.13 * t + ni);
        const v = s * env * padLevel(t) * trem / Math.sqrt(c.notes.length);
        add(i, v * (1 - pan), v * pan, 0.55);
      }
    }
  });
});

// ---------- Sub bass: root under each chord, enters with the first node ----------
const bassRoots = [['D2', T.dots[0], T.wordmark], ['B1', T.wordmark, T.riser[0]], ['G1', T.riser[0], T.comingSoon], ['D2', T.comingSoon, DURATION]];
for (const [name, a, b] of bassRoots) {
  const f = hz(n(name));
  for (let i = Math.floor(a * SR); i < Math.min(N, b * SR + 0.6 * SR); i++) {
    const t = i / SR;
    const env = smooth((t - a) / 0.8) * (1 - smooth((t - b) / 0.6)) * (1 - smooth((t - (DURATION - 2.2)) / 2.2));
    const duck = t >= T.comingSoon - 0.12 && t < T.comingSoon ? 0 : 1;
    const v = 0.11 * env * duck * (Math.sin(TAU * f * t) + 0.25 * Math.sin(TAU * 2 * f * t));
    add(i, v, v, 0.05);
  }
}

// ---------- Bells (FM): one per node, softer ones under the tagline ----------
const bell = (at, name, gain, pan, decay = 2.6) => {
  const f = hz(n(name));
  for (let i = Math.floor(at * SR); i < Math.min(N, (at + decay * 2.5) * SR); i++) {
    const t = i / SR - at;
    const env = (1 - Math.exp(-t * 400)) * Math.exp(-t / (decay / 3));
    const idx = 2.2 * Math.exp(-t * 3);
    const s = Math.sin(TAU * f * t + idx * Math.sin(TAU * f * 3.5 * t)) + 0.3 * Math.sin(TAU * f * 2 * t) * Math.exp(-t * 2);
    const v = s * env * gain;
    add(i, v * (1 - pan), v * pan, 0.75);
  }
};
bell(T.dots[0], 'A5', 0.09, 0.35);
bell(T.dots[1], 'D6', 0.085, 0.65);
bell(T.dots[2], 'F#6', 0.08, 0.5);
bell(T.tagline1, 'E5', 0.05, 0.4, 3);
bell(T.tagline2, 'F#5', 0.05, 0.6, 3);
for (const [name, g, p] of [['D5', 0.07, 0.4], ['A5', 0.06, 0.6]]) bell(T.wordmark, name, g, p, 3.4);
for (const [name, g, p] of [['D6', 0.07, 0.3], ['F#6', 0.055, 0.7], ['A6', 0.045, 0.5]]) bell(T.comingSoon, name, g, p, 4.5);

// ---------- Filtered-noise sweeps (line draw shimmer, riser) ----------
const sweep = (a, b, f0, f1, gain, q, shape) => {
  let lp = 0, bp = 0; // state-variable filter
  for (let i = Math.floor(a * SR); i < Math.min(N, b * SR + 0.4 * SR); i++) {
    const x = (i / SR - a) / (b - a);
    const fc = f0 * Math.pow(f1 / f0, Math.min(1, x));
    const F = 2 * Math.sin(Math.PI * fc / SR);
    const hp = rnd() - lp - q * bp; bp += F * hp; lp += F * bp;
    const v = bp * gain * shape(x);
    add(i, v * (0.5 + 0.3 * Math.sin(x * 6)), v * (0.5 - 0.3 * Math.sin(x * 6)), 0.6);
  }
};
sweep(T.lines[0], T.lines[1] + 0.35, 1800, 7000, 0.05, 0.6, (x) => Math.sin(Math.PI * Math.min(1, x)) ** 2 * (x > 1 ? Math.exp(-(x - 1) * 8) : 1));
sweep(T.riser[0], T.comingSoon, 250, 7500, 0.5, 0.45, (x) => (x < 1 ? Math.pow(x, 1.6) : Math.exp(-(x - 1) * 40)));
// Rising tone under the riser (G -> D, a perfect fourth up, landing in key)
{
  const a = T.riser[0], b = T.comingSoon, f0 = hz(n('G4')), f1 = hz(n('D5'));
  let ph = 0;
  for (let i = Math.floor(a * SR); i < Math.floor(b * SR); i++) {
    const x = (i / SR - a) / (b - a);
    ph += TAU * f0 * Math.pow(f1 / f0, x * x) / SR;
    const v = 0.045 * Math.pow(x, 2) * Math.sin(ph);
    add(i, v, v, 0.8);
  }
}

// ---------- Impacts: sub drop + soft body + air ----------
const impact = (at, gain) => {
  let lp = 0;
  for (let i = Math.floor(at * SR); i < Math.min(N, (at + 3) * SR); i++) {
    const t = i / SR - at;
    const f = 38 + 70 * Math.exp(-t * 9);
    const sub = Math.sin(TAU * (38 * t + (70 / 9) * (1 - Math.exp(-t * 9)))) * Math.exp(-t * 1.6) * (1 - Math.exp(-t * 900));
    lp += 0.08 * (rnd() - lp);
    const body = lp * 6 * Math.exp(-t * 7);
    const air = rnd() * 0.12 * Math.exp(-t * 4) * (t < 0.002 ? t / 0.002 : 1);
    const v = gain * (sub * 0.9 + body * 0.5 + air * 0.4 + 0 * f);
    add(i, v, v, 0.35);
  }
};
impact(T.wordmark, 0.38);
impact(T.comingSoon, 0.55);

// ---------- Reverb (Schroeder/Freeverb style), stereo-decorrelated ----------
const reverb = (src, offset) => {
  const out = new Float32Array(N);
  const combs = [1557, 1617, 1491, 1422, 1277, 1356, 1188, 1116].map((d) => Math.round((d + offset) * SR / 44100 * 1.6));
  for (const d of combs) {
    const buf = new Float32Array(d); let idx = 0, filt = 0;
    for (let i = 0; i < N; i++) {
      const y = buf[idx]; filt = y * 0.7 + filt * 0.3;
      buf[idx] = src[i] + filt * 0.86; idx = (idx + 1) % d; out[i] += y / combs.length;
    }
  }
  for (const d of [556, 441, 341, 225].map((x) => Math.round((x + offset) * SR / 44100))) {
    const buf = new Float32Array(d); let idx = 0;
    for (let i = 0; i < N; i++) { const b = buf[idx]; const y = -out[i] + b; buf[idx] = out[i] + b * 0.5; out[i] = y; idx = (idx + 1) % d; }
  }
  return out;
};
const wL = reverb(vL, 0), wR = reverb(vR, 23);

// ---------- Master: mix, gentle saturation, fades, normalize to -1 dBFS ----------
const outL = new Float32Array(N), outR = new Float32Array(N);
let peak = 0;
for (let i = 0; i < N; i++) {
  const t = i / SR;
  const fade = Math.min(1, t / 0.05) * (1 - smooth((t - (DURATION - 0.8)) / 0.8));
  outL[i] = Math.tanh((L[i] + wL[i] * 0.9) * 1.4) * fade;
  outR[i] = Math.tanh((R[i] + wR[i] * 0.9) * 1.4) * fade;
  peak = Math.max(peak, Math.abs(outL[i]), Math.abs(outR[i]));
}
const g = 0.891 / peak;
const buf = Buffer.alloc(44 + N * 4);
buf.write('RIFF', 0); buf.writeUInt32LE(36 + N * 4, 4); buf.write('WAVE', 8); buf.write('fmt ', 12);
buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(2, 22); buf.writeUInt32LE(SR, 24);
buf.writeUInt32LE(SR * 4, 28); buf.writeUInt16LE(4, 32); buf.writeUInt16LE(16, 34); buf.write('data', 36); buf.writeUInt32LE(N * 4, 40);
for (let i = 0; i < N; i++) {
  buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, outL[i] * g)) * 32767), 44 + i * 4);
  buf.writeInt16LE(Math.round(Math.max(-1, Math.min(1, outR[i] * g)) * 32767), 46 + i * 4);
}
const out = new URL('./score.wav', import.meta.url);
writeFileSync(out, buf);
console.log('score.wav written', (N / SR).toFixed(2) + 's', 'peak gain', g.toFixed(2));
