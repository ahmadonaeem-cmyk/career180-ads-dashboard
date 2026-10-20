// Embeds data/data.json into site/index.html → dist/index.html.
// The single self-contained file is what gets encrypted (optional) and deployed.

import { mkdir, readFile, writeFile } from 'node:fs/promises';

const dataPath = process.argv[2] || 'data/data.json';
const [html, data] = await Promise.all([
  readFile('site/index.html', 'utf8'),
  readFile(dataPath, 'utf8'),
]);

const MARKER = '/*__DATA__*/null';
if (!html.includes(MARKER)) throw new Error(`Placeholder ${MARKER} not found in site/index.html`);

// Keep the JSON from closing the <script> tag early.
const safe = data.replace(/</g, '\\u003c');
await mkdir('dist', { recursive: true });
await writeFile('dist/index.html', html.replace(MARKER, () => safe));
console.log(`Built dist/index.html (${((html.length + safe.length) / 1024).toFixed(0)} KB) from ${dataPath}`);
