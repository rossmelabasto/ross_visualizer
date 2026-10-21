// Turns raw FFT frames into the few numbers the scenes care about.
// Pure (no Web Audio here) so it can be tested with synthetic spectra.

export const SPECTRUM_BINS = 128;
export const WAVEFORM_SAMPLES = 256;

export interface AudioFeatures {
  /** Smoothed, auto-gained band levels in 0..1. */
  bass: number;
  lowMid: number;
  mid: number;
  high: number;
  energy: number;
  /** 1 right on a detected beat, decays towards 0. */
  beat: number;
  beatCount: number;
  onBeat: boolean;
  /** Estimated tempo, 0 while unknown. */
  bpm: number;
  bpmConfidence: number;
  /** Spectral centroid on a log scale, 0 (dark) .. 1 (bright). */
  centroid: number;
  /** Overall novelty, 0..1. */
  flux: number;
  silent: boolean;
  spectrum: Float32Array;
  waveform: Float32Array;
}

export function emptyFeatures(): AudioFeatures {
  return {
    bass: 0,
    lowMid: 0,
    mid: 0,
    high: 0,
    energy: 0,
    beat: 0,
    beatCount: 0,
    onBeat: false,
    bpm: 0,
    bpmConfidence: 0,
    centroid: 0.5,
    flux: 0,
    silent: true,
    spectrum: new Float32Array(SPECTRUM_BINS),
    waveform: new Float32Array(WAVEFORM_SAMPLES),
  };
}

const BANDS = {
  bass: [35, 160],
  lowMid: [160, 600],
  mid: [600, 3000],
  high: [3000, 14000],
} as const;
type BandName = keyof typeof BANDS;

const KICK_RANGE = [40, 160] as const;
const FLUX_RANGE = [40, 9000] as const;
const SPECTRUM_RANGE = [32, 16000] as const;

/** Linear magnitude below which we consider the input silent (about -72 dBFS). */
const NOISE_FLOOR = 2.5e-4;

/** Exponential smoothing with separate attack/release time constants (seconds). */
function follow(current: number, target: number, dt: number, attack: number, release: number): number {
  const tau = target > current ? attack : release;
  return current + (target - current) * (1 - Math.exp(-dt / tau));
}

class RollingStats {
  private values: number[] = [];
  private times: number[] = [];
  constructor(private window: number) {}

  push(t: number, v: number) {
    this.values.push(v);
    this.times.push(t);
    while (this.times.length && t - this.times[0] > this.window) {
      this.times.shift();
      this.values.shift();
    }
  }

  get count() {
    return this.values.length;
  }

  /** Seconds of history currently held. */
  get span() {
    return this.times.length > 1 ? this.times[this.times.length - 1] - this.times[0] : 0;
  }

  meanStd(): [number, number] {
    const n = this.values.length;
    if (!n) return [0, 0];
    let s = 0;
    for (const v of this.values) s += v;
    const mean = s / n;
    let q = 0;
    for (const v of this.values) q += (v - mean) ** 2;
    return [mean, Math.sqrt(q / n)];
  }
}

export interface ExtractorOptions {
  /** Multiplies band levels before clamping. 1 = neutral. */
  sensitivity?: number;
}

export class FeatureExtractor {
  readonly features = emptyFeatures();
  sensitivity: number;

  private readonly binHz: number;
  private readonly mag: Float32Array;
  private readonly prevLog: Float32Array;
  private readonly specLo: Int32Array;
  private readonly specHi: Int32Array;
  private readonly tilt: Float32Array;
  private bandPeaks: Record<BandName, number> = { bass: 0, lowMid: 0, mid: 0, high: 0 };
  private specPeak = 0;
  private globalPeak = 0;
  private kickStats = new RollingStats(1.5);
  private fluxStats = new RollingStats(1.5);
  private lastBeat = -10;
  private beatTimes: number[] = [];
  private silentFor = 0;
  private fluxPeak = 1e-6;
  private hasPrev = false;
  private prevSpec = new Float32Array(SPECTRUM_BINS);

  constructor(
    readonly sampleRate: number,
    readonly fftSize: number,
    opts: ExtractorOptions = {},
  ) {
    this.sensitivity = opts.sensitivity ?? 1;
    const bins = fftSize / 2;
    this.binHz = sampleRate / fftSize;
    this.mag = new Float32Array(bins);
    this.prevLog = new Float32Array(bins);
    this.specLo = new Int32Array(SPECTRUM_BINS);
    this.specHi = new Int32Array(SPECTRUM_BINS);
    this.tilt = new Float32Array(SPECTRUM_BINS);
    const [f0, f1] = SPECTRUM_RANGE;
    for (let i = 0; i < SPECTRUM_BINS; i++) {
      const a = f0 * Math.pow(f1 / f0, i / SPECTRUM_BINS);
      const b = f0 * Math.pow(f1 / f0, (i + 1) / SPECTRUM_BINS);
      const lo = Math.min(bins - 1, Math.max(1, Math.floor(a / this.binHz)));
      this.specLo[i] = lo;
      this.specHi[i] = Math.max(lo, Math.min(bins - 1, Math.ceil(b / this.binHz) - 1));
      // Music falls off ~3–4.5 dB/octave; compensate so the highs aren't always flat.
      this.tilt[i] = Math.pow(Math.sqrt(a * b) / 1000, 0.6);
    }
  }

  private bin(hz: number) {
    return Math.min(this.mag.length - 1, Math.max(1, Math.round(hz / this.binHz)));
  }

  private bandLevel(lo: number, hi: number) {
    const a = this.bin(lo);
    const b = Math.max(a, this.bin(hi));
    let s = 0;
    for (let i = a; i <= b; i++) s += this.mag[i] * this.mag[i];
    return Math.sqrt(s / (b - a + 1));
  }

  /**
   * @param freqDb   AnalyserNode.getFloatFrequencyData output (dBFS per bin).
   * @param waveform Optional time-domain samples (-1..1).
   * @param dt       Seconds since the previous call.
   * @param now      Monotonic time in seconds.
   */
  update(freqDb: Float32Array, waveform: Float32Array | null, dt: number, now: number): AudioFeatures {
    const f = this.features;
    dt = Math.min(Math.max(dt, 1 / 240), 0.1);
    const n = Math.min(freqDb.length, this.mag.length);
    for (let i = 0; i < n; i++) {
      const db = freqDb[i];
      this.mag[i] = db > -160 && Number.isFinite(db) ? Math.pow(10, db / 20) : 0;
    }

    // --- silence -------------------------------------------------------------
    const overall = this.bandLevel(35, 14000);
    this.silentFor = overall < NOISE_FLOOR ? this.silentFor + dt : 0;
    f.silent = this.silentFor > 0.4;

    // --- bands with automatic gain ------------------------------------------
    const decay = Math.exp(-dt / 8);
    this.globalPeak = Math.max(overall, this.globalPeak * decay, NOISE_FLOOR * 4);
    let energy = 0;
    for (const name of Object.keys(BANDS) as BandName[]) {
      const [lo, hi] = BANDS[name];
      const raw = this.bandLevel(lo, hi);
      this.bandPeaks[name] = Math.max(raw, this.bandPeaks[name] * decay);
      const ref = Math.max(this.bandPeaks[name], this.globalPeak * 0.12, NOISE_FLOOR * 2);
      let v = f.silent ? 0 : Math.min(1, Math.pow(raw / ref, 1.35) * this.sensitivity);
      const attack = name === 'bass' ? 0.02 : 0.035;
      const release = name === 'high' ? 0.12 : 0.22;
      v = follow(f[name], v, dt, attack, release);
      f[name] = v;
      energy += v * (name === 'bass' ? 0.4 : name === 'lowMid' ? 0.2 : name === 'mid' ? 0.25 : 0.15);
    }
    f.energy = follow(f.energy, energy, dt, 0.08, 0.5);

    // --- log spectrum for the shaders ---------------------------------------
    let specMax = 0;
    for (let i = 0; i < SPECTRUM_BINS; i++) {
      let m = 0;
      for (let j = this.specLo[i]; j <= this.specHi[i]; j++) m = Math.max(m, this.mag[j]);
      m *= this.tilt[i];
      specMax = Math.max(specMax, m);
      this.prevSpec[i] = m;
    }
    this.specPeak = Math.max(specMax, this.specPeak * decay, NOISE_FLOOR * 4);
    for (let i = 0; i < SPECTRUM_BINS; i++) {
      // 54 dB of visible range under the running peak.
      const db = 20 * Math.log10(Math.max(this.prevSpec[i], 1e-9) / this.specPeak);
      const v = f.silent ? 0 : Math.min(1, Math.max(0, 1 + db / 54) * this.sensitivity);
      f.spectrum[i] = follow(f.spectrum[i], v, dt, 0.015, 0.18);
    }

    // --- centroid ------------------------------------------------------------
    let num = 0;
    let den = 0;
    for (let i = this.bin(40); i <= this.bin(12000); i++) {
      num += i * this.binHz * this.mag[i];
      den += this.mag[i];
    }
    const centroidHz = den > 0 ? num / den : 1000;
    const c = Math.min(1, Math.max(0, Math.log2(centroidHz / 150) / Math.log2(6000 / 150)));
    f.centroid = follow(f.centroid, c, dt, 0.4, 0.4);

    // --- onsets --------------------------------------------------------------
    let kick = 0;
    let flux = 0;
    const k0 = this.bin(KICK_RANGE[0]);
    const k1 = this.bin(KICK_RANGE[1]);
    const f0 = this.bin(FLUX_RANGE[0]);
    const f1 = this.bin(FLUX_RANGE[1]);
    const scale = 1 / Math.max(this.globalPeak, NOISE_FLOOR);
    for (let i = f0; i <= f1; i++) {
      const lg = Math.log1p(this.mag[i] * scale * 10);
      const d = this.hasPrev ? lg - this.prevLog[i] : 0;
      this.prevLog[i] = lg;
      if (d > 0) {
        flux += d;
        if (i >= k0 && i <= k1) kick += d;
      }
    }
    for (let i = 0; i < f0; i++) this.prevLog[i] = 0;
    this.hasPrev = true;
    kick /= Math.max(1, k1 - k0 + 1);
    flux /= Math.max(1, f1 - f0 + 1);

    this.fluxPeak = Math.max(flux, this.fluxPeak * Math.exp(-dt / 4), 1e-4);
    f.flux = follow(f.flux, Math.min(1, flux / this.fluxPeak), dt, 0.02, 0.15);

    const [km, ks] = this.kickStats.meanStd();
    const [fm, fs] = this.fluxStats.meanStd();
    // Warm-up by time, not frame count: slow devices may only give us ~10 frames per second.
    const warm = this.kickStats.count >= 6 && this.kickStats.span > 0.8;
    const sinceBeat = now - this.lastBeat;
    let isBeat = false;
    if (warm && !f.silent && sinceBeat > 0.27) {
      const kickHit = kick > km + 1.6 * ks && kick > 0.04;
      // Music without a clear kick: fall back to broadband novelty, a bit stricter.
      const fluxHit = sinceBeat > 1.2 && flux > fm + 2.2 * fs && flux > 0.02;
      isBeat = kickHit || fluxHit;
    }
    this.kickStats.push(now, kick);
    this.fluxStats.push(now, flux);

    f.onBeat = isBeat;
    if (isBeat) {
      this.lastBeat = now;
      f.beatCount++;
      this.beatTimes.push(now);
      if (this.beatTimes.length > 32) this.beatTimes.shift();
      this.estimateTempo();
    }
    f.beat = Math.exp(-(now - this.lastBeat) / 0.16);
    if (now - this.lastBeat > 6) {
      f.bpmConfidence = follow(f.bpmConfidence, 0, dt, 1, 1);
    }

    if (waveform) resample(waveform, f.waveform);
    return f;
  }


  private estimateTempo() {
    const t = this.beatTimes;
    if (t.length < 8) return;
    const hist = new Float32Array(100); // 80..179 BPM
    let votes = 0;
    for (let i = 1; i < t.length; i++) {
      for (let skip = 1; skip <= 2 && i - skip >= 0; skip++) {
        const ioi = (t[i] - t[i - skip]) / skip;
        if (ioi < 0.25 || ioi > 2) continue;
        let bpm = 60 / ioi;
        while (bpm < 80) bpm *= 2;
        while (bpm >= 180) bpm /= 2;
        const w = skip === 1 ? 1 : 0.6;
        for (let d = -2; d <= 2; d++) {
          const b = Math.round(bpm) - 80 + d;
          if (b >= 0 && b < 100) hist[b] += w * Math.exp(-(d * d) / 2);
        }
        votes += w;
      }
    }
    let best = 0;
    for (let i = 1; i < 100; i++) if (hist[i] > hist[best]) best = i;
    const total = hist.reduce((a, b) => a + b, 0);
    this.features.bpm = best + 80;
    this.features.bpmConfidence = votes ? Math.min(1, (hist[best] / total) * 6) : 0;
  }
}

function resample(src: Float32Array, dst: Float32Array) {
  const step = src.length / dst.length;
  for (let i = 0; i < dst.length; i++) dst[i] = src[Math.floor(i * step)] ?? 0;
}

/** Gentle fake input so the idle screen breathes instead of sitting still. */
export function idleFeatures(f: AudioFeatures, t: number): AudioFeatures {
  const slow = 0.5 + 0.5 * Math.sin(t * 0.6);
  f.bass = 0.18 + 0.12 * slow;
  f.lowMid = 0.15 + 0.1 * Math.sin(t * 0.43 + 1);
  f.mid = 0.14 + 0.08 * Math.sin(t * 0.37 + 2);
  f.high = 0.1 + 0.06 * Math.sin(t * 0.71 + 3);
  f.energy = 0.16 + 0.08 * slow;
  f.beat = Math.pow(Math.max(0, Math.sin(t * Math.PI * 0.5)), 24) * 0.4;
  f.onBeat = false;
  f.centroid = 0.45 + 0.1 * Math.sin(t * 0.2);
  f.flux = 0.1;
  f.silent = false;
  for (let i = 0; i < f.spectrum.length; i++) {
    const x = i / f.spectrum.length;
    f.spectrum[i] = Math.max(0, (0.32 - x * 0.22) * (0.75 + 0.25 * Math.sin(t * 1.3 + i * 0.35)));
  }
  for (let i = 0; i < f.waveform.length; i++) {
    f.waveform[i] = 0.12 * Math.sin(i * 0.07 + t * 2) * Math.sin(t * 0.5 + i * 0.01);
  }
  return f;
}
