/**
 * Stands in for an AnalyserNode when the samples come from outside Web Audio: the desktop app
 * streams the system's audio as raw PCM. It uses the same Blackman window, FFT size and dB
 * scale as the Web Audio spec, so the FeatureExtractor can't tell the difference.
 */
export class PcmAnalyser {
  readonly frequencyBinCount: number;
  private readonly ring: Float32Array;
  private writeAt = 0;
  private readonly window: Float32Array;
  private readonly re: Float32Array;
  private readonly im: Float32Array;
  private readonly reverse: Uint32Array;
  private readonly cos: Float32Array;
  private readonly sin: Float32Array;

  constructor(
    readonly sampleRate: number,
    readonly fftSize = 4096,
  ) {
    const n = fftSize;
    this.frequencyBinCount = n / 2;
    this.ring = new Float32Array(n);
    this.re = new Float32Array(n);
    this.im = new Float32Array(n);

    // Blackman with alpha = 0.16, as the Web Audio spec defines it.
    this.window = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      this.window[i] = 0.42 - 0.5 * Math.cos((2 * Math.PI * i) / n) + 0.08 * Math.cos((4 * Math.PI * i) / n);
    }

    const bits = Math.log2(n);
    this.reverse = new Uint32Array(n);
    for (let i = 0; i < n; i++) {
      let r = 0;
      for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
      this.reverse[i] = r;
    }
    this.cos = new Float32Array(n / 2);
    this.sin = new Float32Array(n / 2);
    for (let i = 0; i < n / 2; i++) {
      this.cos[i] = Math.cos((-2 * Math.PI * i) / n);
      this.sin[i] = Math.sin((-2 * Math.PI * i) / n);
    }
  }

  /** Append new samples (mono, -1..1). */
  push(samples: Float32Array) {
    const n = this.fftSize;
    for (let i = 0; i < samples.length; i++) {
      this.ring[this.writeAt] = samples[i];
      this.writeAt = (this.writeAt + 1) % n;
    }
  }

  /** The latest `fftSize` samples, oldest first. */
  getFloatTimeDomainData(out: Float32Array) {
    const n = this.fftSize;
    for (let i = 0; i < n; i++) out[i] = this.ring[(this.writeAt + i) % n];
  }

  /** dBFS per bin of the latest `fftSize` samples, like AnalyserNode with smoothing 0. */
  getFloatFrequencyData(out: Float32Array) {
    const n = this.fftSize;
    const { re, im, window, reverse } = this;
    for (let i = 0; i < n; i++) {
      re[reverse[i]] = this.ring[(this.writeAt + i) % n] * window[i];
      im[reverse[i]] = 0;
    }
    // Iterative radix-2 Cooley–Tukey.
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1;
      const step = n / size;
      for (let start = 0; start < n; start += size) {
        for (let k = 0; k < half; k++) {
          const wr = this.cos[k * step];
          const wi = this.sin[k * step];
          const a = start + k;
          const b = a + half;
          const tr = re[b] * wr - im[b] * wi;
          const ti = re[b] * wi + im[b] * wr;
          re[b] = re[a] - tr;
          im[b] = im[a] - ti;
          re[a] += tr;
          im[a] += ti;
        }
      }
    }
    for (let k = 0; k < this.frequencyBinCount; k++) {
      const mag = Math.hypot(re[k], im[k]) / n;
      out[k] = 20 * Math.log10(mag);
    }
  }
}
