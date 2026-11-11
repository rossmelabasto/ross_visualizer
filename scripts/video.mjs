// Record a short video of every scene for the website: the built-in demo synth (no one else's
// music), the interface hidden, frames grabbed with the DevTools screencast at high quality and
// joined by ffmpeg with their real timing.
//   node scripts/video.mjs [--base http://127.0.0.1:5190/] [--out video] [--seconds 3.2] [--gpu]
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { chromium } from 'playwright-core';

const { values: opt } = parseArgs({
  options: {
    base: { type: 'string', default: 'http://127.0.0.1:5190/' },
    out: { type: 'string', default: 'video' },
    seconds: { type: 'string', default: '3.2' },
    gpu: { type: 'boolean', default: false },
  },
});
const out = resolve(opt.out);
const framesDir = join(out, 'frames');
rmSync(framesDir, { recursive: true, force: true });
mkdirSync(framesDir, { recursive: true });

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM ?? '/usr/bin/chromium',
  args: [
    ...(opt.gpu ? ['--enable-gpu', '--ignore-gpu-blocklist', '--use-angle=gl'] : ['--use-angle=swiftshader', '--enable-unsafe-swiftshader']),
    '--autoplay-policy=no-user-gesture-required',
  ],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
await page.addInitScript(() => localStorage.setItem('rv_quality', 'high'));
await page.goto(opt.base, { waitUntil: 'networkidle' });
await page.click('#src-demo');
await page.waitForTimeout(4000); // let the synth reach the drop and the palette settle

const frames = [];
const cdp = await page.context().newCDPSession(page);
cdp.on('Page.screencastFrame', async ({ data, metadata, sessionId }) => {
  frames.push({ data, t: metadata.timestamp });
  await cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {});
});

const scenes = ['fluid', 'nebula', 'galaxy', 'aurora', 'kaleido', 'tunnel', 'ascii'];
await page.keyboard.press('1');
await page.evaluate(() => document.body.classList.add('idle'));
await page.waitForTimeout(1500);
await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 92, maxWidth: 1280, maxHeight: 720 });
for (const [i] of scenes.entries()) {
  await page.keyboard.press(String(i + 1));
  await page.evaluate(() => document.body.classList.add('idle'));
  await page.waitForTimeout(Number(opt.seconds) * 1000);
}
await cdp.send('Page.stopScreencast');
await browser.close();

// Each frame lasts until the next one arrives.
let list = 'ffconcat version 1.0\n';
frames.forEach((f, i) => {
  const name = `f${String(i).padStart(5, '0')}.jpg`;
  writeFileSync(join(framesDir, name), Buffer.from(f.data, 'base64'));
  const next = frames[i + 1]?.t ?? f.t + 1 / 30;
  list += `file '${name}'\nduration ${Math.max(0.001, next - f.t).toFixed(4)}\n`;
});
writeFileSync(join(framesDir, 'list.txt'), list);
const span = frames.at(-1).t - frames[0].t;
console.log(`${frames.length} frames over ${span.toFixed(1)} s (${(frames.length / span).toFixed(1)} fps)`);

const ff = (args) => execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'concat', '-i', join(framesDir, 'list.txt'), ...args], { stdio: 'inherit' });
ff(['-vf', 'fps=30,format=yuv420p', '-c:v', 'libx264', '-crf', '22', '-preset', 'slow', '-movflags', '+faststart', '-an', join(out, 'visualizer.mp4')]);
ff(['-vf', 'fps=30', '-c:v', 'libvpx-vp9', '-crf', '36', '-b:v', '0', '-an', join(out, 'visualizer.webm')]);
// A poster from the galaxy, a third of the way in.
execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-ss', String(Number(opt.seconds) * 2.5), '-i', join(out, 'visualizer.mp4'), '-frames:v', '1', '-q:v', '3', join(out, 'visualizer-poster.jpg')]);
rmSync(framesDir, { recursive: true, force: true });
console.log(`video in ${out}`);
