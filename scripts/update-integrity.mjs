import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
const manifestUrl = new URL('../roboboy.panel.json', import.meta.url);
const manifest = JSON.parse(await readFile(manifestUrl, 'utf8'));
const bundle = await readFile(new URL('../dist/index.js', import.meta.url));
manifest.integrity = `sha256-${createHash('sha256').update(bundle).digest('base64')}`;
await writeFile(manifestUrl, JSON.stringify(manifest, null, 2) + '\n');
console.log(manifest.integrity);
