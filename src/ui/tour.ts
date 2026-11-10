// The welcome tour of the desktop app: shown on the first launch, over the running visualizer,
// and again from Settings. On a session without the overlay, its two steps become one.
import type { DesktopInfo } from '../desktop/bridge';
import type { Lang, Strings } from './i18n';
import { DESKTOP_NAMES, overlayCommands, shortcutConfig } from './shortcuts';

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

interface Step {
  title: string;
  body: string;
}

export class Tour {
  private step = 0;
  private steps: Step[] = [];

  constructor(
    private readonly el: HTMLElement,
    private readonly ctx: () => { t: Strings; lang: Lang; info: DesktopInfo; overlay: boolean },
    private readonly onClose: () => void,
  ) {
    el.addEventListener('click', (e) => {
      const target = e.target as HTMLElement;
      const action = target.closest<HTMLElement>('[data-tour]')?.dataset.tour;
      if (action === 'skip' || (action === 'next' && this.step === this.steps.length - 1)) this.close();
      else if (action === 'next') this.go(this.step + 1);
      else if (action === 'back') this.go(this.step - 1);
      else if (action === 'copy') this.copy(target.closest('.tour-code')!);
    });
  }

  get isOpen() {
    return !this.el.hidden;
  }

  open() {
    this.build();
    this.el.hidden = false;
    this.go(0);
  }

  close() {
    this.el.hidden = true;
    this.onClose();
  }

  /** Arrow keys and Enter move through the tour; Escape skips it. */
  key(e: KeyboardEvent) {
    if (e.key === 'Escape') this.close();
    else if (e.key === 'ArrowRight' || e.key === 'Enter') {
      if (this.step === this.steps.length - 1) this.close();
      else this.go(this.step + 1);
    } else if (e.key === 'ArrowLeft') this.go(this.step - 1);
    else return;
    e.preventDefault();
  }

  /** Redraw in the current language, on the same step. */
  refresh() {
    if (!this.isOpen) return;
    this.build();
    this.go(this.step);
  }

  private build() {
    const { t, lang, info, overlay } = this.ctx();
    const tt = t.tour;
    const keys = (rows: [string, string][]) =>
      `<dl class="tour-keys">${rows.map(([k, v]) => `<div><dt><kbd>${esc(k)}</kbd></dt><dd>${esc(v)}</dd></div>`).join('')}</dl>`;
    const note = (s: string) => `<p class="tour-note">${esc(s)}</p>`;
    const code = (s: string) =>
      `<div class="tour-code"><pre><code>${esc(s)}</code></pre><button type="button" data-tour="copy">${esc(tt.copy)}</button></div>`;

    this.steps = [
      { title: tt.welcomeTitle, body: `<p>${esc(tt.welcomeBody)}</p>${note(tt.welcomeNote)}` },
      { title: tt.scenesTitle, body: `<p>${esc(tt.scenesBody)}</p>${keys(tt.scenesKeys)}${note(tt.scenesNote)}` },
    ];
    if (!overlay) {
      this.steps.push({ title: tt.overlayTitle, body: `<p>${esc(tt.noOverlayBody)}</p>${note(tt.noOverlayNote)}` });
      return;
    }
    this.steps.push({ title: tt.overlayTitle, body: `<p>${esc(tt.overlayBody)}</p>${keys(tt.overlayKeys)}${note(tt.overlayNote)}` });

    const name = DESKTOP_NAMES[info.desktop];
    const detected = name ? `<p class="tour-detected"><span>${esc(tt.detected)}</span> ${esc(name)}</p>` : '';
    const config = shortcutConfig(info.desktop, info.command, lang);
    let how: string;
    if (config) how = `${code(config)}<p>${esc(tt.keysWhere[info.desktop])}</p>`;
    else if (info.desktop === 'kde')
      how = `<ol class="tour-steps">${tt.kdeSteps.map((s) => `<li>${esc(s)}</li>`).join('')}</ol>${code(overlayCommands(info.command).join('\n'))}`;
    else how = `<p>${esc(tt.otherBody)}</p>${code(overlayCommands(info.command).join('\n'))}`;
    this.steps.push({ title: tt.keysTitle, body: `<p>${esc(tt.keysBody)}</p>${detected}${how}${note(tt.keysResult)}` });
  }

  private go(i: number) {
    const { t } = this.ctx();
    const tt = t.tour;
    this.step = Math.max(0, Math.min(this.steps.length - 1, i));
    const last = this.step === this.steps.length - 1;
    const s = this.steps[this.step];
    this.el.innerHTML = `
      <div class="tour-card" role="dialog" aria-modal="true" aria-labelledby="tour-title">
        <p class="tour-count">${this.step + 1} ${esc(tt.of)} ${this.steps.length}</p>
        <h2 id="tour-title">${esc(s.title)}</h2>
        <div class="tour-body">${s.body}</div>
        <footer>
          <div class="tour-dots">${this.steps.map((_, k) => `<i class="${k === this.step ? 'on' : ''}"></i>`).join('')}</div>
          ${last ? '' : `<button type="button" class="tour-skip" data-tour="skip">${esc(tt.skip)}</button>`}
          ${this.step > 0 ? `<button type="button" class="tour-btn" data-tour="back">${esc(tt.back)}</button>` : ''}
          <button type="button" class="tour-btn primary" data-tour="next">${esc(last ? tt.done : tt.next)}</button>
        </footer>
      </div>`;
    this.el.querySelector<HTMLElement>('[data-tour="next"]')?.focus();
  }

  private async copy(box: Element) {
    const { t } = this.ctx();
    const button = box.querySelector('button')!;
    const text = box.querySelector('code')!.textContent ?? '';
    let ok = false;
    try {
      await navigator.clipboard.writeText(text);
      ok = true;
    } catch {
      // WebKitGTK may not expose the async clipboard: copy the old way.
      const range = document.createRange();
      range.selectNodeContents(box.querySelector('code')!);
      const sel = getSelection();
      sel?.removeAllRanges();
      sel?.addRange(range);
      ok = document.execCommand('copy');
    }
    if (!ok) return;
    button.textContent = t.tour.copied;
    setTimeout(() => (button.textContent = t.tour.copy), 1600);
  }
}
