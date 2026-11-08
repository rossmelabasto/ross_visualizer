// Assemble the website into a directory: the page with its version and changelog filled in,
// the compatibility script and the screenshots.
//   node scripts/release/site.mjs <output-dir>
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const out = resolve(process.argv[2] ?? join(root, '_site'));

const escape = (text) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function inline(text) {
  return escape(text)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
}

/** Just the Markdown the changelog uses: sections, subsections, lists and paragraphs. */
function renderChangelog(markdown) {
  const html = [];
  let inList = false;
  const closeList = () => {
    if (inList) html.push('</ul>');
    inList = false;
  };
  const lines = markdown.split('\n');
  // The title and the intro belong to the file, not to the section on the page.
  const start = lines.findIndex((line) => line.startsWith('## '));
  for (const line of lines.slice(start)) {
    if (line.startsWith('### ')) {
      closeList();
      html.push(`<h4>${inline(line.slice(4))}</h4>`);
    } else if (line.startsWith('## ')) {
      closeList();
      html.push(`<h3>${inline(line.slice(3))}</h3>`);
    } else if (line.startsWith('- ')) {
      if (!inList) html.push('<ul>');
      inList = true;
      html.push(`<li>${inline(line.slice(2))}</li>`);
    } else if (line.trim()) {
      closeList();
      html.push(`<p>${inline(line)}</p>`);
    }
  }
  closeList();
  return html.join('\n');
}

const { version } = JSON.parse(readFileSync(join(root, 'src-tauri/tauri.conf.json'), 'utf8'));
const changelog = renderChangelog(readFileSync(join(root, 'CHANGELOG.es.md'), 'utf8'));
const page = readFileSync(join(root, 'site/index.html'), 'utf8')
  .replaceAll('@VERSION@', version)
  .replace('@CHANGELOG@', () => changelog);

mkdirSync(join(out, 'shots'), { recursive: true });
writeFileSync(join(out, 'index.html'), page);
for (const file of ['style.css', 'site.js']) cpSync(join(root, 'site', file), join(out, file));
cpSync(join(root, 'scripts/check.sh'), join(out, 'check.sh'));
cpSync(join(root, 'public/icon-512.png'), join(out, 'icon.png'));
for (const shot of ['galaxy', 'aurora', 'kaleido']) {
  cpSync(join(root, `docs/screenshots/${shot}.jpg`), join(out, `shots/${shot}.jpg`));
}
console.log(`Site ready in ${out} (version ${version})`);
