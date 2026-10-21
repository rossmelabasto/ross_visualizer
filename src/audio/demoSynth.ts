// A small procedural track (A minor, 120 BPM) so the demo works without any licensed music.
// Look-ahead scheduling as in "A Tale of Two Clocks" (Chris Wilson).

const BPM = 120;
const STEP = 60 / BPM / 4; // sixteenth note
const LOOKAHEAD = 0.15;

// i – VI – III – VII
const CHORDS = [
  { bass: 33, pad: [57, 60, 64] }, // Am
  { bass: 29, pad: [57, 60, 65] }, // F
  { bass: 36, pad: [55, 60, 64] }, // C
  { bass: 31, pad: [55, 59, 62] }, // G
];
const ARP = [0, 1, 2, 3, 2, 1, 0, 2, 1, 3, 2, 0, 1, 2, 3, 1];

type Section = 'intro' | 'build' | 'drop' | 'break';
function sectionOf(bar: number): Section {
  const b = bar % 32;
  if (b < 4) return 'intro';
  if (b < 8) return 'build';
  if (b < 20) return 'drop';
  if (b < 24) return 'break';
  return 'drop';
}

const midiHz = (m: number) => 440 * Math.pow(2, (m - 69) / 12);

export class DemoSynth {
  paused = false;
  private readonly out: GainNode;
  private readonly bus: GainNode;
  private readonly duck: GainNode;
  private readonly delaySend: GainNode;
  private readonly noise: AudioBuffer;
  private timer = 0;
  private step = 0;
  private nextTime = 0;

  constructor(private readonly ctx: AudioContext) {
    this.out = ctx.createGain();
    this.out.gain.value = 0.9;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.ratio.value = 4;
    comp.attack.value = 0.005;
    comp.release.value = 0.15;
    comp.connect(this.out);
    this.bus = ctx.createGain();
    this.bus.gain.value = 0.55;
    this.bus.connect(comp);
    this.duck = ctx.createGain();
    this.duck.connect(this.bus);

    const delay = ctx.createDelay(1);
    delay.delayTime.value = STEP * 3;
    const fb = ctx.createGain();
    fb.gain.value = 0.32;
    const tone = ctx.createBiquadFilter();
    tone.type = 'lowpass';
    tone.frequency.value = 3200;
    this.delaySend = ctx.createGain();
    this.delaySend.gain.value = 0.35;
    this.delaySend.connect(delay);
    delay.connect(tone);
    tone.connect(fb);
    fb.connect(delay);
    tone.connect(this.duck);

    this.noise = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }

  connect(node: AudioNode) {
    this.out.connect(node);
  }

  start() {
    this.nextTime = this.ctx.currentTime + 0.05;
    this.timer = window.setInterval(() => this.tick(), 25);
  }

  stop() {
    clearInterval(this.timer);
    const t = this.ctx.currentTime;
    this.out.gain.setTargetAtTime(0, t, 0.05);
    setTimeout(() => this.out.disconnect(), 400);
  }

  toggle() {
    this.paused = !this.paused;
    const t = this.ctx.currentTime;
    this.out.gain.setTargetAtTime(this.paused ? 0 : 0.9, t, 0.03);
    if (!this.paused) this.nextTime = t + 0.05;
  }

  private tick() {
    if (this.paused) return;
    while (this.nextTime < this.ctx.currentTime + LOOKAHEAD) {
      this.schedule(this.step, this.nextTime);
      this.nextTime += STEP;
      this.step++;
    }
  }

  private schedule(step: number, t: number) {
    const s = step % 16;
    const bar = Math.floor(step / 16);
    const section = sectionOf(bar);
    const chord = CHORDS[bar % 4];
    const full = section === 'drop';

    if (s === 0) this.pad(chord.pad, t, section);
    if ((full || (section === 'build' && bar % 32 >= 6)) && s % 4 === 0) this.kick(t);
    if (full && (s === 4 || s === 12)) this.clap(t);
    if (section !== 'intro' || s % 4 === 2) {
      const open = s % 4 === 2;
      if (open || full) this.hat(t, open ? 0.2 : 0.07, open ? 0.09 : 0.03);
    }
    if (section === 'build' || full) {
      if (s === 0 || s % 4 === 2 || (s === 15 && bar % 2 === 1)) this.bass(chord.bass + (s === 15 ? 12 : 0), t, full ? 0.9 : 0.55);
    }
    if (section !== 'intro') {
      const note = chord.pad[ARP[s] % 3] + 12 + (ARP[s] === 3 ? 12 : 0);
      this.pluck(note, t, section === 'break' ? 0.16 : 0.1);
    }
    if ((bar % 32 === 7 || bar % 32 === 23) && s === 0) this.riser(t, STEP * 16);
  }

  private env(g: GainNode, t: number, peak: number, attack: number, decay: number) {
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
  }

  private kick(t: number) {
    const o = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    o.frequency.setValueAtTime(160, t);
    o.frequency.exponentialRampToValueAtTime(42, t + 0.12);
    this.env(g, t, 1.1, 0.002, 0.38);
    o.connect(g).connect(this.bus);
    o.start(t);
    o.stop(t + 0.45);
    // Sidechain-style duck on everything else.
    this.duck.gain.setValueAtTime(0.35, t);
    this.duck.gain.setTargetAtTime(1, t + 0.03, 0.09);
  }

  private noiseHit(t: number, type: BiquadFilterType, freq: number, q: number, peak: number, decay: number) {
    const src = this.ctx.createBufferSource();
    src.buffer = this.noise;
    const f = this.ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = q;
    const g = this.ctx.createGain();
    this.env(g, t, peak, 0.002, decay);
    src.connect(f).connect(g).connect(this.duck);
    src.start(t, Math.random() * 0.5);
    src.stop(t + decay + 0.05);
  }

  private clap(t: number) {
    this.noiseHit(t, 'bandpass', 1500, 0.9, 0.9, 0.2);
    this.noiseHit(t + 0.012, 'bandpass', 2200, 1.2, 0.4, 0.12);
  }

  private hat(t: number, peak: number, decay: number) {
    this.noiseHit(t, 'highpass', 8500, 0.7, peak, decay);
  }

  private bass(midi: number, t: number, level: number) {
    const o = this.ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.value = midiHz(midi);
    const f = this.ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.Q.value = 6;
    f.frequency.setValueAtTime(900, t);
    f.frequency.exponentialRampToValueAtTime(140, t + 0.18);
    const g = this.ctx.createGain();
    this.env(g, t, 0.5 * level, 0.005, 0.22);
    o.connect(f).connect(g).connect(this.duck);
    o.start(t);
    o.stop(t + 0.3);
  }

  private pluck(midi: number, t: number, level: number) {
    const o = this.ctx.createOscillator();
    o.type = 'triangle';
    o.frequency.value = midiHz(midi);
    const o2 = this.ctx.createOscillator();
    o2.type = 'square';
    o2.frequency.value = midiHz(midi) * 1.003;
    const f = this.ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.setValueAtTime(4000, t);
    f.frequency.exponentialRampToValueAtTime(600, t + 0.15);
    const g = this.ctx.createGain();
    this.env(g, t, level, 0.003, 0.18);
    const g2 = this.ctx.createGain();
    g2.gain.value = 0.25;
    o.connect(f);
    o2.connect(g2).connect(f);
    f.connect(g);
    g.connect(this.duck);
    g.connect(this.delaySend);
    o.start(t);
    o2.start(t);
    o.stop(t + 0.25);
    o2.stop(t + 0.25);
  }

  private pad(notes: number[], t: number, section: Section) {
    const dur = STEP * 16;
    const f = this.ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.Q.value = 2;
    const open = section === 'drop' ? 2400 : section === 'break' ? 900 : 1300;
    f.frequency.setValueAtTime(open * 0.5, t);
    f.frequency.linearRampToValueAtTime(open, t + dur * 0.6);
    const g = this.ctx.createGain();
    const level = section === 'break' ? 0.16 : 0.1;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(level, t + 0.25);
    g.gain.setValueAtTime(level, t + dur - 0.1);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur + 0.4);
    f.connect(g).connect(this.duck);
    for (const n of notes) {
      for (const detune of [-9, 9]) {
        const o = this.ctx.createOscillator();
        o.type = 'sawtooth';
        o.frequency.value = midiHz(n);
        o.detune.value = detune;
        o.connect(f);
        o.start(t);
        o.stop(t + dur + 0.5);
      }
    }
  }

  private riser(t: number, dur: number) {
    const src = this.ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    const f = this.ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.Q.value = 3;
    f.frequency.setValueAtTime(400, t);
    f.frequency.exponentialRampToValueAtTime(9000, t + dur);
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.25, t + dur);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur + 0.05);
    src.connect(f).connect(g).connect(this.bus);
    src.start(t);
    src.stop(t + dur + 0.1);
  }
}
