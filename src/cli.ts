import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { scenarios, comparison } from './core/simulation.js';
export async function run(args: string[]) {
  const help =
    'Strata: simulate [scenario] | submit file.json | snapshot\nSet QUEUE_URL (default http://127.0.0.1:8086) and ADMIN_TOKEN for durable queue commands.\nUse npm start for the server and npm run worker for an independent worker.\n';
  try {
    if (!args.length || args[0] === '--help') {
      console.log(help);
      return 0;
    }
    if (args[0] === 'simulate') {
      const s = scenarios().find((s) => s.id === (args[1] ?? 'fairness'));
      if (!s) throw new Error('Unknown scenario: fairness, mixed, aging, failure');
      console.log(JSON.stringify(comparison(s), null, 2));
      return 0;
    }
    const base = new URL(process.env.QUEUE_URL ?? 'http://127.0.0.1:8086');
    if (
      base.protocol !== 'http:' ||
      !['127.0.0.1', '[::1]', 'strata', 'queue'].includes(base.hostname) ||
      base.username ||
      base.password
    )
      throw new Error('Use a local HTTP queue URL');
    const token = process.env.ADMIN_TOKEN ?? '';
    if (token.length < 24) throw new Error('Set ADMIN_TOKEN to the local operator token');
    if (!['submit', 'snapshot'].includes(args[0]!)) throw new Error(help);
    let body: string | undefined;
    if (args[0] === 'submit') {
      if (!args[1]) throw new Error('Provide a JSON jobs file');
      const text = await readFile(args[1], 'utf8');
      if (Buffer.byteLength(text) > 131072) throw new Error('Jobs file exceeds 128 KiB');
      const jobs = JSON.parse(text);
      body = JSON.stringify({ jobs: Array.isArray(jobs) ? jobs : [jobs] });
    }
    const result = await fetch(
      new URL(args[0] === 'submit' ? '/api/jobs' : '/api/snapshot', base),
      {
        method: body ? 'POST' : 'GET',
        redirect: 'error',
        headers: {
          'Content-Type': 'application/json',
          'X-Admin-Token': token,
          'Idempotency-Key': process.env.IDEMPOTENCY_KEY ?? randomUUID(),
        },
        body,
        signal: AbortSignal.timeout(5000),
      },
    );
    const value = await result.json();
    if (!result.ok) throw new Error(JSON.stringify(value));
    console.log(JSON.stringify(value, null, 2));
    return 0;
  } catch (e) {
    console.error(e instanceof Error ? e.message : 'Strata command failed');
    return 1;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  process.exitCode = await run(process.argv.slice(2));
