import { describe, expect, it } from 'vitest';
import { FeatureExtractor } from '../src/audio/features';
import { PcmAnalyser } from '../src/audio/pcm';

const SR = 48000;

describe('PcmAnalyser', () => {
  it('finds a 1 kHz tone in the right bin at the AnalyserNode level', () => {
    const a = new PcmAnalyser(SR);
    const tone = new Float32Array(a.fftSize).map((_, i) => Math.sin((2 * Math.PI * 1000 * i) / SR));
    a.push(tone);
    const db = new Float32Array(a.frequencyBinCount);
    a.getFloatFrequencyData(db);
    const peak = db.indexOf(Math.max(...db));
    expect(Math.abs(peak - (1000 * a.fftSize) / SR)).toBeLessThanOrEqual(1);
    // Full-scale sine through a Blackman window: about 20·log10(0.42 / 2) ≈ -13.6 dBFS.
    expect(db[peak]).toBeGreaterThan(-16);
    expect(db[peak]).toBeLessThan(-11);
  });

  it('turns garbage samples into silence instead of poisoning the spectrum', () => {
    const a = new PcmAnalyser(SR);
    a.push(new Float32Array([NaN, Infinity, -Infinity, 3e38, ...new Array(4092).fill(0.1)]));
    const db = new Float32Array(a.frequencyBinCount);
    a.getFloatFrequencyData(db);
    expect(db.every((v) => !Number.isNaN(v))).toBe(true);
  });

  it('feeds the beat detector well enough to find 120 BPM in raw PCM', () => {
    const a = new PcmAnalyser(SR);
    const fx = new FeatureExtractor(SR, a.fftSize);
    const freq = new Float32Array(a.frequencyBinCount);
    const wave = new Float32Array(a.fftSize);
    const chunk = SR / 60;
    let seed = 7;
    const noise = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
    let n = 0;
    let beats = 0;
    for (let frame = 0; frame < 60 * 12; frame++) {
      const block = new Float32Array(chunk);
      for (let i = 0; i < chunk; i++, n++) {
        const t = n / SR;
        const phase = t % 0.5;
        // Kick: a 55 Hz thump that dies out in ~120 ms, over a quiet hiss.
        const kick = Math.sin(2 * Math.PI * 55 * phase) * Math.exp(-phase * 25) * 0.8;
        block[i] = kick + noise() * 0.02;
      }
      a.push(block);
      a.getFloatFrequencyData(freq);
      a.getFloatTimeDomainData(wave);
      const f = fx.update(freq, wave, 1 / 60, frame / 60);
      if (f.onBeat) beats++;
    }
    expect(Math.abs(fx.features.bpm - 120)).toBeLessThanOrEqual(3);
    // 24 kicks in 12 s; the detector needs a moment to warm up.
    expect(beats).toBeGreaterThanOrEqual(18);
    expect(beats).toBeLessThanOrEqual(25);
  });

  it('shows the highs of a quiet mix as much as a loud one', () => {
    // Kick + hi-hat hiss, at full level and 20 dB down: the high band should read the same.
    const highs = (gain: number) => {
      const a = new PcmAnalyser(SR);
      const fx = new FeatureExtractor(SR, a.fftSize);
      const freq = new Float32Array(a.frequencyBinCount);
      let seed = 11;
      let prev = 0;
      const values: number[] = [];
      for (let frame = 0; frame < 60 * 8; frame++) {
        const block = new Float32Array(SR / 60);
        for (let i = 0; i < block.length; i++) {
          const t = (frame * block.length + i) / SR;
          const p = t % 0.5;
          const white = ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1;
          const hiss = white - prev;
          prev = white;
          block[i] = (Math.sin(2 * Math.PI * 55 * p) * Math.exp(-p * 20) * 0.7 + hiss * Math.exp(-(t % 0.25) * 40) * 0.2) * gain;
        }
        a.push(block);
        a.getFloatFrequencyData(freq);
        const f = fx.update(freq, null, 1 / 60, frame / 60);
        if (frame > 120) values.push(f.high);
      }
      return values.reduce((s, v) => s + v, 0) / values.length;
    };
    const loud = highs(1);
    const quiet = highs(0.1);
    expect(loud).toBeGreaterThan(0.1);
    expect(Math.abs(loud - quiet)).toBeLessThan(0.08);
  });
});
