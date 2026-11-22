import { build } from 'esbuild';
import { mkdir, copyFile, writeFile, readFile, readdir, unlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { scenarios, comparison } from '../build/core/simulation.js';
await mkdir('docs', { recursive: true });
await build({
  entryPoints: { app: 'src/web/app.ts', engine: 'src/core/simulation.ts' },
  bundle: true,
  platform: 'browser',
  format: 'esm',
  target: ['es2022'],
  outdir: 'docs',
  minify: true,
  legalComments: 'inline',
});
for (const file of ['index.html', 'styles.css', 'favicon.svg'])
  await copyFile('src/web/' + file, 'docs/' + file);
// Content-addressed browser assets prevent a cached stylesheet from hiding a released fix.
for (const file of await readdir('docs')) {
  if (/^(app|styles)-[a-f0-9]{10}\.(js|css)$/.test(file)) await unlink('docs/' + file);
}
const fingerprint = async (file) =>
  createHash('sha256')
    .update(await readFile('docs/' + file))
    .digest('hex')
    .slice(0, 10);
const script = 'app-' + (await fingerprint('app.js')) + '.js';
const stylesheet = 'styles-' + (await fingerprint('styles.css')) + '.css';
await copyFile('docs/app.js', 'docs/' + script);
await copyFile('docs/styles.css', 'docs/' + stylesheet);
const html = (await readFile('src/web/index.html', 'utf8'))
  .replace('src="./app.js"', 'src="./' + script + '"')
  .replace('href="./styles.css"', 'href="./' + stylesheet + '"');
await writeFile('docs/index.html', html);
await writeFile('docs/.nojekyll', '');
await writeFile(
  'docs/reference-results.json',
  JSON.stringify(
    scenarios().map((s) => ({ scenario: s.id, results: comparison(s) })),
    null,
    2,
  ) + '\n',
);
console.log('Built the shared scheduler, durable queue, worker, and browser lab.');
