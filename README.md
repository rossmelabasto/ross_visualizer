# ross_visualizer

**Your music, turned into light.** A real-time music visualizer for the browser: the colors come from the album art, the motion comes from the sound.

**Live demo → [visualizer.rossmel.com](https://visualizer.rossmel.com)** · [Español](README.es.md)

| Fluid | Galaxy |
| --- | --- |
| ![Fluid scene](docs/screenshots/fluid.jpg) | ![Galaxy scene](docs/screenshots/galaxy.jpg) |
| **Kaleidoscope** | **rOS** |
| ![Kaleidoscope scene](docs/screenshots/kaleido.jpg) | ![rOS terminal scene](docs/screenshots/ascii.jpg) |

## What it does

- **Search any song** and it plays the 30-second preview (iTunes Search API, no login) while the visuals take the palette of its cover.
- **Or listen to your own audio**: the microphone, your computer's audio (Chrome/Edge screen-share with "Share audio"), a local file (it reads the embedded cover from MP3/FLAC tags), or a built-in synth track.
- **Four scenes**, cross-faded: a domain-warped fluid, a 120k-particle galaxy, a kaleidoscope tunnel built from the artwork, and a terminal that renders the spectrum in ASCII.
- Works on phones: swipe to change scene, installable as a PWA, keeps the screen awake.

Nothing is uploaded: all the audio analysis happens in your browser.

## How it works

```
audio source ──► AnalyserNode (FFT 4096) ──► FeatureExtractor ──► uniforms ──► WebGL2 scene ──► bloom + tonemap
album art ──► 64×64 pixels ──► k-means in OKLab ──► 5-role palette ──┘
```

**Audio features** (`src/audio/features.ts`, pure and unit-tested):
- Four bands (bass, low-mid, mid, high) with **automatic gain** per band, so a quiet microphone and a loud file both use the full range, plus attack/release smoothing.
- **Beat detection** with spectral flux on the kick range (40–160 Hz) against an adaptive threshold (mean + 1.6σ over the last 1.5 s), falling back to broadband flux for music without a clear kick.
- **Tempo** from a histogram of inter-onset intervals, folded into 80–180 BPM.
- A 128-bin log spectrum with a +3.6 dB/octave tilt so the highs aren't always flat.

**Palette** (`src/color/palette.ts`): the cover is reduced to 64×64, clustered with deterministic k-means++ in **OKLab** (a perceptual color space), and the clusters are scored by size, chroma and lightness to fill five roles: background, primary, secondary, accent and highlight. Muted covers keep their hue; black-and-white covers get the brand lime as accent. Palettes interpolate in OKLab, so song changes fade instead of jumping.

**Rendering** (`src/gl/`): WebGL2 with half-float targets when available, a quarter-resolution bloom, ACES tonemapping and an adaptive resolution that keeps the frame rate up on phones. The galaxy has no simulation state: each particle's position is a function of its index and time, computed in the vertex shader. Shaders are GLSL ES 3.00 so they can be reused on OpenGL ES (Android).

## Run it

```sh
npm install
npm run dev      # http://127.0.0.1:5190
npm test         # unit tests (palette, beat/tempo detection, tag parsing)
npm run build
```

`npm run deploy` publishes `dist/` to a host running the nginx container in `deploy/`; it reads the target from a local `.deploy.env` (see `scripts/deploy.sh`).

## Keys

`1`–`4` scenes · `←`/`→` previous/next · `Space` play/pause · `F` fullscreen · `H` hide the interface · `/` search

## Roadmap

- Spotify sign-in to follow what you're playing automatically.
- Desktop app (Tauri) with a click-through **overlay** mode and native system-audio capture.
- Android app with an overlay mode, reading the system's media session.
- More scenes.

## Credits

Previews and artwork from the [iTunes Search API](https://performance-partners.apple.com/search-api). Font: [JetBrains Mono](https://www.jetbrains.com/lp/mono/) (OFL). OKLab by [Björn Ottosson](https://bottosson.github.io/posts/oklab/); domain warping after [Inigo Quilez](https://iquilezles.org/articles/warp/).

Made by [Rossmel Abasto](https://portfolio.rossmel.com) · MIT License
