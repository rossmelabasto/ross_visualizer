import { AudioEngine, SourceError, type SourceKind } from './audio/engine';
import { emptyFeatures, idleFeatures, type AudioFeatures } from './audio/features';
import { readTags } from './audio/tags';
import { generateCover, loadImage, paletteFromImage, paletteHexes } from './color/cover';
import { oklabToOklch } from './color/oklab';
import { BRAND_PALETTE, lerpPalette, paletteFromHue, paletteToLinearRgb, type Palette } from './color/palette';
import { Renderer, type FrameState, type Scene } from './gl/renderer';
import { AsciiScene } from './scenes/ascii';
import { FluidScene } from './scenes/fluid';
import { GalaxyScene } from './scenes/galaxy';
import { AuroraScene } from './scenes/aurora';
import { KaleidoScene } from './scenes/kaleido';
import { NebulaScene } from './scenes/nebula';
import { TunnelScene } from './scenes/tunnel';
import { lookupSong, searchSongs, spotifySearchUrl, type Track } from './search/itunes';
import { detectLang, safeGet, safeSet, strings, type Lang, type Strings } from './ui/i18n';
import { icons } from './ui/icons';

const SCENE_IDS = ['fluid', 'nebula', 'galaxy', 'aurora', 'kaleido', 'tunnel', 'ascii'] as const;
type SceneId = (typeof SCENE_IDS)[number];
const BLOOM: Record<SceneId, number> = { fluid: 0.3, nebula: 0.5, galaxy: 0.9, aurora: 0.75, kaleido: 0.5, tunnel: 1.0, ascii: 0.3 };
const TRANSITION = 0.9;
const IDLE_AFTER = 3500;

type Quality = 'auto' | 'high' | 'low';

interface NowPlaying {
  title: string;
  artist: string;
  art?: string;
  track?: Track;
}

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

export class App {
  private readonly engine = new AudioEngine();
  private readonly renderer: Renderer;
  private readonly scenes: Scene[];
  private readonly galaxy: GalaxyScene;
  private sceneIndex = 0;
  private prevScene: Scene | null = null;
  private transitionStart = 0;

  private palette: Palette = BRAND_PALETTE;
  private targetPalette: Palette = BRAND_PALETTE;
  private paletteMode: 'cover' | 'audio' = 'cover';
  private paletteTau = 0.8;
  private hue = 2.2;
  private brightness = 0.35;
  private coverTex: WebGLTexture;
  private coverPrevTex: WebGLTexture;
  private coverMix = 1;
  private coverToken = 0;

  private readonly idle = emptyFeatures();
  private flow = 0;
  private drift = 0;
  private slowBass = 0;
  private slowEnergy = 0;
  private medBands: [number, number, number] = [0, 0, 0];
  private last = performance.now() / 1000;
  private frameEma = 1 / 60;
  private lastAdapt = 0;
  private quality: Quality = 'auto';
  private pixelScale = 1;

  private results: Track[] = [];
  private track: Track | null = null;
  private now: NowPlaying | null = null;
  private searchAbort: AbortController | null = null;
  private searchTimer = 0;
  private autoCycle = false;
  private lastCycle = 0;
  private lastCycleBeat = 0;
  private idleTimer = 0;
  private wakeLock: { release(): Promise<void> } | null = null;
  private lang: Lang = detectLang();
  private t: Strings = strings(this.lang);
  private toastTimer = 0;
  private statsOn = false;
  private analysis: AudioFeatures | null = null;
  private beatLatch = false;
  private lastAnalysis = performance.now() / 1000;

  constructor(canvas: HTMLCanvasElement) {
    this.renderer = new Renderer(canvas);
    this.galaxy = new GalaxyScene();
    this.scenes = [new FluidScene(), new NebulaScene(), this.galaxy, new AuroraScene(), new KaleidoScene(), new TunnelScene(), new AsciiScene()];
    this.scenes.forEach((s) => s.init(this.renderer));
    this.coverTex = this.renderer.createImageTexture();
    this.coverPrevTex = this.renderer.createImageTexture();
    this.renderer.uploadImage(this.coverTex, generateCover(BRAND_PALETTE));

    const q = safeGet('rv_quality');
    this.quality = q === 'high' || q === 'low' ? q : 'auto';
    this.autoCycle = safeGet('rv_autocycle') === '1';
    const sens = Number(safeGet('rv_sensitivity'));
    if (sens > 0) this.engine.setSensitivity(sens);

    const params = new URLSearchParams(location.search);
    const startScene = SCENE_IDS.indexOf((params.get('scene') ?? safeGet('rv_scene') ?? '') as SceneId);
    this.sceneIndex = startScene >= 0 ? startScene : 0;

    this.resetPixelScale();
    this.onResize();
    window.addEventListener('resize', () => this.onResize());
    this.bindUI();
    this.applyStrings();
    this.bindEngine();
    this.applyAccent(BRAND_PALETTE);

    const shared = params.get('t');
    if (shared) this.loadShared(shared);

    // Audio analysis runs on its own clock: when frames get slow (busy phone, battery saver,
    // a window the compositor throttles) we still see every kick drum.
    window.setInterval(() => this.analyze(), 1000 / 60);
    requestAnimationFrame((ts) => this.loop(ts));
  }

  private analyze() {
    const now = performance.now() / 1000;
    const dt = Math.min(0.1, Math.max(0.001, now - this.lastAnalysis));
    this.lastAnalysis = now;
    this.analysis = this.engine.paused ? null : this.engine.frame(dt, now);
    if (this.analysis?.onBeat) this.beatLatch = true;
  }

  // ---------------------------------------------------------------- rendering

  private resetPixelScale() {
    const dpr = window.devicePixelRatio || 1;
    const coarse = matchMedia('(pointer: coarse)').matches;
    const max = Math.min(dpr, coarse ? 1.5 : 2);
    this.pixelScale = this.quality === 'low' ? Math.min(1, max) * 0.6 : max;
    this.galaxy.setCount(this.quality === 'low' ? 30_000 : coarse ? 60_000 : 120_000);
  }

  private onResize() {
    this.renderer.resize(window.innerWidth, window.innerHeight, this.pixelScale);
  }

  private adaptQuality(now: number) {
    if (this.quality !== 'auto' || now - this.lastAdapt < 1.5) return;
    this.lastAdapt = now;
    const dpr = window.devicePixelRatio || 1;
    const max = Math.min(dpr, matchMedia('(pointer: coarse)').matches ? 1.5 : 2);
    // Under ~20 fps it's almost always the browser throttling a hidden or occluded window,
    // not the GPU: lowering the resolution then would only make it look worse once visible.
    if (this.frameEma > 1 / 20) return;
    let next = this.pixelScale;
    if (this.frameEma > 1 / 42) next = Math.max(0.5, next * 0.85);
    else if (this.frameEma < 1 / 57 && next < max) next = Math.min(max, next * 1.12);
    if (Math.abs(next - this.pixelScale) > 0.01) {
      this.pixelScale = next;
      this.onResize();
    }
  }

  private loop(ts: number) {
    requestAnimationFrame((t) => this.loop(t));
    const now = ts / 1000;
    const dt = Math.min(0.1, Math.max(0.001, now - this.last));
    this.last = now;
    this.frameEma += (dt - this.frameEma) * 0.05;
    this.adaptQuality(now);

    let f = this.engine.paused || this.engine.kind === 'none' ? null : this.analysis;
    if (!f || f.silent) f = idleFeatures(this.idle, now);
    else {
      // A beat found between two frames still has to reach the scenes exactly once.
      f.onBeat = this.beatLatch;
      this.beatLatch = false;
    }

    this.flow += dt * (0.35 + f.energy * 1.7 + f.beat * 0.35);
    // Slow averages for scenes that should move calmly and only "breathe" with the music.
    const k = 1 - Math.exp(-dt / 1.5);
    this.slowBass += (f.bass - this.slowBass) * k;
    this.slowEnergy += (f.energy - this.slowEnergy) * k;
    this.drift += dt * (0.4 + this.slowEnergy * 1.3);
    const km = 1 - Math.exp(-dt / 0.4);
    this.medBands[0] += (f.bass - this.medBands[0]) * km;
    this.medBands[1] += ((f.lowMid + f.mid) / 2 - this.medBands[1]) * km;
    this.medBands[2] += (f.high - this.medBands[2]) * km;

    if (this.paletteMode === 'audio') {
      this.hue += dt * (0.02 + f.energy * 0.05) + (f.centroid - 0.5) * dt * 0.08;
      if (f.onBeat && f.beatCount % 16 === 0) this.hue += 0.6;
      this.targetPalette = paletteFromHue(this.hue);
      this.paletteTau = 1.2;
    }
    this.palette = lerpPalette(this.palette, this.targetPalette, 1 - Math.exp(-dt / this.paletteTau));
    this.coverMix = Math.min(1, this.coverMix + dt / 1.2);

    if (this.autoCycle && this.engine.kind !== 'none') {
      const enoughBeats = f.beatCount - this.lastCycleBeat >= 64 && f.onBeat;
      if (enoughBeats || now - this.lastCycle > 45) {
        this.lastCycle = now;
        this.lastCycleBeat = f.beatCount;
        this.setScene((this.sceneIndex + 1) % this.scenes.length);
      }
    }

    const frame: FrameState = {
      time: now,
      dt,
      flow: this.flow,
      drift: this.drift,
      slowBass: this.slowBass,
      slowEnergy: this.slowEnergy,
      medBands: this.medBands,
      features: f,
      palette: paletteToLinearRgb(this.palette),
      brightness: this.brightness,
      cover: { tex: this.coverTex, prev: this.coverPrevTex, mix: this.coverMix, has: true },
      title: this.now ? `${this.now.title}${this.now.artist ? ` - ${this.now.artist}` : ''}` : '',
      quality: this.pixelScale,
      transparent: false,
    };

    const r = this.renderer;
    r.uploadAudio(f);
    const scene = this.scenes[this.sceneIndex];
    const a = r.target(`scene:${scene.id}`, r.width * scene.scale, r.height * scene.scale);
    scene.render(r, frame, a);

    let mix = 0;
    let b = null;
    if (this.prevScene) {
      const p = (now - this.transitionStart) / TRANSITION;
      if (p >= 1) this.prevScene = null;
      else {
        const ps = this.prevScene;
        b = r.target(`scene:${ps.id}`, r.width * ps.scale, r.height * ps.scale);
        ps.render(r, frame, b);
        mix = 1 - p * p * (3 - 2 * p);
      }
    }
    const bloom = BLOOM[scene.id as SceneId] * (1 - mix) + (this.prevScene ? BLOOM[this.prevScene.id as SceneId] * mix : 0);
    r.composite(a, b, mix, frame, { bloom });

    if (this.statsOn) this.renderStats(f);
  }

  private renderStats(f: AudioFeatures) {
    const bar = (v: number) => '█'.repeat(Math.round(v * 12)).padEnd(12, '·');
    $('stats').textContent = [
      `bass   ${bar(f.bass)}`,
      `lowmid ${bar(f.lowMid)}`,
      `mid    ${bar(f.mid)}`,
      `high   ${bar(f.high)}`,
      `energy ${bar(f.energy)}`,
      `beat   ${bar(f.beat)} #${f.beatCount}`,
      `bpm    ${f.bpm || '—'} (${Math.round(f.bpmConfidence * 100)}%)`,
      `fps    ${Math.round(1 / this.frameEma)} @ ${this.pixelScale.toFixed(2)}x`,
      `colors ${paletteHexes(this.targetPalette).join(' ')}`,
    ].join('\n');
  }

  private setScene(i: number) {
    const n = this.scenes.length;
    i = ((i % n) + n) % n;
    if (i === this.sceneIndex) return;
    this.prevScene = this.scenes[this.sceneIndex];
    this.transitionStart = performance.now() / 1000;
    this.sceneIndex = i;
    safeSet('rv_scene', SCENE_IDS[i]);
    document.querySelectorAll<HTMLButtonElement>('.scene-btn').forEach((b, k) => b.setAttribute('aria-selected', String(k === i)));
  }

  // ---------------------------------------------------------------- color

  private async setCover(src: string | null, fallbackSeed = 1) {
    const token = ++this.coverToken;
    let image: CanvasImageSource;
    if (src) {
      try {
        const img = await loadImage(src);
        if (token !== this.coverToken) return;
        const { palette, brightness } = paletteFromImage(img);
        this.paletteMode = 'cover';
        this.targetPalette = palette;
        this.paletteTau = 0.8;
        this.brightness = brightness;
        image = img;
      } catch {
        image = this.generated(fallbackSeed);
      }
    } else {
      image = this.generated(fallbackSeed);
    }
    if (token !== this.coverToken) return;
    // Keep what's on screen as "prev" and fade in the new one.
    [this.coverPrevTex, this.coverTex] = [this.coverTex, this.coverPrevTex];
    this.renderer.uploadImage(this.coverTex, image as TexImageSource);
    this.coverMix = 0;
    this.applyAccent(this.targetPalette);
  }

  private generated(seed: number) {
    this.paletteMode = 'audio';
    const p = paletteFromHue(this.hue);
    this.targetPalette = p;
    return generateCover(p, seed);
  }

  /** The UI follows the artwork too. */
  private applyAccent(p: Palette) {
    const [bg, primary, , accent] = paletteHexes(p);
    // Use whichever of primary/accent is more colorful, so grey covers still get a lively UI.
    const usePrimary = oklabToOklch(p.primary)[1] >= oklabToOklch(p.accent)[1];
    const root = document.documentElement.style;
    root.setProperty('--accent', usePrimary ? primary : accent);
    root.setProperty('--accent-ink', oklabToOklch(usePrimary ? p.primary : p.accent)[0] > 0.6 ? '#0a0c08' : '#f8faf5');
    root.setProperty('--bg', bg);
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', bg);
  }

  // ---------------------------------------------------------------- sources

  private bindEngine() {
    this.engine.on('media:timeupdate', () => {
      const m = this.engine.media;
      const p = m.duration ? (m.currentTime / m.duration) * 100 : 0;
      ($('now-progress').firstElementChild as HTMLElement).style.width = `${p}%`;
    });
    this.engine.on('media:ended', () => this.next());
    this.engine.on('media:play', () => this.updateDock());
    this.engine.on('media:pause', () => this.updateDock());
    this.engine.on('source', () => {
      this.updateDock();
      this.updateWakeLock();
      document.querySelectorAll('.source').forEach((b) => b.classList.toggle('active', b.id === `src-${this.engine.kind}`));
    });
    document.addEventListener('visibilitychange', () => this.updateWakeLock());
  }

  private async playTrack(track: Track) {
    this.track = track;
    this.setNow({ title: track.title, artist: track.artist, art: track.artworkSmall, track });
    this.markActive();
    this.setCover(track.artwork);
    try {
      await this.engine.playUrl(track.previewUrl);
      this.hideStart();
    } catch (e) {
      this.handleError(e);
    }
    this.setMediaSession(track);
  }

  private next() {
    if (!this.track || this.results.length < 2) {
      this.updateDock();
      return;
    }
    const i = this.results.findIndex((r) => r.id === this.track!.id);
    this.playTrack(this.results[(i + 1) % this.results.length]);
  }

  private async useSource(kind: SourceKind) {
    try {
      if (kind === 'mic') await this.engine.useMic();
      else if (kind === 'system') {
        this.toast(this.t.systemHelp, 5000);
        await this.engine.useSystem();
      } else if (kind === 'demo') await this.engine.useDemo();
      this.track = null;
      this.markActive();
      const label = this.t.listening[kind as 'mic' | 'system' | 'demo'];
      this.setNow({ title: label, artist: kind === 'demo' ? '120 BPM · A minor' : '' });
      this.setCover(null, kind.length);
      this.hideStart();
      this.updateSearchHint();
      if ('mediaSession' in navigator) navigator.mediaSession.metadata = null;
    } catch (e) {
      this.handleError(e);
    }
  }

  private async useFile(file: File) {
    const tags = await readTags(file);
    const url = URL.createObjectURL(file);
    const title = tags.title || file.name.replace(/\.[^.]+$/, '');
    let art: string | undefined;
    if (tags.picture) art = URL.createObjectURL(new Blob([tags.picture.data as BlobPart], { type: tags.picture.mime }));
    this.track = null;
    this.markActive();
    this.setNow({ title, artist: tags.artist ?? '', art });
    this.setCover(art ?? null, title.length);
    try {
      await this.engine.playUrl(url);
      this.hideStart();
    } catch (e) {
      this.handleError(e);
    }
  }

  private handleError(e: unknown) {
    if (e instanceof SourceError) this.toast(this.t.errors[e.code], 5000);
    else this.toast(String(e), 4000);
    console.warn(e);
  }

  private setMediaSession(track: Track) {
    if (!('mediaSession' in navigator)) return;
    navigator.mediaSession.metadata = new MediaMetadata({
      title: track.title,
      artist: track.artist,
      album: track.album,
      artwork: [{ src: track.artwork, sizes: '600x600', type: 'image/jpeg' }],
    });
    navigator.mediaSession.setActionHandler('play', () => this.engine.toggleMedia());
    navigator.mediaSession.setActionHandler('pause', () => this.engine.toggleMedia());
    navigator.mediaSession.setActionHandler('nexttrack', this.results.length > 1 ? () => this.next() : null);
  }

  private async updateWakeLock() {
    const want = this.engine.kind !== 'none' && document.visibilityState === 'visible';
    const nav = navigator as Navigator & { wakeLock?: { request(type: 'screen'): Promise<{ release(): Promise<void> }> } };
    try {
      if (want && !this.wakeLock && nav.wakeLock) this.wakeLock = await nav.wakeLock.request('screen');
      else if (!want && this.wakeLock) {
        await this.wakeLock.release();
        this.wakeLock = null;
      }
    } catch {
      this.wakeLock = null;
    }
    if (document.visibilityState === 'hidden') this.wakeLock = null;
  }

  private async loadShared(id: string) {
    try {
      const track = await lookupSong(id);
      if (!track) return;
      this.results = [track];
      this.renderResults();
      this.setCover(track.artwork);
      this.markActive(track.id);
      this.updateSearchHint();
    } catch {
      /* offline: the normal start screen still works */
    }
  }

  // ---------------------------------------------------------------- UI

  private applyStrings() {
    const t = this.t;
    document.documentElement.lang = this.lang;
    $('btn-lang').textContent = this.lang.toUpperCase();
    $('t-tagline').innerHTML = t.tagline.replace(/(luz|light)/, '<em>$1</em>');
    $('t-lead').textContent = t.lead;
    $<HTMLInputElement>('search').placeholder = t.searchPlaceholder;
    $('t-or').textContent = t.orListen;
    const src = (id: string, icon: string, label: string) => ($(id).innerHTML = `${icon}<span>${label}</span>`);
    src('src-mic', icons.mic, t.mic);
    src('src-system', icons.monitor, t.system);
    src('src-file', icons.file, t.file);
    src('src-demo', icons.sparkles, t.demo);
    $('t-privacy').textContent = t.privacy;
    $('t-settings').textContent = t.settings;
    $('t-sensitivity').textContent = t.sensitivity;
    $('t-quality').textContent = t.quality;
    const qb = $('quality').querySelectorAll('button');
    qb[0].textContent = t.qualityAuto;
    qb[1].textContent = t.qualityHigh;
    qb[2].textContent = t.qualityLow;
    $('t-autocycle').textContent = t.autoCycle;
    $('t-stats').textContent = t.showStats;
    $('btn-share').innerHTML = `${icons.share}<span>${t.share}</span>`;
    $('t-keys').textContent = matchMedia('(pointer: coarse)').matches ? t.tapHint : t.keys;
    $('t-madeby').textContent = t.madeBy;
    $('t-code').textContent = t.code;
    const tip = (id: string, label: string) => {
      $(id).setAttribute('aria-label', label);
      $(id).title = label;
    };
    tip('btn-settings', t.settings);
    tip('btn-fullscreen', t.fullscreen);
    tip('btn-source', t.source);
    tip('btn-next', 'Siguiente / Next');
    tip('settings-close', t.close);
    tip('start-close', t.close);
    this.renderSceneButtons();
    this.updateSearchHint();
    this.updateDock();
    this.renderNowLinks();
  }

  private renderSceneButtons() {
    const box = $('scenes');
    box.innerHTML = '';
    SCENE_IDS.forEach((id, i) => {
      const b = document.createElement('button');
      b.className = 'scene-btn';
      b.setAttribute('role', 'tab');
      b.setAttribute('aria-selected', String(i === this.sceneIndex));
      b.title = `${this.t.scenes[id]} (${i + 1})`;
      b.innerHTML = `${icons.scene[id]}<span>${this.t.scenes[id]}</span>`;
      b.addEventListener('click', () => this.setScene(i));
      box.appendChild(b);
    });
  }

  private updateDock() {
    const kind = this.engine.kind;
    const playable = kind === 'media' || kind === 'demo';
    const play = $('btn-play');
    play.hidden = !playable;
    const paused = this.engine.paused;
    play.innerHTML = paused ? icons.play : icons.pause;
    play.setAttribute('aria-label', paused ? this.t.play : this.t.pause);
    $('btn-next').hidden = !(kind === 'media' && this.track && this.results.length > 1);
  }

  private setNow(now: NowPlaying | null) {
    this.now = now;
    const box = $('now');
    box.hidden = !now;
    if (!now) return;
    $('now-title').textContent = now.title;
    $('now-artist').textContent = now.artist || (now.track ? '' : '');
    $('now-artist').hidden = !now.artist;
    const art = $<HTMLImageElement>('now-art');
    art.hidden = !now.art;
    if (now.art) art.src = now.art;
    $('now-progress').hidden = !(now.track || this.engine.kind === 'media');
    ($('now-progress').firstElementChild as HTMLElement).style.width = '0%';
    this.renderNowLinks();
  }

  private renderNowLinks() {
    const box = $('now-links');
    box.innerHTML = '';
    const track = this.now?.track;
    if (!track) return;
    const link = (href: string, label: string) => {
      const a = document.createElement('a');
      a.href = href;
      a.target = '_blank';
      a.rel = 'noopener';
      a.textContent = label;
      box.appendChild(a);
    };
    link(spotifySearchUrl(track), 'Spotify');
    if (track.storeUrl) link(track.storeUrl, this.t.openApple);
  }

  private updateSearchHint() {
    const live = this.engine.kind === 'mic' || this.engine.kind === 'system';
    $('search-hint').textContent = live ? this.t.searchHintCover : this.t.searchHintPlay;
  }

  private renderResults(message?: string) {
    const list = $('results');
    list.innerHTML = '';
    if (message) {
      list.innerHTML = `<li class="empty">${message}</li>`;
      return;
    }
    for (const r of this.results) {
      const li = document.createElement('li');
      const b = document.createElement('button');
      b.dataset.id = r.id;
      b.setAttribute('role', 'option');
      const img = document.createElement('img');
      img.src = r.artworkSmall;
      img.alt = '';
      const text = document.createElement('span');
      text.className = 'r-text';
      const title = document.createElement('span');
      title.className = 'r-title';
      title.textContent = r.title;
      const artist = document.createElement('span');
      artist.className = 'r-artist';
      artist.textContent = `${r.artist}${r.album ? ` · ${r.album}` : ''}`;
      text.append(title, artist);
      b.append(img, text);
      b.addEventListener('click', () => this.pickResult(r));
      li.appendChild(b);
      list.appendChild(li);
    }
    this.markActive();
  }

  private pickResult(r: Track) {
    const live = this.engine.kind === 'mic' || this.engine.kind === 'system';
    if (live) {
      // Listening to something else: the search only tells us which artwork to paint with.
      this.track = null;
      this.setNow({ title: r.title, artist: r.artist, art: r.artworkSmall, track: r });
      $('now-progress').hidden = true;
      this.setCover(r.artwork);
      this.markActive(r.id);
      this.hideStart();
    } else {
      this.playTrack(r);
    }
  }

  private markActive(id = this.track?.id) {
    document.querySelectorAll<HTMLButtonElement>('.results button').forEach((b) => b.classList.toggle('active', b.dataset.id === id));
  }

  private onSearchInput(value: string) {
    clearTimeout(this.searchTimer);
    this.searchAbort?.abort();
    if (!value.trim()) {
      this.results = [];
      this.renderResults();
      return;
    }
    this.searchTimer = window.setTimeout(async () => {
      const ctrl = new AbortController();
      this.searchAbort = ctrl;
      try {
        this.results = await searchSongs(value, ctrl.signal);
        this.renderResults(this.results.length ? undefined : this.t.noResults);
      } catch (e) {
        if ((e as Error).name !== 'AbortError') this.renderResults(this.t.searchError);
      }
    }, 320);
  }

  private showStart() {
    $('start').hidden = false;
    $('start-close').hidden = this.engine.kind === 'none';
    this.wake();
  }

  private hideStart() {
    $('start').hidden = true;
  }

  private toggleSettings(force?: boolean) {
    const el = $('settings');
    el.hidden = force === undefined ? !el.hidden : !force;
    this.wake();
  }

  private toast(msg: string, ms = 2500) {
    const el = $('toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => el.classList.remove('show'), ms);
  }

  /** Show the chrome, then hide it again after a while of no input. */
  private wake() {
    document.body.classList.remove('idle');
    clearTimeout(this.idleTimer);
    this.idleTimer = window.setTimeout(() => {
      const busy = !$('start').hidden || !$('settings').hidden || document.activeElement instanceof HTMLInputElement;
      if (!busy && this.engine.kind !== 'none') document.body.classList.add('idle');
    }, IDLE_AFTER);
  }

  private async toggleFullscreen() {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await document.documentElement.requestFullscreen({ navigationUI: 'hide' });
    } catch {
      /* iOS Safari has no fullscreen API for pages */
    }
  }

  private updateFullscreenIcon() {
    $('btn-fullscreen').innerHTML = document.fullscreenElement ? icons.shrink : icons.expand;
  }

  private async share() {
    const url = new URL(location.origin + location.pathname);
    url.searchParams.set('scene', SCENE_IDS[this.sceneIndex]);
    const id = this.track?.id ?? this.now?.track?.id;
    if (id) url.searchParams.set('t', id);
    try {
      await navigator.clipboard.writeText(url.toString());
      this.toast(this.t.copied);
    } catch {
      this.toast(url.toString(), 6000);
    }
  }

  private bindUI() {
    $('btn-settings').innerHTML = icons.settings;
    $('settings-close').innerHTML = icons.close;
    $('start-close').innerHTML = icons.close;
    $('btn-source').innerHTML = icons.waves;
    $('btn-next').innerHTML = icons.next;
    document.querySelector('.search-icon')!.innerHTML = icons.search;
    this.updateFullscreenIcon();

    $('btn-lang').addEventListener('click', () => {
      this.lang = this.lang === 'es' ? 'en' : 'es';
      this.t = strings(this.lang);
      safeSet('rv_lang', this.lang);
      this.applyStrings();
      if (this.now && !this.now.track && this.engine.kind !== 'media' && this.engine.kind !== 'none') {
        this.setNow({ ...this.now, title: this.t.listening[this.engine.kind] });
      }
    });
    $('btn-settings').addEventListener('click', () => this.toggleSettings());
    $('settings-close').addEventListener('click', () => this.toggleSettings(false));
    $('btn-fullscreen').addEventListener('click', () => this.toggleFullscreen());
    document.addEventListener('fullscreenchange', () => this.updateFullscreenIcon());
    $('btn-source').addEventListener('click', () => ($('start').hidden ? this.showStart() : this.hideStart()));
    $('start-close').addEventListener('click', () => this.hideStart());
    $('btn-play').addEventListener('click', () => this.engine.toggleMedia().then(() => this.updateDock()));
    $('btn-next').addEventListener('click', () => this.next());

    $('src-mic').addEventListener('click', () => this.useSource('mic'));
    $('src-demo').addEventListener('click', () => this.useSource('demo'));
    if (AudioEngine.canCaptureSystem) $('src-system').addEventListener('click', () => this.useSource('system'));
    else $('src-system').hidden = true;
    const fileInput = $<HTMLInputElement>('file-input');
    $('src-file').addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', () => {
      const file = fileInput.files?.[0];
      if (file) this.useFile(file);
      fileInput.value = '';
    });

    const search = $<HTMLInputElement>('search');
    search.addEventListener('input', () => this.onSearchInput(search.value));
    search.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && this.results[0]) this.pickResult(this.results[0]);
      if (e.key === 'ArrowDown') (document.querySelector('.results button') as HTMLElement | null)?.focus();
    });

    const sens = $<HTMLInputElement>('sensitivity');
    sens.value = String(Number(safeGet('rv_sensitivity')) || 1);
    sens.addEventListener('input', () => {
      this.engine.setSensitivity(Number(sens.value));
      safeSet('rv_sensitivity', sens.value);
    });
    const qButtons = $('quality').querySelectorAll<HTMLButtonElement>('button');
    const markQuality = () => qButtons.forEach((b) => b.classList.toggle('on', b.dataset.q === this.quality));
    markQuality();
    qButtons.forEach((b) =>
      b.addEventListener('click', () => {
        this.quality = b.dataset.q as Quality;
        safeSet('rv_quality', this.quality);
        this.resetPixelScale();
        this.onResize();
        markQuality();
      }),
    );
    const cycle = $<HTMLInputElement>('autocycle');
    cycle.checked = this.autoCycle;
    cycle.addEventListener('change', () => {
      this.autoCycle = cycle.checked;
      safeSet('rv_autocycle', cycle.checked ? '1' : '0');
    });
    const stats = $<HTMLInputElement>('stats-toggle');
    stats.addEventListener('change', () => {
      this.statsOn = stats.checked;
      $('stats').hidden = !stats.checked;
    });
    $('btn-share').addEventListener('click', () => this.share());

    // Keyboard.
    window.addEventListener('keydown', (e) => {
      const typing = e.target instanceof HTMLInputElement && e.target.type !== 'checkbox' && e.target.type !== 'range';
      if (e.key === 'Escape') {
        if (!$('settings').hidden) this.toggleSettings(false);
        else if (!$('start').hidden && this.engine.kind !== 'none') this.hideStart();
        (document.activeElement as HTMLElement | null)?.blur();
        return;
      }
      if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
      this.wake();
      if (e.key >= '1' && e.key <= String(this.scenes.length)) this.setScene(Number(e.key) - 1);
      else if (e.key === 'ArrowRight') this.setScene(this.sceneIndex + 1);
      else if (e.key === 'ArrowLeft') this.setScene(this.sceneIndex - 1);
      else if (e.key === 'f' || e.key === 'F') this.toggleFullscreen();
      else if (e.key === 'h' || e.key === 'H') document.body.classList.toggle('idle');
      else if (e.key === ' ') {
        e.preventDefault();
        this.engine.toggleMedia().then(() => this.updateDock());
      } else if (e.key === '/') {
        e.preventDefault();
        this.showStart();
        search.focus();
      } else return;
    });

    // Pointer: any movement shows the UI; swipes on the canvas change scene.
    window.addEventListener('pointermove', (e) => {
      if (e.pointerType === 'mouse') this.wake();
    });
    const canvas = this.renderer.canvas;
    let down: { x: number; y: number; t: number } | null = null;
    canvas.addEventListener('pointerdown', (e) => (down = { x: e.clientX, y: e.clientY, t: performance.now() }));
    canvas.addEventListener('pointerup', (e) => {
      if (!down) return;
      const dx = e.clientX - down.x;
      const dy = e.clientY - down.y;
      const quick = performance.now() - down.t < 600;
      down = null;
      if (quick && Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.3) {
        this.setScene(this.sceneIndex + (dx < 0 ? 1 : -1));
        this.wake();
      } else if (Math.hypot(dx, dy) < 10) {
        if (!$('settings').hidden) this.toggleSettings(false);
        else if (document.body.classList.contains('idle')) this.wake();
        else if (this.engine.kind !== 'none') {
          clearTimeout(this.idleTimer);
          document.body.classList.add('idle');
        }
      }
    });
    canvas.addEventListener('dblclick', () => this.toggleFullscreen());
  }
}
