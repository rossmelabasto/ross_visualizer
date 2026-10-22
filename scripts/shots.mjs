// Screenshot every scene in a headless browser (software WebGL, so no GPU needed).
//   node scripts/shots.mjs [demo|search] [--out dir] [--base url] [--q "query"] [--mobile] [--high] [--wait 9]
//                          [--only fluid,aurora] [--frames 3]
// The tunnel is shot once per version.
// Uses the system Chromium; set CHROMIUM to point elsewhere.
import { mkdirSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { chromium } from 'playwright-core';

const { values: opt, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    out: { type: 'string', default: 'shots' },
    base: { type: 'string', default: 'http://127.0.0.1:5190/' },
    q: { type: 'string', default: 'jose madero' },
    mobile: { type: 'boolean', default: false },
    high: { type: 'boolean', default: false },
    stats: { type: 'boolean', default: true },
    wait: { type: 'string', default: '9' },
    only: { type: 'string', default: '' },
    frames: { type: 'string', default: '1' },
    gpu: { type: 'boolean', default: false },
    clean: { type: 'boolean', default: false }, // hide the interface (for README screenshots)
  },
});
const mode = positionals[0] ?? 'demo';
const scenes = ['fluid', 'nebula', 'galaxy', 'aurora', 'kaleido', 'tunnel', 'ascii'];
mkdirSync(opt.out, { recursive: true });

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM ?? '/usr/bin/chromium',
  // --gpu uses the real graphics card (for frame rates); the default works without one.
  args: [
    ...(opt.gpu ? ['--enable-gpu', '--ignore-gpu-blocklist', '--use-angle=gl'] : ['--use-angle=swiftshader', '--enable-unsafe-swiftshader']),
    '--autoplay-policy=no-user-gesture-required',
  ],
});
const page = await browser.newPage({
  viewport: opt.mobile ? { width: 390, height: 844 } : { width: 1280, height: 800 },
  deviceScaleFactor: 1,
  hasTouch: opt.mobile,
  isMobile: opt.mobile,
});
if (opt.high) await page.addInitScript(() => localStorage.setItem('rv_quality', 'high'));
const logs = [];
page.on('console', (m) => (m.type() === 'error' || m.type() === 'warning') && logs.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`));

await page.goto(opt.base, { waitUntil: 'networkidle' });
await page.waitForTimeout(1500);
await page.screenshot({ path: `${opt.out}/${mode}-0-start.png` });

if (mode === 'demo') {
  await page.click('#src-demo');
} else {
  await page.fill('#search', opt.q);
  await page.waitForSelector('.results button', { timeout: 10000 });
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${opt.out}/${mode}-1-results.png` });
  await page.click('.results button');
}
if (opt.stats && !opt.clean) {
  await page.evaluate(() => {
    const s = document.getElementById('stats-toggle');
    s.checked = true;
    s.dispatchEvent(new Event('change'));
  });
}
await page.waitForTimeout(Number(opt.wait) * 1000);
const only = opt.only ? opt.only.split(',') : scenes;
for (const [i, name] of scenes.entries()) {
  if (!only.includes(name)) continue;
  await page.keyboard.press(String(i + 1));
  const versions = name === 'tunnel' ? 3 : 1;
  for (let v = 0; v < versions; v++) {
    if (v > 0) await page.keyboard.press('v');
    for (let k = 0; k < Number(opt.frames); k++) {
      if (!opt.mobile && !opt.clean) await page.mouse.move(10 + i + k, 10);
      await page.waitForTimeout(2500);
      if (opt.clean) {
        await page.evaluate(() => document.body.classList.add('idle'));
        await page.waitForTimeout(800);
      }
      const tag = `${versions > 1 ? `-v${v + 1}` : ''}${Number(opt.frames) > 1 ? `-${k}` : ''}`;
      await page.screenshot({ path: `${opt.out}/${mode}-${i + 2}-${name}${tag}.png` });
      if (opt.gpu) console.log(name + tag, (await page.locator('#stats').textContent()).match(/fps.*/)?.[0]);
    }
  }
}
console.log(await page.locator('#stats').textContent());
console.log(logs.join('\n') || 'no console errors');
await browser.close();
