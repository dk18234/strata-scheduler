import { build } from 'esbuild';
import { mkdir, copyFile, writeFile } from 'node:fs/promises';
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
