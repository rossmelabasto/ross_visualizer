// Run audio through the exact analysis the app uses, frame by frame, and summarize it.
//   npx vite-node scripts/calibrate.ts file.f32        raw mono f32 at 48 kHz, e.g. from
//                                                       pw-record --raw --format f32 --channels 1 --rate 48000
//   npx vite-node scripts/calibrate.ts --synth          known test signals (see SIGNALS)
// Prints, per signal: the distribution of each band (p10/p50/p90), beats found and tempo.
import { readFileSync } from 'node:fs';
import { FeatureExtractor } from '../src/audio/features';
import { PcmAnalyser } from '../src/audio/pcm';

const SR = 48000;
const FPS = 60;

type Signal = { name: string; seconds: number; sample: (t: number) => number };

let seed = 3;
const noise = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
/** A one-pole low-pass on white noise, for band-limited hiss. */
function filtered(cutHz: number, high = false) {
  let lp = 0;
  const a = 1 - Math.exp((-2 * Math.PI * cutHz) / SR);
  return () => {
    const n = noise();
    lp += (n - lp) * a;
    return high ? n - lp : lp;
  };
}
const hiss = filtered(6000, true);
const kick = (t: number, bpm: number) => {
  const p = t % (60 / bpm);
  // Pitch drops from 120 to 50 Hz, as a real kick does.
  return Math.sin(2 * Math.PI * (50 * p + 35 * (1 - Math.exp(-p * 30)))) * Math.exp(-p * 18);
};
const bassline = (t: number) => Math.sin(2 * Math.PI * [55, 55, 65.4, 49][Math.floor(t * 2) % 4] * t) * 0.5;
const hats = (t: number, bpm: number) => {
  const p = t % (30 / bpm);
  return hiss() * Math.exp(-p * 60);
};
const chords = (t: number) => (Math.sin(2 * Math.PI * 440 * t) + Math.sin(2 * Math.PI * 554 * t) + Math.sin(2 * Math.PI * 659 * t)) * 0.12;

/** Signals with a known answer: what each band and the beat detector should do. */
const SIGNALS: Signal[] = [
  { name: 'kick 120 (bass on, beats at 120)', seconds: 12, sample: (t) => kick(t, 120) * 0.8 },
  { name: 'bassline only (bass on, few beats)', seconds: 8, sample: bassline },
  { name: 'hi-hats 8ths (high on, bass off)', seconds: 8, sample: (t) => hats(t, 120) * 0.5 },
  { name: 'chords (mid on, bass off)', seconds: 8, sample: chords },
  { name: 'full mix 100 (all bands, beats at 100)', seconds: 14, sample: (t) => kick(t, 100) * 0.6 + bassline(t) * 0.5 + hats(t, 100) * 0.25 + chords(t) * 0.6 },
  { name: 'quiet full mix (-20 dB, same as above)', seconds: 14, sample: (t) => (kick(t, 100) * 0.6 + bassline(t) * 0.5 + hats(t, 100) * 0.25 + chords(t) * 0.6) * 0.1 },
];

function analyse(name: string, samples: Float32Array) {
  const a = new PcmAnalyser(SR);
  const fx = new FeatureExtractor(SR, a.fftSize);
  const freq = new Float32Array(a.frequencyBinCount);
  const wave = new Float32Array(a.fftSize);
  const per = SR / FPS;
  const bands = { bass: [] as number[], lowMid: [] as number[], mid: [] as number[], high: [] as number[], energy: [] as number[] };
  let beats = 0;
  const frames = Math.floor(samples.length / per);
  for (let i = 0; i < frames; i++) {
    a.push(samples.subarray(i * per, (i + 1) * per));
    a.getFloatFrequencyData(freq);
    a.getFloatTimeDomainData(wave);
    const f = fx.update(freq, wave, 1 / FPS, i / FPS);
    if (f.onBeat) beats++;
    // Skip the first two seconds: the automatic gain is still settling.
    if (i < FPS * 2) continue;
    for (const k of Object.keys(bands) as (keyof typeof bands)[]) bands[k].push(f[k]);
  }
  const pct = (v: number[], p: number) => {
    const s = [...v].sort((x, y) => x - y);
    return s[Math.min(s.length - 1, Math.floor(p * s.length))] ?? 0;
  };
  const cell = (v: number[]) => `${pct(v, 0.1).toFixed(2)}/${pct(v, 0.5).toFixed(2)}/${pct(v, 0.9).toFixed(2)}`;
  const seconds = samples.length / SR;
  console.log(`\n${name}  (${seconds.toFixed(0)} s)`);
  console.log(`  bands p10/p50/p90  bass ${cell(bands.bass)}  lowMid ${cell(bands.lowMid)}  mid ${cell(bands.mid)}  high ${cell(bands.high)}  energy ${cell(bands.energy)}`);
  console.log(`  beats ${beats} (${((beats / seconds) * 60).toFixed(0)} per minute)  tempo ${fx.features.bpm || '—'} (${Math.round(fx.features.bpmConfidence * 100)}%)`);
}

const file = process.argv[2];
if (file && file !== '--synth') {
  const buf = readFileSync(file);
  analyse(file, new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 4)));
} else {
  for (const s of SIGNALS) {
    const out = new Float32Array(Math.floor(s.seconds * SR));
    for (let i = 0; i < out.length; i++) out[i] = s.sample(i / SR);
    analyse(s.name, out);
  }
}
