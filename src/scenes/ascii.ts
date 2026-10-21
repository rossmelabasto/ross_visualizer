import type { FrameState, Program, Renderer, Scene, Target } from '../gl/renderer';
import { hexToLinearRgb } from '../color/oklab';

const ATLAS_COLS = 16;
const ATLAS_ROWS = 6; // 96 slots for printable ASCII 32..126
const TEXT_W = 192;
const TEXT_LINES = 3;

// A terminal that plays the music: spectrum bars, the waveform and some rain, all in glyphs.
const FS = /* glsl */ `
uniform sampler2D uGlyphs;
uniform sampler2D uText;
uniform vec2 uCell;
uniform vec3 uTextLen;
uniform vec3 uBrand;
uniform float uTopRow;    // first text row (below the top bar)
uniform float uBottomRow; // status row (above the dock)

float glyph(float code, vec2 cuv) {
  float idx = clamp(code, 32.0, 126.0) - 32.0;
  vec2 g = vec2(mod(idx, ${ATLAS_COLS}.0), floor(idx / ${ATLAS_COLS}.0));
  vec2 uv = (g + vec2(cuv.x, 1.0 - cuv.y)) / vec2(${ATLAS_COLS}.0, ${ATLAS_ROWS}.0);
  return texture(uGlyphs, uv).r;
}

float textChar(int line, int col) {
  return texelFetch(uText, ivec2(col, line), 0).r * 255.0;
}

const float RAMP[10] = float[10](32.0, 46.0, 58.0, 45.0, 61.0, 43.0, 42.0, 35.0, 37.0, 64.0); // " .:-=+*#%@"

void main() {
  vec2 cell = floor(gl_FragCoord.xy / uCell);
  vec2 cuv = fract(gl_FragCoord.xy / uCell);
  vec2 grid = floor(uRes / uCell);
  float row = grid.y - 1.0 - cell.y; // 0 = top
  float col = cell.x;
  vec2 p = (cell + 0.5) / grid;

  vec3 bg = BG * 0.55;
  float code = 32.0;
  vec3 ink = PRIMARY;
  float margin = 2.0;

  int line = row == uTopRow ? 0 : row == uTopRow + 1.0 ? 1 : row == uBottomRow ? 2 : -1;
  if (line >= 0) {
    float len = line == 0 ? uTextLen.x : line == 1 ? uTextLen.y : uTextLen.z;
    float c = col - margin;
    if (c >= 0.0 && c < len) code = textChar(line, int(c));
    ink = line == 0 ? uBrand : line == 1 ? HIGHLIGHT : mix(PRIMARY, ACCENT, 0.4);
    if (line == 0 && c == len + 1.0 && fract(uTime * 1.6) < 0.55) {
      // Blinking block cursor.
      fragColor = vec4(mix(bg, uBrand, step(0.08, cuv.x) * step(cuv.x, 0.92) * step(0.1, cuv.y) * step(cuv.y, 0.85)), 1.0);
      return;
    }
  } else if (row > uTopRow + 2.0 && row < uBottomRow - 1.0) {
    // Field area: y from 0 (bottom of the field) to 1 (top).
    float top = uTopRow + 3.0;
    float bottom = uBottomRow - 2.0;
    float y = (bottom - row) / (bottom - top);
    float x = p.x;

    float s = spectrum(pow(abs(x - 0.5) * 2.0, 0.85) * 0.92);
    float barH = s * (0.55 + uEnergy * 0.45);
    float v = 0.0;
    if (y < barH) {
      v = mix(1.0, 0.45, y / max(barH, 1e-3));
      ink = mix(PRIMARY, ACCENT, smoothstep(0.2, 0.9, y));
    }

    float wy = 0.72 + waveform(x) * 0.22;
    float dw = abs(y - wy) * (bottom - top);
    if (dw < 0.75 && v < 0.6) {
      v = 0.75;
      ink = HIGHLIGHT;
      code = abs(waveform(x + 1.0 / grid.x) - waveform(x)) > 0.03 ? (waveform(x + 1.0 / grid.x) > waveform(x) ? 47.0 : 92.0) : 45.0;
    }

    if (v > 0.0 && code == 32.0) code = RAMP[int(clamp(v, 0.0, 0.999) * 10.0)];

    if (code == 32.0) {
      // Digital rain, faster and brighter with energy.
      float seed = hash11(col * 1.37 + 0.5);
      float speed = 0.15 + seed * 0.35 + uEnergy * 0.25;
      float head = fract(seed * 7.0 + uFlow * speed * 0.35);
      float yy = 1.0 - y;
      float tail = fract(head - yy);
      float rain = smoothstep(0.35, 0.0, tail) * step(0.45, hash11(col * 3.1 + floor(uFlow * speed * 0.35 + seed * 7.0)));
      if (rain > 0.05) {
        float flick = floor(uTime * 12.0 * (0.5 + seed));
        code = 33.0 + floor(hash21(cell + flick) * 93.0);
        ink = mix(SECONDARY, uBrand, smoothstep(0.03, 0.0, tail)) * (0.25 + rain * (0.35 + uBeat * 0.6));
      } else if (hash21(cell + floor(uTime * 0.5)) > 0.985) {
        code = 46.0;
        ink = SECONDARY * 0.4;
      }
    }
  }

  float gm = glyph(code, cuv);
  vec3 c = mix(bg, ink * (1.0 + uBeat * 0.4), gm);
  // Scanlines, because it's a terminal.
  c *= 0.9 + 0.1 * sin(gl_FragCoord.y * PI / max(1.0, uCell.y / 6.0));
  fragColor = vec4(c, 1.0);
}`;

function asciiOnly(s: string) {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[—–]/g, '-')
    .replace(/[·•]/g, '|')
    .replace(/[^\x20-\x7e]/g, '?');
}

function bar(v: number, n = 10) {
  const k = Math.round(Math.min(1, Math.max(0, v)) * n);
  return '#'.repeat(k) + '-'.repeat(n - k);
}

export class AsciiScene implements Scene {
  readonly id = 'ascii';
  readonly scale = 1;
  private prog!: Program;
  private atlas!: WebGLTexture;
  private text!: WebGLTexture;
  private textData = new Uint8Array(TEXT_W * TEXT_LINES);
  private lens = [0, 0, 0];
  private brand = hexToLinearRgb('#afff00');

  init(r: Renderer) {
    const gl = r.gl;
    this.prog = r.sceneProgram(FS);

    this.text = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, this.text);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, TEXT_W, TEXT_LINES, 0, gl.RED, gl.UNSIGNED_BYTE, this.textData);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);

    this.atlas = gl.createTexture()!;
    this.buildAtlas(r);
    // The web font may arrive after init; rebuild once it does.
    document.fonts?.ready.then(() => this.buildAtlas(r));
  }

  private buildAtlas(r: Renderer) {
    const size = 48;
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d')!;
    const font = `500 ${size}px "JetBrains Mono", ui-monospace, monospace`;
    ctx.font = font;
    const cw = Math.ceil(ctx.measureText('M').width);
    const ch = Math.ceil(size * 1.25);
    canvas.width = cw * ATLAS_COLS;
    canvas.height = ch * ATLAS_ROWS;
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.font = font;
    ctx.fillStyle = '#fff';
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'center';
    for (let i = 0; i < 95; i++) {
      const x = (i % ATLAS_COLS) * cw + cw / 2;
      const y = Math.floor(i / ATLAS_COLS) * ch + ch / 2;
      ctx.fillText(String.fromCharCode(32 + i), x, y);
    }
    const gl = r.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.atlas);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, gl.RED, gl.UNSIGNED_BYTE, canvas);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }

  private setLine(i: number, s: string) {
    const t = asciiOnly(s).slice(0, TEXT_W);
    for (let k = 0; k < TEXT_W; k++) this.textData[i * TEXT_W + k] = k < t.length ? t.charCodeAt(k) : 32;
    this.lens[i] = t.length;
  }

  render(r: Renderer, frame: FrameState, target: Target) {
    const gl = r.gl;
    const f = frame.features;
    const cssH = target.h / r.pixelRatio;
    const cellH = Math.round(Math.min(22, Math.max(12, cssH / 46)) * r.pixelRatio);
    const cellW = Math.round(cellH * 0.6);
    const cols = Math.floor(target.w / cellW) - 4;
    const rows = Math.floor(target.h / cellH);
    // Keep the text clear of the top bar (~76 px) and the dock (~90 px).
    const topRow = Math.ceil((76 * r.pixelRatio) / cellH);
    const bottomRow = rows - 1 - Math.ceil((92 * r.pixelRatio) / cellH);

    this.setLine(0, 'rossmel@rOS ~ $ visualizer --scene ros');
    this.setLine(1, frame.title ? `> ${frame.title}` : '> esperando audio...');
    const status = `bass [${bar(f.bass)}]  mid [${bar(f.mid)}]  high [${bar(f.high)}]  ${f.bpm ? `${f.bpm} bpm` : '--- bpm'}  beats ${String(f.beatCount).padStart(4, '0')}`;
    this.setLine(2, status.length > cols ? status.slice(0, cols) : status);
    gl.bindTexture(gl.TEXTURE_2D, this.text);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, TEXT_W, TEXT_LINES, gl.RED, gl.UNSIGNED_BYTE, this.textData);

    r.bindTarget(target);
    r.common(this.prog.use(), frame, target.w, target.h)
      .tex('uGlyphs', 1, this.atlas)
      .tex('uText', 2, this.text)
      .f('uCell', cellW, cellH)
      .f('uTopRow', topRow)
      .f('uBottomRow', bottomRow)
      .f('uTextLen', this.lens[0], this.lens[1], this.lens[2])
      .f('uBrand', this.brand[0], this.brand[1], this.brand[2]);
    r.drawFullscreen();
  }
}
