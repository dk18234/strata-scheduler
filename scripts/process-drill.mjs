import { spawn, fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import { expectedResult } from '../build/workload.js';
import { assertCapacity } from '../build/core/model.js';
export async function runProcessDrill(outputPath) {
  const dir = await mkdtemp(join(tmpdir(), 'strata-process-')),
    token = randomBytes(32).toString('hex'),
    children = [];
  let server,
    base,
    port = 0;
  const wait = async (predicate, message, limit = 14000) => {
    const end = Date.now() + limit;
    while (Date.now() < end) {
      const v = await predicate();
      if (v) return v;
      await delay(40);
    }
    throw new Error(message);
  };
  const post = async (path, body, key = 'drill') => {
    const r = await fetch(base + path, {
      method: 'POST',
      redirect: 'error',
      headers: {
        'X-Admin-Token': token,
        'Content-Type': 'application/json',
        'Idempotency-Key': key,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(2000),
    });
    return { status: r.status, value: await r.json() };
  };
  const snapshot = async () => {
    const r = await fetch(base + '/api/snapshot', {
      headers: { 'X-Admin-Token': token },
      signal: AbortSignal.timeout(2000),
    });
    assert.equal(r.status, 200);
    const s = await r.json();
    assertCapacity(
      s.jobs.filter((j) => j.status === 'RUNNING'),
      s.groups,
      s.config,
    );
    return s;
  };
  const start = async () => {
    const p = spawn(process.execPath, ['build/server.js'], {
      env: {
        ...process.env,
        ADMIN_TOKEN: token,
        DB_PATH: join(dir, 'queue.db'),
        PORT: String(port),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    children.push(p);
    let stdout = '',
      stderr = '';
    p.stdout.on('data', (x) => (stdout += x));
    p.stderr.on('data', (x) => (stderr += x));
    const ready = await wait(
      () => {
        if (p.exitCode !== null) throw new Error('Server exited: ' + stderr);
        const line = stdout.split('\n').find((l) => l.startsWith('{'));
        return line ? JSON.parse(line) : null;
      },
      'Server startup timed out',
      5000,
    );
    port = ready.port;
    base = 'http://127.0.0.1:' + port;
    return p;
  };
  const kill = async (p, signal) => {
    if (!p || p.exitCode !== null || p.signalCode) return;
    const exited = once(p, 'exit');
    p.kill(signal);
    await exited;
  };
  const worker = (id) => {
    const p = fork('scripts/drill-worker.mjs', [], {
      env: { ...process.env, QUEUE_URL: base, ADMIN_TOKEN: token, WORKER_ID: id },
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    });
    children.push(p);
    return p;
  };
  try {
    server = await start();
    const submitted = await post('/api/jobs', {
      jobs: [
        { label: 'Long genome batch', group: 'atlas', cpu: 2, gpu: 0, ticks: 18 },
        { label: 'Small GPU budget job', group: 'boreal', cpu: 1, gpu: 1, ticks: 2 },
        { label: 'Follow-up challenge', group: 'cedar', cpu: 1, gpu: 0, ticks: 3 },
      ],
    });
    assert.equal(submitted.status, 201);
    const victim = worker('victim');
    const [claimed] = await Promise.race([
      once(victim, 'message'),
      delay(5000).then(() => {
        throw new Error('Victim never claimed a job');
      }),
    ]);
    assert.equal(claimed.type, 'CLAIMED');
    const oldJob = claimed.job,
      oldToken = claimed.token;
    await kill(victim, 'SIGKILL');
    const before = await snapshot();
    assert.equal(before.jobs.find((j) => j.id === oldJob.id).status, 'RUNNING');
    assert.ok(before.reservations.some((r) => r.job_id === oldJob.id));
    await kill(server, 'SIGKILL');
    server = await start();
    const reopened = await snapshot();
    assert.equal(reopened.jobs.length, 3);
    assert.equal(reopened.jobs.find((j) => j.id === oldJob.id).attempt, 1);
    const a = worker('healthy-a'),
      b = worker('healthy-b');
    const reassigned = await wait(async () => {
      const s = await snapshot(),
        j = s.jobs.find((j) => j.id === oldJob.id);
      return j.attempt === 2 && j.status === 'RUNNING' ? s : null;
    }, 'Expired job was not reassigned');
    const fenced = await post('/api/jobs/' + oldJob.id + '/complete', {
      token: oldToken,
      result: expectedResult(oldJob),
    });
    assert.equal(fenced.status, 409);
    assert.equal(fenced.value.code, 'FENCED');
    const afterFence = await snapshot();
    assert.equal(afterFence.jobs.find((j) => j.id === oldJob.id).attempt, 2);
    assert.equal(afterFence.jobs.find((j) => j.id === oldJob.id).status, 'RUNNING');
    const final = await wait(async () => {
      const s = await snapshot();
      return s.jobs.every((j) => j.status === 'SUCCEEDED') ? s : null;
    }, 'Healthy workers did not finish all jobs');
    assert.equal(final.reservations.length, 0);
    assert.equal(final.events.filter((e) => e.kind === 'COMPLETED').length, 3);
    assert.equal(final.attempts.filter((a) => a.status === 'EXPIRED').length, 1);
    assert.ok(final.events.some((e) => e.kind === 'STALE_RESULT_REJECTED'));
    const evidence = {
      tool: 'Strata',
      implementation: 'independent Node server and worker OS processes; SQLite WAL',
      workerKilled: 'SIGKILL',
      serverKilled: 'SIGKILL',
      jobsPersisted: reopened.jobs.length,
      expiredAttempts: 1,
      lateResult: { status: fenced.status, code: fenced.value.code },
      allJobsSucceeded: true,
      acceptedCompletions: 3,
      remainingReservations: 0,
      capacityCheckedOnEverySnapshot: true,
      attempts: final.jobs.map((j) => ({ label: j.label, attempt: j.attempt, status: j.status })),
      scope:
        'Local synthetic CPU challenges. Logical GPU/CPU budgets, no production cluster benchmark.',
    };
    if (outputPath) {
      await mkdir(dirname(outputPath), { recursive: true });
      await writeFile(outputPath, JSON.stringify(evidence, null, 2) + '\n');
    }
    return evidence;
  } finally {
    for (const child of children.reverse()) await kill(child, 'SIGTERM').catch(() => {});
    await rm(dir, { recursive: true, force: true });
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const report = await runProcessDrill('reports/process-drill.json');
  console.log(JSON.stringify(report, null, 2));
}
