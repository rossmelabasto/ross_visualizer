import type { AudioFeatures } from '../audio/features';
import { FULLSCREEN_VS, PRELUDE } from './glsl';
import { POST_FS, BRIGHT_FS, BLUR_FS } from './post';

export interface Target {
  fbo: WebGLFramebuffer;
  tex: WebGLTexture;
  w: number;
  h: number;
}

export interface FrameState {
  time: number;
  dt: number;
  flow: number;
  /** Smooth clock driven by the slow energy average. */
  drift: number;
  slowBass: number;
  slowEnergy: number;
  /** Bass, mid and high smoothed over ~0.4 s. */
  medBands: [number, number, number];
  features: AudioFeatures;
  palette: Float32Array;
  /** 0..1, how bright the current artwork is (scenes may tone down for pale covers). */
  brightness: number;
  cover: CoverState;
  title: string;
  quality: number;
  /** True while the host wants a transparent background (overlay modes). */
  transparent: boolean;
}

export interface CoverState {
  tex: WebGLTexture;
  prev: WebGLTexture;
  /** 0 → prev, 1 → current. */
  mix: number;
  has: boolean;
}

export interface Scene {
  readonly id: string;
  /** Render resolution relative to the canvas (0.5 = half). */
  readonly scale: number;
  init(r: Renderer): void;
  render(r: Renderer, frame: FrameState, target: Target): void;
  resize?(r: Renderer): void;
}

export class Program {
  private locs = new Map<string, WebGLUniformLocation | null>();
  constructor(
    readonly gl: WebGL2RenderingContext,
    readonly handle: WebGLProgram,
  ) {}

  loc(name: string) {
    if (!this.locs.has(name)) this.locs.set(name, this.gl.getUniformLocation(this.handle, name));
    return this.locs.get(name)!;
  }

  use() {
    this.gl.useProgram(this.handle);
    return this;
  }

  f(name: string, ...v: number[]) {
    const l = this.loc(name);
    if (!l) return this;
    const gl = this.gl;
    if (v.length === 1) gl.uniform1f(l, v[0]);
    else if (v.length === 2) gl.uniform2f(l, v[0], v[1]);
    else if (v.length === 3) gl.uniform3f(l, v[0], v[1], v[2]);
    else gl.uniform4f(l, v[0], v[1], v[2], v[3]);
    return this;
  }

  i(name: string, v: number) {
    const l = this.loc(name);
    if (l) this.gl.uniform1i(l, v);
    return this;
  }

  v3(name: string, data: Float32Array) {
    const l = this.loc(name);
    if (l) this.gl.uniform3fv(l, data);
    return this;
  }

  tex(name: string, unit: number, tex: WebGLTexture) {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    return this.i(name, unit);
  }
}

export class Renderer {
  readonly gl: WebGL2RenderingContext;
  width = 1;
  height = 1;
  pixelRatio = 1;
  readonly hdr: boolean;

  private emptyVao: WebGLVertexArrayObject;
  private audioTex: WebGLTexture;
  private audioData = new Uint8Array(256 * 2);
  private targets = new Map<string, Target>();
  private post: Program;
  private bright: Program;
  private blur: Program;
  private blackTex: WebGLTexture;
  private noiseTex: WebGLTexture;

  constructor(readonly canvas: HTMLCanvasElement) {
    const gl = canvas.getContext('webgl2', {
      alpha: true,
      antialias: false,
      depth: false,
      premultipliedAlpha: true,
      preserveDrawingBuffer: false,
      powerPreference: 'high-performance',
    });
    if (!gl) throw new Error('webgl2');
    this.gl = gl;
    this.hdr = !!(gl.getExtension('EXT_color_buffer_float') || gl.getExtension('EXT_color_buffer_half_float'));
    gl.getExtension('OES_texture_float_linear');
    this.emptyVao = gl.createVertexArray()!;
    this.audioTex = this.createDataTexture(256, 2);
    this.blackTex = this.createDataTexture(1, 1);
    this.noiseTex = this.createNoiseTexture();
    this.post = this.program(FULLSCREEN_VS, POST_FS);
    this.bright = this.program(FULLSCREEN_VS, BRIGHT_FS);
    this.blur = this.program(FULLSCREEN_VS, BLUR_FS);
  }

  private createDataTexture(w: number, h: number) {
    const gl = this.gl;
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, w, h, 0, gl.RED, gl.UNSIGNED_BYTE, new Uint8Array(w * h));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return tex;
  }

  /**
   * 256² tiling random texture for the prelude's noise3(): G holds R shifted by (37, 17), so one
   * bilinear fetch gives two z-slices of value noise (the trick from Inigo Quilez's cloud shaders).
   */
  private createNoiseTexture() {
    const gl = this.gl;
    const n = 256;
    let seed = 1;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 255;
    const r = new Uint8Array(n * n).map(rnd);
    const d = new Uint8Array(n * n * 2);
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        d[(y * n + x) * 2] = r[y * n + x];
        d[(y * n + x) * 2 + 1] = r[((y - 17) & 255) * n + ((x - 37) & 255)];
      }
    }
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RG8, n, n, 0, gl.RG, gl.UNSIGNED_BYTE, d);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
    return tex;
  }

  compile(type: number, src: string) {
    const gl = this.gl;
    const sh = gl.createShader(type)!;
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(sh);
      const numbered = src
        .split('\n')
        .map((l, i) => `${i + 1}: ${l}`)
        .join('\n');
      console.error(log, '\n', numbered);
      throw new Error(`shader: ${log}`);
    }
    return sh;
  }

  program(vs: string, fs: string): Program {
    const gl = this.gl;
    const p = gl.createProgram()!;
    gl.attachShader(p, this.compile(gl.VERTEX_SHADER, vs));
    gl.attachShader(p, this.compile(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(`link: ${gl.getProgramInfoLog(p)}`);
    return new Program(gl, p);
  }

  /** Fullscreen program whose fragment shader gets the shared prelude. */
  sceneProgram(body: string, vs = FULLSCREEN_VS): Program {
    return this.program(vs, PRELUDE + body);
  }

  resize(cssW: number, cssH: number, pixelRatio: number) {
    this.pixelRatio = pixelRatio;
    const w = Math.max(1, Math.round(cssW * pixelRatio));
    const h = Math.max(1, Math.round(cssH * pixelRatio));
    if (w === this.width && h === this.height) return false;
    this.width = this.canvas.width = w;
    this.height = this.canvas.height = h;
    return true;
  }

  /** Cached render target; re-created when the size changes. */
  target(name: string, w: number, h: number, hdr = this.hdr): Target {
    w = Math.max(1, Math.round(w));
    h = Math.max(1, Math.round(h));
    const old = this.targets.get(name);
    if (old && old.w === w && old.h === h) return old;
    const gl = this.gl;
    if (old) {
      gl.deleteFramebuffer(old.fbo);
      gl.deleteTexture(old.tex);
    }
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    if (hdr) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.HALF_FLOAT, null);
    else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const fbo = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    const t = { fbo, tex, w, h };
    this.targets.set(name, t);
    return t;
  }

  bindTarget(t: Target | null) {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, t ? t.fbo : null);
    gl.viewport(0, 0, t ? t.w : this.width, t ? t.h : this.height);
  }

  drawFullscreen() {
    const gl = this.gl;
    gl.bindVertexArray(this.emptyVao);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  uploadAudio(f: AudioFeatures) {
    const d = this.audioData;
    const s = f.spectrum;
    for (let i = 0; i < 256; i++) {
      const x = (i / 255) * (s.length - 1);
      const a = Math.floor(x);
      const b = Math.min(s.length - 1, a + 1);
      d[i] = Math.round((s[a] + (s[b] - s[a]) * (x - a)) * 255);
      d[256 + i] = Math.round((Math.max(-1, Math.min(1, f.waveform[i] ?? 0)) * 0.5 + 0.5) * 255);
    }
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.audioTex);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 256, 2, gl.RED, gl.UNSIGNED_BYTE, d);
  }

  /** Set the uniforms declared in the prelude. Texture units 0 (audio) and 7 (noise) are reserved. */
  common(p: Program, frame: FrameState, w: number, h: number) {
    const f = frame.features;
    p.f('uRes', w, h)
      .f('uTime', frame.time)
      .f('uFlow', frame.flow)
      .f('uDrift', frame.drift)
      .f('uSlowBass', frame.slowBass)
      .f('uSlowEnergy', frame.slowEnergy)
      .f('uMedBands', ...frame.medBands)
      .f('uBass', f.bass)
      .f('uLowMid', f.lowMid)
      .f('uMid', f.mid)
      .f('uHigh', f.high)
      .f('uEnergy', f.energy)
      .f('uBeat', f.beat)
      .f('uBeatCount', f.beatCount)
      .f('uCentroid', f.centroid)
      .f('uFlux', f.flux)
      .f('uBpm', f.bpm)
      .v3('uPal[0]', frame.palette)
      .tex('uNoise', 7, this.noiseTex)
      .tex('uAudio', 0, this.audioTex);
    return p;
  }

  createImageTexture(): WebGLTexture {
    const gl = this.gl;
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([0, 0, 0, 255]));
    return tex;
  }

  uploadImage(tex: WebGLTexture, img: TexImageSource) {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.SRGB8_ALPHA8, gl.RGBA, gl.UNSIGNED_BYTE, img);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.MIRRORED_REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.MIRRORED_REPEAT);
  }

  /**
   * Bloom + tonemap + grade of `a` (optionally cross-faded with `b`) onto the canvas.
   * Bloom runs at a quarter of the canvas resolution.
   */
  composite(a: Target, b: Target | null, mix: number, frame: FrameState, opts: { bloom: number }) {
    const gl = this.gl;
    gl.disable(gl.BLEND);
    const bw = this.width / 4;
    const bh = this.height / 4;
    const b1 = this.target('bloom1', bw, bh);
    const b2 = this.target('bloom2', bw, bh);

    this.bindTarget(b1);
    this.bright
      .use()
      .tex('uA', 1, a.tex)
      .tex('uB', 2, b ? b.tex : this.blackTex)
      .f('uMix', b ? mix : 0)
      .f('uThreshold', 0.55);
    this.drawFullscreen();

    for (let pass = 0; pass < 2; pass++) {
      const spread = 1 + pass;
      this.bindTarget(b2);
      this.blur.use().tex('uSrc', 1, b1.tex).f('uDir', spread / bw, 0);
      this.drawFullscreen();
      this.bindTarget(b1);
      this.blur.use().tex('uSrc', 1, b2.tex).f('uDir', 0, spread / bh);
      this.drawFullscreen();
    }

    this.bindTarget(null);
    const f = frame.features;
    this.post
      .use()
      .tex('uA', 1, a.tex)
      .tex('uB', 2, b ? b.tex : this.blackTex)
      .tex('uBloom', 3, b1.tex)
      .f('uMix', b ? mix : 0)
      .f('uRes', this.width, this.height)
      .f('uTime', frame.time)
      .f('uBloomAmt', opts.bloom * (0.75 + frame.medBands[0] * 0.45))
      .f('uBeat', f.beat)
      .f('uTransparent', frame.transparent ? 1 : 0)
      .v3('uBg', frame.palette.subarray(0, 3));
    this.drawFullscreen();
  }
}
