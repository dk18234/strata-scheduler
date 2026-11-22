import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { QueueStore, DEFAULT_STORE } from '../build/store.js';
import { expectedResult } from '../build/workload.js';
const config = {
    ...DEFAULT_STORE,
    cpu: 2,
    gpu: 1,
    workers: 2,
    tickMs: 100,
    leaseMs: 300,
    graceMs: 300,
  },
  input = { label: 'research', group: 'atlas', cpu: 1, gpu: 0, ticks: 4 };
const make = () => new QueueStore(':memory:', config, 0),
  add = (q, j = input, key = 'first') => q.submit([j], key, 0);
test('idempotent submission is stable and changed payload conflicts', () => {
  const q = make();
  try {
    const a = add(q);
    assert.deepEqual(add(q), { ids: a.ids, duplicate: true });
    assert.equal(q.snapshot(0).jobs.length, 1);
    assert.throws(
      () => add(q, { ...input, cpu: 2 }),
      (e) => e.code === 'IDEMPOTENCY_CONFLICT',
    );
    assert.throws(
      () => add(q, { ...input, submitted: 0 }),
      (e) => e.code === 'IDEMPOTENCY_CONFLICT',
    );
  } finally {
    q.close();
  }
});
test('ownership commits exactly once and releases capacity once', () => {
  const q = make();
  try {
    add(q);
    const c = q.claim('w1', 1),
      result = expectedResult(c.job);
    assert.equal(q.complete(c.job.id, c.token, result, 100).duplicate, false);
    const served = q.groups()[0].served;
    assert.equal(q.complete(c.job.id, c.token, result, 101).duplicate, true);
    const s = q.snapshot(101);
    assert.equal(s.jobs[0].status, 'SUCCEEDED');
    assert.equal(s.reservations.length, 0);
    assert.equal(s.events.filter((e) => e.kind === 'COMPLETED').length, 1);
    assert.equal(q.groups()[0].served, served);
  } finally {
    q.close();
  }
});
test('wrong workload results never commit', () => {
  const q = make();
  try {
    add(q);
    const c = q.claim('w1', 1);
    assert.throws(
      () => q.complete(c.job.id, c.token, 'a'.repeat(64), 50),
      (e) => e.code === 'INVALID_RESULT',
    );
    assert.equal(q.snapshot(50).jobs[0].status, 'RUNNING');
    assert.equal(q.snapshot(50).events.at(-1).kind, 'INVALID_RESULT_REJECTED');
  } finally {
    q.close();
  }
});
test('heartbeats extend only current ownership and stop at hard deadline', () => {
  const q = make();
  try {
    add(q);
    const c = q.claim('w1', 10);
    assert.equal(q.heartbeat(c.job.id, c.token, 200).leaseUntil, 500);
    assert.equal(q.heartbeat(c.job.id, c.token, 450).leaseUntil, 710);
    assert.throws(
      () => q.heartbeat(c.job.id, c.token, 710),
      (e) => e.code === 'FENCED',
    );
    assert.equal(q.snapshot(710).jobs[0].status, 'QUEUED');
  } finally {
    q.close();
  }
});
test('expired attempt cannot heartbeat or complete after reassignment', () => {
  const q = make();
  try {
    add(q);
    const old = q.claim('w1', 0);
    q.recover(300);
    const fresh = q.claim('w2', 301);
    assert.equal(fresh.job.attempt, 2);
    assert.notEqual(old.token, fresh.token);
    assert.throws(
      () => q.complete(old.job.id, old.token, expectedResult(old.job), 302),
      (e) => e.code === 'FENCED',
    );
    assert.throws(
      () => q.heartbeat(old.job.id, old.token, 302),
      (e) => e.code === 'FENCED',
    );
    assert.equal(q.snapshot(302).reservations.length, 1);
    assert.equal(
      q.complete(fresh.job.id, fresh.token, expectedResult(fresh.job), 500).duplicate,
      false,
    );
  } finally {
    q.close();
  }
});
test('lease expiry at the exact boundary invalidates completion', () => {
  const q = make();
  try {
    add(q);
    const c = q.claim('w1', 0);
    assert.throws(
      () => q.complete(c.job.id, c.token, expectedResult(c.job), 300),
      (e) => e.code === 'FENCED',
    );
    assert.equal(q.snapshot(300).reservations.length, 0);
  } finally {
    q.close();
  }
});
test('attempt budgets terminally fail repeated crashed work', () => {
  const q = make();
  try {
    add(q);
    for (let i = 0; i < 3; i++) {
      assert.ok(q.claim('w1', i * 301).job);
      q.recover(i * 301 + 300);
    }
    const s = q.snapshot(1000);
    assert.equal(s.jobs[0].status, 'FAILED');
    assert.equal(s.attempts.length, 3);
    assert.equal(s.reservations.length, 0);
    assert.equal(q.claim('w2', 1001).job, null);
  } finally {
    q.close();
  }
});
test('cancellation fences the current token and is idempotent', () => {
  const q = make();
  try {
    add(q);
    const c = q.claim('w1', 0);
    assert.equal(q.cancel(c.job.id, 10).changed, true);
    assert.equal(q.cancel(c.job.id, 11).changed, false);
    assert.throws(
      () => q.complete(c.job.id, c.token, expectedResult(c.job), 20),
      (e) => e.code === 'FENCED',
    );
    assert.equal(q.snapshot(20).reservations.length, 0);
  } finally {
    q.close();
  }
});
test('one worker cannot own two active attempts', () => {
  const q = make();
  try {
    q.submit([input, input], 'batch', 0);
    q.claim('w1', 0);
    assert.throws(
      () => q.claim('w1', 10),
      (e) => e.code === 'WORKER_BUSY',
    );
    assert.equal(q.snapshot(10).reservations.length, 1);
  } finally {
    q.close();
  }
});
test('snapshot never exposes ownership tokens or hashes', () => {
  const q = make();
  try {
    add(q);
    const c = q.claim('w1', 0),
      s = JSON.stringify(q.snapshot(1));
    assert.ok(!s.includes(c.token));
    assert.ok(!s.includes('token_hash'));
  } finally {
    q.close();
  }
});
test('batch rejection rolls back all jobs', () => {
  const q = make();
  try {
    assert.throws(() => q.submit([input, { ...input, cpu: 99 }], 'batch', 0));
    assert.equal(q.snapshot(0).jobs.length, 0);
    assert.throws(() => q.submit([input], '', 0));
  } finally {
    q.close();
  }
});
test('committed queue, fairness service, and attempt ownership survive reopening', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'strata-')),
    path = join(dir, 'queue.db');
  let q = new QueueStore(path, config, 0);
  try {
    add(q);
    const c = q.claim('w1', 0),
      score = q.groups()[0].served;
    q.close();
    q = new QueueStore(path, { ...config }, 10);
    assert.equal(q.groups()[0].served, score);
    assert.equal(q.snapshot(10).jobs[0].status, 'RUNNING');
    assert.equal(q.heartbeat(c.job.id, c.token, 100).leaseUntil, 400);
    q.close();
    q = new QueueStore(path, config, 500);
    q.recover(500);
    assert.equal(q.snapshot(500).jobs[0].status, 'QUEUED');
    assert.equal(q.snapshot(500).reservations.length, 0);
  } finally {
    q.close();
    await rm(dir, { recursive: true, force: true });
  }
});
test('independent simultaneous processes never oversubscribe reservations', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'strata-concurrent-')),
    path = join(dir, 'queue.db'),
    q = new QueueStore(path, config, 0);
  try {
    q.submit(
      Array.from({ length: 12 }, () => input),
      'many',
      0,
    );
    const exec = promisify(execFile),
      results = await Promise.all(
        Array.from({ length: 8 }, (_, i) =>
          exec(
            process.execPath,
            ['tests/helpers/claim.mjs', path, 'worker-' + i, JSON.stringify(config)],
            { cwd: process.cwd() },
          ),
        ),
      );
    const claims = results.map((r) => JSON.parse(r.stdout)).filter((r) => r.id);
    assert.equal(claims.length, 2);
    assert.equal(new Set(claims.map((c) => c.id)).size, 2);
    const s = q.snapshot(20);
    assert.equal(s.reservations.length, 2);
    assert.equal(
      s.reservations.reduce((n, r) => n + r.cpu, 0),
      2,
    );
  } finally {
    q.close();
    await rm(dir, { recursive: true, force: true });
  }
});
