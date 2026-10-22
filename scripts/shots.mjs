// Screenshot every scene in a headless browser (software WebGL, so no GPU needed).
//   node scripts/shots.mjs [demo|search] [--out dir] [--base url] [--q "query"] [--mobile] [--high] [--wait 9]
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
  },
});
const mode = positionals[0] ?? 'demo';
const scenes = ['fluid', 'galaxy', 'kaleido', 'tunnel', 'ascii'];
mkdirSync(opt.out, { recursive: true });

const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM ?? '/usr/bin/chromium',
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required'],
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
if (opt.stats) {
  await page.evaluate(() => {
    const s = document.getElementById('stats-toggle');
    s.checked = true;
    s.dispatchEvent(new Event('change'));
  });
}
await page.waitForTimeout(Number(opt.wait) * 1000);
for (const [i, name] of scenes.entries()) {
  await page.keyboard.press(String(i + 1));
  if (!opt.mobile) await page.mouse.move(10 + i, 10);
  await page.waitForTimeout(2500);
  await page.screenshot({ path: `${opt.out}/${mode}-${i + 2}-${name}.png` });
}
console.log(await page.locator('#stats').textContent());
console.log(logs.join('\n') || 'no console errors');
await browser.close();
