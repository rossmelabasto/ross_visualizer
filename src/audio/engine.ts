import { FeatureExtractor, type AudioFeatures } from './features';
import { DemoSynth } from './demoSynth';

export type SourceKind = 'none' | 'media' | 'mic' | 'system' | 'demo';

export class SourceError extends Error {
  constructor(
    readonly code: 'denied' | 'unsupported' | 'no-audio-track' | 'load-failed',
    message: string,
  ) {
    super(message);
  }
}

type Listener = () => void;

/**
 * Owns the AudioContext and whatever is feeding the analyser.
 * Only one source is active at a time; switching stops the previous one.
 */
export class AudioEngine {
  ctx: AudioContext | null = null;
  kind: SourceKind = 'none';
  extractor: FeatureExtractor | null = null;
  readonly media: HTMLAudioElement;

  private analyser!: AnalyserNode;
  private output!: GainNode;
  private freq!: Float32Array<ArrayBuffer>;
  private wave!: Float32Array<ArrayBuffer>;
  private mediaNode: MediaElementAudioSourceNode | null = null;
  private stream: MediaStream | null = null;
  private streamNode: MediaStreamAudioSourceNode | null = null;
  private synth: DemoSynth | null = null;
  private listeners = new Map<string, Set<Listener>>();
  private sensitivity = 1;

  constructor() {
    this.media = new Audio();
    this.media.crossOrigin = 'anonymous';
    this.media.preload = 'auto';
    for (const ev of ['ended', 'play', 'pause', 'timeupdate', 'error'] as const) {
      this.media.addEventListener(ev, () => this.emit(`media:${ev}`));
    }
  }

  on(event: string, fn: Listener) {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event)!.add(fn);
    return () => this.listeners.get(event)!.delete(fn);
  }

  private emit(event: string) {
    this.listeners.get(event)?.forEach((fn) => fn());
  }

  /** Must be called from a user gesture the first time (autoplay policies). */
  async ensureContext(): Promise<AudioContext> {
    if (!this.ctx) {
      const ctx = new AudioContext({ latencyHint: 'interactive' });
      this.analyser = ctx.createAnalyser();
      this.analyser.fftSize = 4096;
      this.analyser.smoothingTimeConstant = 0;
      this.analyser.minDecibels = -110;
      this.analyser.maxDecibels = -10;
      this.output = ctx.createGain();
      this.output.connect(ctx.destination);
      this.freq = new Float32Array(this.analyser.frequencyBinCount);
      this.wave = new Float32Array(this.analyser.fftSize);
      this.extractor = new FeatureExtractor(ctx.sampleRate, this.analyser.fftSize, { sensitivity: this.sensitivity });
      this.ctx = ctx;
    }
    if (this.ctx.state !== 'running') await this.ctx.resume();
    return this.ctx;
  }

  setSensitivity(v: number) {
    this.sensitivity = v;
    if (this.extractor) this.extractor.sensitivity = v;
  }

  setVolume(v: number) {
    if (this.output) this.output.gain.value = v;
  }

  private stopCurrent() {
    if (this.kind === 'media') {
      this.media.pause();
    }
    if (this.streamNode) {
      this.streamNode.disconnect();
      this.streamNode = null;
    }
    if (this.stream) {
      this.stream.getTracks().forEach((t) => t.stop());
      this.stream = null;
    }
    if (this.synth) {
      this.synth.stop();
      this.synth = null;
    }
    this.kind = 'none';
  }

  stop() {
    this.stopCurrent();
    this.emit('source');
  }

  async playUrl(url: string): Promise<void> {
    const ctx = await this.ensureContext();
    this.stopCurrent();
    if (!this.mediaNode) {
      this.mediaNode = ctx.createMediaElementSource(this.media);
      this.mediaNode.connect(this.analyser);
      this.mediaNode.connect(this.output);
    }
    this.media.src = url;
    this.kind = 'media';
    this.emit('source');
    try {
      await this.media.play();
    } catch (e) {
      throw new SourceError('load-failed', String(e));
    }
  }

  async toggleMedia() {
    if (this.kind === 'media') {
      if (this.media.paused) await this.media.play();
      else this.media.pause();
    } else if (this.kind === 'demo' && this.synth) {
      this.synth.toggle();
      this.emit('media:pause');
    }
  }

  get paused(): boolean {
    if (this.kind === 'media') return this.media.paused;
    if (this.kind === 'demo') return !!this.synth?.paused;
    return false;
  }

  async useMic(): Promise<void> {
    if (!navigator.mediaDevices?.getUserMedia) throw new SourceError('unsupported', 'getUserMedia');
    const ctx = await this.ensureContext();
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      });
    } catch (e) {
      throw new SourceError('denied', String(e));
    }
    this.attachStream(ctx, stream, 'mic');
  }

  static get canCaptureSystem(): boolean {
    const touch = matchMedia('(pointer: coarse)').matches;
    return !!navigator.mediaDevices && 'getDisplayMedia' in navigator.mediaDevices && !touch;
  }

  async useSystem(): Promise<void> {
    if (!AudioEngine.canCaptureSystem) throw new SourceError('unsupported', 'getDisplayMedia');
    const ctx = await this.ensureContext();
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
        // Chromium-only hints: offer "share system audio" and prefer the whole screen.
        ...({ systemAudio: 'include', selfBrowserSurface: 'exclude', monitorTypeSurfaces: 'include' } as object),
      } as DisplayMediaStreamOptions);
    } catch (e) {
      throw new SourceError('denied', String(e));
    }
    stream.getVideoTracks().forEach((t) => t.stop());
    if (stream.getAudioTracks().length === 0) {
      throw new SourceError('no-audio-track', 'no audio track');
    }
    this.attachStream(ctx, stream, 'system');
  }

  private attachStream(ctx: AudioContext, stream: MediaStream, kind: 'mic' | 'system') {
    this.stopCurrent();
    this.stream = stream;
    this.streamNode = ctx.createMediaStreamSource(stream);
    this.streamNode.connect(this.analyser);
    this.kind = kind;
    stream.getAudioTracks()[0]?.addEventListener('ended', () => {
      if (this.stream === stream) this.stop();
    });
    this.emit('source');
  }

  async useDemo(): Promise<void> {
    const ctx = await this.ensureContext();
    this.stopCurrent();
    this.synth = new DemoSynth(ctx);
    this.synth.connect(this.analyser);
    this.synth.connect(this.output);
    this.synth.start();
    this.kind = 'demo';
    this.emit('source');
  }

  /** Pull one analysis frame. Returns null when nothing is connected. */
  frame(dt: number, now: number): AudioFeatures | null {
    if (!this.ctx || this.kind === 'none' || !this.extractor) return null;
    this.analyser.getFloatFrequencyData(this.freq);
    this.analyser.getFloatTimeDomainData(this.wave);
    return this.extractor.update(this.freq, this.wave, dt, now);
  }
}
