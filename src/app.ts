import { AudioEngine, SourceError, type SourceKind } from './audio/engine';
import { emptyFeatures, idleFeatures, type AudioFeatures } from './audio/features';
import { PcmAnalyser } from './audio/pcm';
import { readTags } from './audio/tags';
import { paletteHexes } from './color/cover';
import { oklabToOklch } from './color/oklab';
import { BRAND_PALETTE, type Palette } from './color/palette';
import type { Renderer, Scene } from './gl/renderer';
import { AsciiScene } from './scenes/ascii';
import { FluidScene } from './scenes/fluid';
import { GalaxyScene } from './scenes/galaxy';
import { AuroraScene } from './scenes/aurora';
import { KaleidoScene } from './scenes/kaleido';
import { NebulaScene } from './scenes/nebula';
import { TUNNEL_VERSIONS, TunnelScene } from './scenes/tunnel';
import { lookupSong, searchSongs, spotifySearchUrl, type Track } from './search/itunes';
import {
  androidOverlayOptions,
  artworkUrl,
  desktopInfo,
  isAndroid,
  isDesktop,
  setAudioSource,
  watchAudioSources,
  type AudioSources,
  mediaControl,
  setOverlay,
  setOverlayOptions,
  streamSystemAudio,
  toggleWindowFullscreen,
  watchNowPlaying,
  overlaySupported,
  watchOverlay,
  watchOverlayOptions,
  type DesktopInfo,
  type NowPlaying as SystemTrack,
} from './desktop/bridge';
import { OVERLAY_MODES, OVERLAY_OPTIONS, optionOf, SPOTS, type OverlayMode, type OverlayOptions } from './overlay/modes';
import { Stage } from './stage';
import { detectLang, safeGet, safeSet, strings, type Lang, type Strings } from './ui/i18n';
import { icons } from './ui/icons';
import { Tour } from './ui/tour';
import { android, androidState, feedAudio, onAndroid, type AndroidMedia, type AndroidState } from './android/native';

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
  private readonly stage: Stage;
  private readonly renderer: Renderer;
  private readonly scenes: Scene[];
  private readonly galaxy: GalaxyScene;
  private readonly tunnel: TunnelScene;
  private sceneIndex = 0;
  private prevScene: Scene | null = null;
  private transitionStart = 0;

  private readonly idle = emptyFeatures();
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
  // Desktop app only.
  private player: SystemTrack | null = null;
  private artKey: string | null = null;
  private artBlob: string | null = null;
  private overlayMode: string | null = null;
  private overlayOptions: OverlayOptions | null = null;
  private windowFullscreen = false;
  private desktop: DesktopInfo = { desktop: 'other', command: 'ross-visualizer' };
  private overlayOk = false;
  private audio: AudioSources = { source: 'all', apps: [] };
  private androidState: AndroidState | null = null;
  private readonly tour = new Tour(
    $('tour'),
    () => ({
      t: this.t,
      lang: this.lang,
      info: this.desktop,
      overlay: this.overlayOk,
      android: this.androidState
        ? {
            audio: this.androidState.audio,
            media: this.androidState.media,
            overlay: this.androidState.overlayAllowed,
            grantAudio: () => android.requestAudio(),
            grantMedia: () => android.openMediaAccess(),
            grantOverlay: () => android.requestOverlay(),
          }
        : null,
    }),
    () => {
      safeSet('rv_tour', '1');
      this.wake();
    },
  );

  constructor(canvas: HTMLCanvasElement) {
    this.stage = new Stage(canvas);
    this.stage.onPalette = (p) => this.applyAccent(p);
    this.renderer = this.stage.renderer;
    this.galaxy = new GalaxyScene();
    this.tunnel = new TunnelScene();
    this.scenes = [new FluidScene(), new NebulaScene(), this.galaxy, new AuroraScene(), new KaleidoScene(), this.tunnel, new AsciiScene()];
    this.scenes.forEach((s) => s.init(this.renderer));

    const q = safeGet('rv_quality');
    this.quality = q === 'high' || q === 'low' ? q : 'auto';
    this.autoCycle = safeGet('rv_autocycle') === '1';
    const sens = Number(safeGet('rv_sensitivity'));
    if (sens > 0) this.engine.setSensitivity(sens);

    const params = new URLSearchParams(location.search);
    const startScene = SCENE_IDS.indexOf((params.get('scene') ?? safeGet('rv_scene') ?? '') as SceneId);
    this.sceneIndex = startScene >= 0 ? startScene : 0;
    const tv = TUNNEL_VERSIONS.indexOf((params.get('tunnel') ?? '') as (typeof TUNNEL_VERSIONS)[number]);
    if (tv >= 0) this.tunnel.version = tv;

    this.resetPixelScale();
    this.onResize();
    window.addEventListener('resize', () => this.onResize());
    this.bindUI();
    this.applyStrings();
    this.bindEngine();
    this.applyAccent(BRAND_PALETTE);

    const shared = params.get('t');
    if (shared && !isDesktop && !isAndroid) this.loadShared(shared);
    if (isDesktop) this.startDesktop();
    if (isAndroid) this.startAndroid();

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

    if (this.autoCycle && this.engine.kind !== 'none') {
      const enoughBeats = f.beatCount - this.lastCycleBeat >= 64 && f.onBeat;
      if (enoughBeats || now - this.lastCycle > 45) {
        this.lastCycle = now;
        this.lastCycleBeat = f.beatCount;
        this.setScene((this.sceneIndex + 1) % this.scenes.length);
      }
    }

    const title = this.now ? `${this.now.title}${this.now.artist ? ` - ${this.now.artist}` : ''}` : '';
    const frame = this.stage.step(f, now, dt, title, this.pixelScale);
    const scene = this.scenes[this.sceneIndex];
    let prev = null;
    if (this.prevScene) {
      const p = (now - this.transitionStart) / TRANSITION;
      if (p >= 1) this.prevScene = null;
      else prev = { scene: this.prevScene, mix: 1 - p * p * (3 - 2 * p), bloom: BLOOM[this.prevScene.id as SceneId] };
    }
    this.stage.draw(frame, scene, BLOOM[scene.id as SceneId], prev);

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
      `colors ${paletteHexes(this.stage.targetPalette).join(' ')}`,
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
    this.stage.setCover(track.artwork);
    try {
      await this.engine.playUrl(track.previewUrl);
      this.hideStart();
    } catch (e) {
      this.handleError(e);
    }
    this.setMediaSession(track);
  }

  /** Move through the search results: +1 for the next song, -1 for the previous one. */
  private next(dir = 1) {
    if (!this.track || this.results.length < 2) {
      this.updateDock();
      return;
    }
    const n = this.results.length;
    const i = this.results.findIndex((r) => r.id === this.track!.id);
    this.playTrack(this.results[(i + dir + n) % n]);
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
      this.stage.setCover(null, kind.length);
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
    this.stage.setCover(art ?? null, title.length);
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
      this.stage.setCover(track.artwork);
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
    $('demo-badge').textContent = t.demoBadge;
    $('t-getapp-title').textContent = t.getAppTitle;
    $('t-getapp-body').textContent = t.getAppBody;
    $('t-getapp-cta').textContent = t.getAppCta;
    $('btn-getapp').innerHTML = `${icons.monitor}<span>${t.getAppSettings}</span>`;
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
    $('t-keys').textContent = isDesktop ? t.desktopKeys : matchMedia('(pointer: coarse)').matches ? t.tapHint : t.keys;
    $('t-overlay').textContent = t.overlay;
    $('t-audio').textContent = t.audioSource;
    $('t-audio-hint').textContent = t.audioHint;
    $('t-madeby').textContent = t.madeBy;
    $('t-code').textContent = t.code;
    const tip = (id: string, label: string) => {
      $(id).setAttribute('aria-label', label);
      $(id).title = label;
    };
    tip('btn-settings', t.settings);
    tip('btn-fullscreen', t.fullscreen);
    tip('btn-source', t.source);
    tip('btn-next', t.next);
    tip('btn-prev', t.prev);
    $('btn-tour').textContent = t.tourOpen;
    this.tour.refresh();
    tip('settings-close', t.close);
    tip('start-close', t.close);
    this.renderSceneButtons();
    this.renderOverlayModes();
    this.renderAudioSources();
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
    this.updateDockButtons();
    $('player-bar').hidden = [...$('player-bar').children].every((b) => (b as HTMLElement).hidden);
  }

  private updateDockButtons() {
    const kind = this.engine.kind;
    if (kind === 'native') {
      // The buttons drive whatever player the system reports (Spotify, a browser…).
      const paused = this.player?.status !== 'Playing';
      $('btn-play').hidden = !this.player;
      $('btn-prev').hidden = !this.player;
      $('btn-play').innerHTML = paused ? icons.play : icons.pause;
      $('btn-play').setAttribute('aria-label', paused ? this.t.play : this.t.pause);
      $('btn-next').hidden = !this.player;
      return;
    }
    const playable = kind === 'media' || kind === 'demo';
    const play = $('btn-play');
    play.hidden = !playable;
    const paused = this.engine.paused;
    play.innerHTML = paused ? icons.play : icons.pause;
    play.setAttribute('aria-label', paused ? this.t.play : this.t.pause);
    $('btn-next').hidden = !(kind === 'media' && this.track && this.results.length > 1);
    $('btn-prev').hidden = $('btn-next').hidden;
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
      this.stage.setCover(r.artwork);
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
      const busy = !$('start').hidden || !$('settings').hidden || this.tour.isOpen || document.activeElement instanceof HTMLInputElement;
      if (!busy && (this.engine.kind !== 'none' || isAndroid)) document.body.classList.add('idle');
    }, IDLE_AFTER);
  }

  private async toggleFullscreen() {
    if (isDesktop || isAndroid) {
      this.windowFullscreen = await toggleWindowFullscreen();
      this.updateFullscreenIcon();
      return;
    }
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await document.documentElement.requestFullscreen({ navigationUI: 'hide' });
    } catch {
      /* iOS Safari has no fullscreen API for pages */
    }
  }

  private updateFullscreenIcon() {
    const full = isDesktop || isAndroid ? this.windowFullscreen : !!document.fullscreenElement;
    $('btn-fullscreen').innerHTML = full ? icons.shrink : icons.expand;
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
    $('btn-prev').innerHTML = icons.prev;
    document.querySelector('.search-icon')!.innerHTML = icons.search;
    this.updateFullscreenIcon();

    $('btn-lang').addEventListener('click', () => {
      this.lang = this.lang === 'es' ? 'en' : 'es';
      this.t = strings(this.lang);
      safeSet('rv_lang', this.lang);
      this.applyStrings();
      if (this.now && !this.now.track && this.engine.kind !== 'media' && this.engine.kind !== 'none') {
        this.setNow({ ...this.now, title: this.t.listening[isAndroid && this.engine.kind === 'native' ? 'phone' : this.engine.kind] });
      }
    });
    $('btn-settings').addEventListener('click', () => this.toggleSettings());
    $('settings-close').addEventListener('click', () => this.toggleSettings(false));
    $('btn-fullscreen').addEventListener('click', () => this.toggleFullscreen());
    document.addEventListener('fullscreenchange', () => this.updateFullscreenIcon());
    $('btn-source').addEventListener('click', () => ($('start').hidden ? this.showStart() : this.hideStart()));
    $('start-close').addEventListener('click', () => this.hideStart());
    $('btn-play').addEventListener('click', () => this.togglePlay());
    $('btn-next').addEventListener('click', () => (this.engine.kind === 'native' ? mediaControl('next') : this.next()));
    $('btn-prev').addEventListener('click', () => (this.engine.kind === 'native' ? mediaControl('previous') : this.next(-1)));
    $('btn-tour').addEventListener('click', () => {
      this.toggleSettings(false);
      this.tour.open();
    });

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
      if (this.tour.isOpen) {
        this.tour.key(e);
        return;
      }
      const typing = e.target instanceof HTMLInputElement && e.target.type !== 'checkbox' && e.target.type !== 'range';
      if (e.key === 'Escape') {
        if (!$('settings').hidden) this.toggleSettings(false);
        else if ((isDesktop || isAndroid) && this.windowFullscreen) this.toggleFullscreen();
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
      else if ((e.key === 'o' || e.key === 'O') && isDesktop) this.cycleOverlay();
      else if (e.key === ' ') {
        e.preventDefault();
        this.togglePlay();
      } else if (e.key === '/' && !isDesktop) {
        e.preventDefault();
        this.showStart();
        search.focus();
      } else return;
    });

    // Pointer: any movement shows the UI; swipes on the canvas change scene.
    window.addEventListener('pointermove', (e) => {
      // Not just 'mouse': WebKitGTK (the desktop app) may report other types for a mouse.
      if (e.pointerType !== 'touch') this.wake();
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
        else if (this.engine.kind !== 'none' || isAndroid) {
          clearTimeout(this.idleTimer);
          document.body.classList.add('idle');
        }
      }
    });
    canvas.addEventListener('dblclick', () => this.toggleFullscreen());
  }

  private togglePlay() {
    if (this.engine.kind === 'native') mediaControl('play-pause');
    else this.engine.toggleMedia().then(() => this.updateDock());
  }

  // ---------------------------------------------------------------- desktop app

  /** Inside the desktop app: listen to everything the computer plays and follow its player. */
  private async startDesktop() {
    document.body.classList.add('desktop');
    this.hideStart();
    $('btn-source').hidden = true;
    $('btn-share').hidden = true;
    $('btn-tour').hidden = false;
    // The app itself doesn't advertise the app.
    $('demo-badge').hidden = true;
    $('get-app').hidden = true;
    $('btn-getapp').hidden = true;
    const analyser = new PcmAnalyser(48000);
    this.engine.useNative(analyser);
    this.setNow({ title: this.t.listening.native, artist: '' });
    this.stage.setCover(null, 3);
    try {
      this.overlayOk = await overlaySupported();
      $('overlay-field').hidden = !this.overlayOk;
      this.desktop = await desktopInfo();
      $('audio-field').hidden = false;
      const saved = safeGet('rv_audio_source');
      if (saved && saved !== 'all') await setAudioSource(saved);
      await watchAudioSources((s) => {
        this.audio = s;
        this.renderAudioSources();
      });
      if (!safeGet('rv_tour')) this.tour.open();
      await streamSystemAudio(analyser);
      await watchNowPlaying((n) => this.onSystemTrack(n));
      await watchOverlayOptions((o) => {
        // Controls are drawn once per style: redrawing them mid-drag would drop the slider.
        const first = !this.overlayOptions;
        this.overlayOptions = o;
        if (first) this.renderOverlayModes();
      });
      await watchOverlay((mode) => {
        this.overlayMode = mode;
        this.renderOverlayModes();
      });
    } catch (e) {
      this.handleError(e);
    }
  }

  // ---------------------------------------------------------------- Android app

  /** Inside the Android app: everything the phone plays (Visualizer) and its media session. */
  private startAndroid() {
    document.body.classList.add('android');
    this.hideStart();
    for (const id of ['btn-source', 'btn-share', 'demo-badge', 'get-app', 'btn-getapp']) $(id).hidden = true;
    $('btn-tour').hidden = false;
    this.overlayOk = true;
    $('overlay-field').hidden = false;
    this.overlayOptions = androidOverlayOptions();
    this.setNow({ title: this.t.listening.phone, artist: '' });
    this.stage.setCover(null, 3);
    onAndroid('audio', (a) => {
      if (!a.ok) {
        if (a.reason !== 'permission') this.toast(`${this.t.androidNoAudio} (${a.reason})`, 6000);
        return;
      }
      const analyser = new PcmAnalyser(a.rate ?? 44100, 1024);
      this.engine.useNative(analyser);
      feedAudio((samples) => analyser.push(samples));
      this.setNow({ title: this.player?.title || this.t.listening.phone, artist: this.player?.artist ?? '' });
    });
    onAndroid('media', (m) => this.onAndroidMedia(m));
    onAndroid('state', (st) => this.onAndroidState(st));
    this.onAndroidState(androidState());
    if (!safeGet('rv_tour')) this.tour.open();
  }

  private onAndroidState(st: AndroidState) {
    this.androidState = st;
    if (st.overlay !== this.overlayMode) {
      this.overlayMode = st.overlay;
      this.renderOverlayModes();
    }
    if (st.audio && !st.listening) android.startAudio();
    if (st.media) android.startMedia();
    this.tour.refresh();
  }

  private onAndroidMedia(m: AndroidMedia | null) {
    if (!m || !m.title) {
      this.player = null;
      this.updateDock();
      this.setNow({ title: this.t.listening.phone, artist: '' });
      if (this.artKey !== null) this.stage.setCover(null, 3);
      this.artKey = null;
      this.artBlob = null;
      return;
    }
    this.player = { player: m.player, status: m.status, title: m.title, artist: m.artist, art: '' };
    this.updateDock();
    if (m.art !== undefined && m.artKey !== this.artKey) {
      this.artKey = m.artKey;
      this.artBlob = m.art || null;
      this.stage.setCover(m.art || null, m.title.length);
    }
    this.setNow({ title: m.title, artist: m.artist, art: this.artBlob ?? undefined });
  }

  private async onSystemTrack(n: SystemTrack | null) {
    this.player = n;
    this.updateDock();
    if (!n?.title) {
      this.setNow({ title: this.t.listening.native, artist: '' });
      if (this.artKey !== null) this.stage.setCover(null, 3);
      this.artKey = null;
      return;
    }
    // Albums share one artwork: only reload (and repaint) when the artwork itself changes.
    const key = n.art || `${n.title}\u0000${n.artist}`;
    if (key === this.artKey) {
      this.setNow({ title: n.title, artist: n.artist, art: this.artBlob ?? undefined });
      return;
    }
    this.artKey = key;
    const art = n.art ? await artworkUrl(n.art) : null;
    if (this.artKey !== key) {
      if (art) URL.revokeObjectURL(art);
      return;
    }
    if (this.artBlob) URL.revokeObjectURL(this.artBlob);
    this.artBlob = art;
    this.setNow({ title: n.title, artist: n.artist, art: art ?? undefined });
    this.stage.setCover(art, n.title.length);
  }

  /** "Everything that plays" and each app with audio open; the chosen app stays listed while quiet. */
  private renderAudioSources() {
    if (!isDesktop) return;
    const box = $('audio-sources');
    box.innerHTML = '';
    const add = (id: string, label: string, idle = false) => {
      const b = document.createElement('button');
      b.dataset.source = id;
      b.classList.toggle('on', id === this.audio.source);
      b.classList.toggle('idle', idle);
      b.textContent = label;
      if (idle) b.title = this.t.audioIdle;
      b.addEventListener('click', () => {
        safeSet('rv_audio_source', id);
        setAudioSource(id);
      });
      box.appendChild(b);
    };
    add('all', this.t.audioAll);
    const apps = [...this.audio.apps];
    const chosen = this.audio.source.startsWith('app:') ? this.audio.source.slice(4) : null;
    if (chosen && !apps.some((a) => a.key === chosen)) apps.push({ key: chosen, label: chosen[0].toUpperCase() + chosen.slice(1), playing: false });
    for (const a of apps) add(`app:${a.key}`, a.label, !a.playing);
  }

  private renderOverlayModes() {
    if (!isDesktop && !isAndroid) return;
    const box = $('overlay-modes');
    box.innerHTML = '';
    const add = (mode: string | null, label: string) => {
      const b = document.createElement('button');
      b.textContent = label;
      b.dataset.mode = mode ?? 'off';
      b.classList.toggle('on', mode === this.overlayMode);
      b.addEventListener('click', () => {
        if (isAndroid && mode && !this.androidState?.overlayAllowed) this.toast(this.t.androidOverlayPermission, 6000);
        setOverlay(mode);
      });
      box.appendChild(b);
    };
    add(null, this.t.overlayOff);
    for (const m of OVERLAY_MODES) add(m, this.t.overlays[m]);
    this.renderOverlayOptions();
  }

  /** The current style's settings (position, height…), below the style picker. */
  private renderOverlayOptions() {
    const box = $('overlay-options');
    box.innerHTML = '';
    const mode = this.overlayMode as OverlayMode | null;
    const specs = mode ? OVERLAY_OPTIONS[mode] : undefined;
    if (!mode) return;
    if (!specs || !this.overlayOptions) {
      if (isAndroid) box.appendChild(this.androidOpacityRow());
      return;
    }
    const all = this.overlayOptions;
    const set = (key: string, value: string | number) => {
      // Build on the latest settings, not on the ones these controls were drawn with:
      // otherwise moving one slider would undo the other choices made since.
      const now = this.overlayOptions ?? {};
      const next = { ...now, [mode]: { ...now[mode], [key]: value } };
      this.overlayOptions = next;
      setOverlayOptions(next);
    };
    for (const spec of specs) {
      const row = document.createElement('div');
      row.className = 'overlay-option';
      row.dataset.key = spec.key;
      const label = document.createElement('span');
      label.textContent = this.t.overlayOption[spec.key] ?? spec.key;
      row.appendChild(label);
      const current = optionOf(all, mode, spec.key);
      if (spec.kind === 'range') {
        const input = document.createElement('input');
        input.type = 'range';
        input.min = String(spec.min);
        input.max = String(spec.max);
        input.step = String(spec.step);
        input.value = String(current);
        input.setAttribute('aria-label', label.textContent);
        input.addEventListener('input', () => set(spec.key, Number(input.value)));
        row.appendChild(input);
      } else {
        const spots = spec.values === SPOTS;
        const group = document.createElement('div');
        group.className = spots ? 'spots' : 'seg';
        for (const v of spec.values) {
          const b = document.createElement('button');
          b.dataset.value = v;
          const name = this.t.overlayValue[v] ?? v;
          if (spots) {
            b.title = name;
            b.setAttribute('aria-label', name);
          } else b.textContent = name;
          b.classList.toggle('on', v === current);
          b.addEventListener('click', () => {
            group.querySelectorAll('button').forEach((x) => x.classList.toggle('on', x === b));
            set(spec.key, v);
          });
          group.appendChild(b);
        }
        row.appendChild(group);
      }
      box.appendChild(row);
    }
    if (isAndroid) box.appendChild(this.androidOpacityRow());
  }

  /** Android: how opaque the overlay window is (up to the 80 % that still lets touches through). */
  private androidOpacityRow() {
    const row = document.createElement('div');
    row.className = 'overlay-option';
    row.dataset.key = 'opacity';
    const label = document.createElement('span');
    label.textContent = this.t.overlayOption.opacity;
    const input = document.createElement('input');
    input.type = 'range';
    input.min = '0.2';
    input.max = '0.8';
    input.step = '0.05';
    const saved = Number(this.overlayOptions?.android?.opacity);
    input.value = String(saved >= 0.2 && saved <= 0.8 ? saved : 0.8);
    input.setAttribute('aria-label', label.textContent);
    input.addEventListener('input', () => {
      const now = this.overlayOptions ?? {};
      const next = { ...now, android: { ...now.android, opacity: Number(input.value) } };
      this.overlayOptions = next;
      setOverlayOptions(next);
    });
    row.append(label, input);
    return row;
  }

  private cycleOverlay() {
    const i = this.overlayMode ? OVERLAY_MODES.indexOf(this.overlayMode as (typeof OVERLAY_MODES)[number]) : -1;
    setOverlay(i + 1 < OVERLAY_MODES.length ? OVERLAY_MODES[i + 1] : null);
  }
}
