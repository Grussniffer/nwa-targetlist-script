import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const root = new URL('../', import.meta.url);
const core = await readFile(new URL('src/core.js', root), 'utf8');
const exporter = await readFile(new URL('src/export.js', root), 'utf8');
const platform = await readFile(new URL('src/platform.js', root), 'utf8');
const app = await readFile(new URL('src/app.js', root), 'utf8');
const header = await readFile(new URL('src/metadata.txt', root), 'utf8');
const output = `${header}\n(() => {\n'use strict';\n${core}\n${exporter}\n${platform}\n${app}\n})();\n`;
await mkdir(new URL('dist/', root), { recursive: true });
await writeFile(new URL('dist/torn-targetlist.user.js', root), output);
// Update checks need only the header; downloadURL still serves the full script.
await writeFile(new URL('dist/torn-targetlist.meta.js', root), header);
console.log(`Built ${fileURLToPath(new URL('dist/torn-targetlist.user.js', root))}`);
console.log(`Built ${fileURLToPath(new URL('dist/torn-targetlist.meta.js', root))}`);
