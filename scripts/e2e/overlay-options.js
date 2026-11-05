// End-to-end check of the overlay settings, run inside the real app's main window:
//   RV_DEBUG=1 RV_TEST_SCRIPT=scripts/e2e/overlay-options.js ross-visualizer
// It works the Settings panel like a person would and logs "test: …" lines; the overlay
// logs "drawing <style> key=value…" with what it really uses. scripts/e2e/run.sh compares.
(async () => {
  const invoke = window.__TAURI_INTERNALS__.invoke;
  const log = (msg) => invoke('debug_log', { msg: `test: ${msg}` });
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const $ = (sel) => document.querySelector(sel);
  const option = (key) => $(`#overlay-options [data-key="${key}"]`);
  const pick = async (mode) => {
    $(`#overlay-modes [data-mode="${mode}"]`).click();
    await wait(2500);
  };
  const choose = async (key, value) => {
    option(key).querySelector(`[data-value="${value}"]`).click();
    await wait(700);
  };
  const slide = async (key, value) => {
    const input = option(key).querySelector('input');
    // Several steps, like a drag.
    const from = Number(input.value);
    for (let i = 1; i <= 5; i++) {
      input.value = String(from + ((value - from) * i) / 5);
      input.dispatchEvent(new Event('input'));
      await wait(60);
    }
    await wait(700);
  };
  const ui = (key) => {
    const el = option(key);
    if (!el) return 'missing';
    const input = el.querySelector('input');
    return input ? Number(input.value).toFixed(2) : el.querySelector('.on')?.dataset.value ?? 'none';
  };

  await wait(3000);
  $('#btn-settings').click();
  await wait(500);

  await pick('horizon');
  await choose('position', 'top');
  await slide('height', 0.2);
  await log(`step horizon top+0.20 ui position=${ui('position')} height=${ui('height')}`);
  await choose('position', 'both');
  await slide('height', 0.12);
  await log(`step horizon both+0.12 ui position=${ui('position')} height=${ui('height')}`);
  await log('shot horizon-both');
  await wait(1200);

  await pick('wave');
  await choose('position', 'top');
  await slide('height', 0.2);
  await log(`step wave top+0.20 ui position=${ui('position')} height=${ui('height')}`);

  await pick('horizon');
  await log(`step back-to-horizon ui position=${ui('position')} height=${ui('height')}`);

  await pick('orbit');
  await choose('position', 'top-right');
  await slide('size', 0.18);
  await log(`step orbit top-right+0.18 ui position=${ui('position')} size=${ui('size')}`);
  await log('shot orbit');
  await wait(1200);
  await slide('size', 0.1);
  await log(`step orbit size 0.10 ui position=${ui('position')} size=${ui('size')}`);

  await pick('off');
  await log('done');
})();
