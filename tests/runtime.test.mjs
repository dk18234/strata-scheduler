import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../build/server.js';
import { runWorker } from '../build/worker.js';
import { expectedResult } from '../build/workload.js';
import { DEFAULT_STORE } from '../build/store.js';
import { comparison, scenarios } from '../build/core/simulation.js';
import { runProcessDrill } from '../scripts/process-drill.mjs';
const ready = async (s) => {
  if (!s.listening) await once(s, 'listening');
  return 'http://127.0.0.1:' + s.address().port;
};
const close = (s) =>
  new Promise((r) => {
    s.closeAllConnections();
    s.close(r);
  });
const token = 'strata-unit-test-token-at-least-24';
test('HTTP API authenticates, bounds input, and runs the real ownership protocol', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'strata-api-')),
    app = startServer({ token, port: 0, dbPath: join(dir, 'queue.db') });
  try {
    const base = await ready(app.server),
      post = async (path, value, headers = {}) =>
        fetch(base + path, {
          method: 'POST',
          headers: { 'X-Admin-Token': token, 'Content-Type': 'application/json', ...headers },
          body: JSON.stringify(value),
        });
    assert.equal((await fetch(base + '/health')).status, 200);
    assert.equal((await fetch(base + '/api/snapshot')).status, 401);
    const payload = { label: 'HTTP job', group: 'atlas', cpu: 1, gpu: 0, ticks: 2 };
    const first = await post('/api/jobs', payload, { 'Idempotency-Key': 'api-test' });
    assert.equal(first.status, 201);
    const duplicate = await post('/api/jobs', payload, { 'Idempotency-Key': 'api-test' });
    assert.equal(duplicate.status, 200);
    assert.equal((await duplicate.json()).duplicate, true);
    const claim = await (await post('/api/workers/claim', { worker: 'w1' })).json();
    assert.ok(claim.token);
    assert.equal(
      (await post('/api/jobs/' + claim.job.id + '/heartbeat', { token: claim.token })).status,
      200,
    );
    const complete = await post('/api/jobs/' + claim.job.id + '/complete', {
      token: claim.token,
      result: expectedResult(claim.job),
    });
    assert.equal(complete.status, 200);
    const snap = await (
      await fetch(base + '/api/snapshot', { headers: { 'X-Admin-Token': token } })
    ).json();
    assert.equal(snap.jobs[0].status, 'SUCCEEDED');
    assert.ok(!JSON.stringify(snap).includes(claim.token));
    assert.equal((await post('/api/jobs', payload)).status, 400);
    const huge = await fetch(base + '/api/jobs', {
      method: 'POST',
      headers: { 'X-Admin-Token': token },
      body: ' '.repeat(131073),
    });
    assert.equal(huge.status, 413);
    const page = await fetch(base + '/');
    assert.equal(page.status, 200);
    assert.match(await page.text(), /A fair share/);
    assert.match(page.headers.get('content-security-policy'), /script-src 'self'/);
    assert.equal((await fetch(base + '/%2e%2e%2fpackage.json')).status, 404);
  } finally {
    await close(app.server);
    await rm(dir, { recursive: true, force: true });
  }
});
test('an independent worker loop executes and submits a verified synthetic challenge', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'strata-worker-')),
    app = startServer({
      token,
      port: 0,
      dbPath: join(dir, 'queue.db'),
      config: { ...DEFAULT_STORE, tickMs: 30 },
    });
  try {
    const base = await ready(app.server);
    app.store.submit(
      [{ label: 'CPU challenge', group: 'atlas', cpu: 1, gpu: 0, ticks: 1 }],
      'worker-test',
    );
    await runWorker({ base, token, id: 'real-loop', once: true, log: () => {} });
    assert.equal(app.store.snapshot().jobs[0].status, 'SUCCEEDED');
    assert.equal(app.store.snapshot().reservations.length, 0);
  } finally {
    await close(app.server);
    await rm(dir, { recursive: true, force: true });
  }
});
test('generated browser engine matches the Node engine reference results', async () => {
  const browser = await import('../docs/engine.js');
  for (const s of scenarios()) assert.deepEqual(browser.comparison(s), comparison(s));
});
test(
  'actual SIGKILL of worker and server preserves jobs, reassigns work, and fences old completion',
  { timeout: 25000 },
  async () => {
    const r = await runProcessDrill();
    assert.equal(r.allJobsSucceeded, true);
    assert.equal(r.acceptedCompletions, 3);
    assert.equal(r.lateResult.code, 'FENCED');
    assert.equal(r.expiredAttempts, 1);
  },
);
