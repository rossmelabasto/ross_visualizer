import { describe, expect, it } from 'vitest';
import { FeatureExtractor } from '../src/audio/features';

const SR = 48000;
const FFT = 4096;
const BINS = FFT / 2;
const HZ = SR / FFT;

/** A dBFS spectrum with a noise floor plus a few bumps. */
function spectrum(bumps: { from: number; to: number; db: number }[], floor = -95) {
  const s = new Float32Array(BINS).fill(floor);
  for (const b of bumps) for (let i = Math.floor(b.from / HZ); i <= Math.ceil(b.to / HZ); i++) s[i] = Math.max(s[i], b.db);
  return s;
}

/** Simulate `seconds` of a kick at `bpm` over a steady hi-hat bed, at 60 fps. */
function runKick(bpm: number, seconds: number, fps = 60) {
  const fx = new FeatureExtractor(SR, FFT);
  const period = 60 / bpm;
  const dt = 1 / fps;
  let beats = 0;
  for (let t = 0; t < seconds; t += dt) {
    const phase = t % period;
    const kick = phase < 0.12 ? -18 - (phase / 0.12) * 40 : -80;
    const f = fx.update(
      spectrum([
        { from: 45, to: 140, db: kick },
        { from: 6000, to: 10000, db: -45 + Math.sin(t * 40) * 3 },
        { from: 400, to: 2000, db: -40 },
      ]),
      null,
      dt,
      t,
    );
    if (f.onBeat) beats++;
  }
  return { fx, beats };
}

describe('FeatureExtractor', () => {
  it('detects kicks and estimates the tempo', () => {
    const { fx, beats } = runKick(120, 12);
    // ~24 kicks minus the warm-up second.
    expect(beats).toBeGreaterThanOrEqual(20);
    expect(beats).toBeLessThanOrEqual(25);
    expect(Math.abs(fx.features.bpm - 120)).toBeLessThanOrEqual(2);
    expect(fx.features.bpmConfidence).toBeGreaterThan(0.5);
  });

  it('still finds beats when the page only gets ~12 frames per second', () => {
    const { fx, beats } = runKick(100, 15, 12);
    expect(beats).toBeGreaterThanOrEqual(18);
    expect(Math.abs(fx.features.bpm - 100)).toBeLessThanOrEqual(3);
  });

  it('folds tempos into 80–180', () => {
    const { fx } = runKick(140, 14);
    expect(Math.abs(fx.features.bpm - 140)).toBeLessThanOrEqual(2);
  });

  it('separates bass from treble', () => {
    const fx = new FeatureExtractor(SR, FFT);
    let f = fx.features;
    for (let i = 0; i < 120; i++) f = fx.update(spectrum([{ from: 60, to: 100, db: -20 }, { from: 5000, to: 9000, db: -75 }]), null, 1 / 60, i / 60);
    expect(f.bass).toBeGreaterThan(0.6);
    expect(f.high).toBeLessThan(f.bass);
  });

  it('goes quiet on silence', () => {
    const fx = new FeatureExtractor(SR, FFT);
    let f = fx.features;
    for (let i = 0; i < 120; i++) f = fx.update(spectrum([{ from: 60, to: 3000, db: -20 }]), null, 1 / 60, i / 60);
    for (let i = 120; i < 240; i++) f = fx.update(spectrum([], -140), null, 1 / 60, i / 60);
    expect(f.silent).toBe(true);
    expect(f.bass).toBeLessThan(0.01);
    expect(Math.max(...f.spectrum)).toBeLessThan(0.01);
  });

  it('keeps every output in range', () => {
    const fx = new FeatureExtractor(SR, FFT, { sensitivity: 2 });
    for (let i = 0; i < 300; i++) {
      const f = fx.update(spectrum([{ from: 30, to: 16000, db: -10 + (i % 7) }]), null, 1 / 60, i / 60);
      for (const v of [f.bass, f.lowMid, f.mid, f.high, f.energy, f.beat, f.centroid, f.flux, ...f.spectrum]) {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
      }
    }
  });
});
