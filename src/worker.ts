import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { execute } from './workload.js';
import type { Job } from './core/model.js';
export async function runWorker(options: {
  base: string;
  token: string;
  id?: string;
  signal?: AbortSignal;
  once?: boolean;
  log?: (message: string) => void;
  onClaim?: (claim: { job: Job; token: string }) => void;
}) {
  const url = new URL(options.base);
  if (
    url.protocol !== 'http:' ||
    !['127.0.0.1', '[::1]', 'strata', 'queue'].includes(url.hostname) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error(
      'Worker needs an explicit local HTTP queue (loopback or Compose service strata/queue)',
    );
  if (options.token.length < 24) throw new Error('Set ADMIN_TOKEN');
  const id = options.id ?? 'worker_' + randomUUID().slice(0, 8),
    log = options.log ?? console.log;
  const post = async (path: string, value: unknown) => {
    const r = await fetch(new URL(path, url), {
      method: 'POST',
      redirect: 'error',
      headers: { 'Content-Type': 'application/json', 'X-Admin-Token': options.token },
      body: JSON.stringify(value),
      signal: AbortSignal.timeout(3000),
    });
    const result = (await r.json()) as Record<string, unknown>;
    if (!r.ok) throw new Error(String(result.code ?? r.status));
    return result;
  };
  while (!options.signal?.aborted) {
    let claim: Record<string, unknown>;
    try {
      claim = await post('/api/workers/claim', { worker: id });
    } catch (error) {
      log('Queue unavailable; retrying without changing ownership.');
      if (options.once) throw error;
      await delay(250).catch(() => {});
      continue;
    }
    if (!claim.job) {
      if (options.once) return;
      await delay(100).catch(() => {});
      continue;
    }
    const job = claim.job as Job,
      token = String(claim.token),
      started = Date.now();
    options.onClaim?.({ job, token });
    let fenced = false;
    log('CLAIMED ' + job.id + ' attempt ' + job.attempt + ' by ' + id);
    const heartbeat = setInterval(() => {
      void post('/api/jobs/' + job.id + '/heartbeat', { token }).catch(() => {
        fenced = true;
      });
    }, Number(claim.heartbeatMs));
    try {
      const result = await execute(job);
      const remain = Math.max(0, Number(claim.runMs) - (Date.now() - started));
      if (remain) await delay(remain, undefined, { signal: options.signal });
      if (!fenced && !options.signal?.aborted) {
        await post('/api/jobs/' + job.id + '/complete', { token, result });
        log('COMPLETED ' + job.id);
      }
    } catch {
      log('Attempt interrupted or fenced; no result committed.');
    } finally {
      clearInterval(heartbeat);
    }
    if (options.once) return;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const controller = new AbortController();
  process.once('SIGTERM', () => controller.abort());
  process.once('SIGINT', () => controller.abort());
  await runWorker({
    base: process.env.QUEUE_URL ?? 'http://127.0.0.1:8086',
    token: process.env.ADMIN_TOKEN ?? '',
    id: process.env.WORKER_ID,
    signal: controller.signal,
  });
}
