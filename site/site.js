const tabs = [...document.querySelectorAll('[role="tab"]')];

function select(tab) {
  for (const other of tabs) {
    const on = other === tab;
    other.setAttribute('aria-selected', String(on));
    other.tabIndex = on ? 0 : -1;
    document.getElementById(other.getAttribute('aria-controls')).hidden = !on;
  }
}

tabs.forEach((tab, i) => {
  tab.tabIndex = i === 0 ? 0 : -1;
  tab.addEventListener('click', () => select(tab));
  tab.addEventListener('keydown', (event) => {
    const step = { ArrowRight: 1, ArrowLeft: -1 }[event.key];
    if (!step) return;
    event.preventDefault();
    const next = tabs[(i + step + tabs.length) % tabs.length];
    select(next);
    next.focus();
  });
});

// Open the tab for the visitor's system when the browser gives it away.
if (/fedora/i.test(navigator.userAgent)) select(document.getElementById('b-rpm'));
else if (/ubuntu|debian/i.test(navigator.userAgent)) select(document.getElementById('b-deb'));

for (const button of document.querySelectorAll('.copy')) {
  button.addEventListener('click', async () => {
    const text = button.parentElement.querySelector('code').textContent;
    try {
      await navigator.clipboard.writeText(text);
      button.textContent = 'Copiado';
    } catch {
      button.textContent = 'Selecciona y copia';
    }
    setTimeout(() => { button.textContent = 'Copiar'; }, 1600);
  });
}
