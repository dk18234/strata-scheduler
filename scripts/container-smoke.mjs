import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomBytes } from 'node:crypto';
import assert from 'node:assert/strict';
const exec = promisify(execFile),
  name = 'strata-smoke-' + process.pid,
  token = randomBytes(32).toString('hex');
try {
  await exec('docker', [
    'run',
    '--detach',
    '--rm',
    '--name',
    name,
    '--read-only',
    '--tmpfs',
    '/app/data:rw,uid=1000,gid=1000',
    '--cap-drop=ALL',
    '--security-opt=no-new-privileges',
    '-p',
    '127.0.0.1::8086',
    '-e',
    'ADMIN_TOKEN=' + token,
    'strata:ci',
  ]);
  const port = (await exec('docker', ['port', name, '8086'])).stdout.trim().split(':').at(-1),
    base = 'http://127.0.0.1:' + port;
  let ready = false;
  for (let i = 0; i < 40; i++) {
    try {
      ready = (await fetch(base + '/health')).ok;
    } catch {}
    if (ready) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  assert.ok(ready);
  assert.equal((await exec('docker', ['exec', name, 'id', '-u'])).stdout.trim(), '1000');
  assert.equal((await fetch(base + '/api/snapshot')).status, 401);
  const submitted = await fetch(base + '/api/jobs', {
    method: 'POST',
    headers: {
      'X-Admin-Token': token,
      'Content-Type': 'application/json',
      'Idempotency-Key': 'container',
    },
    body: JSON.stringify({
      label: 'Container challenge',
      group: 'atlas',
      cpu: 1,
      gpu: 0,
      ticks: 1,
    }),
  });
  assert.equal(submitted.status, 201);
  await exec('docker', [
    'exec',
    '-e',
    'QUEUE_URL=http://127.0.0.1:8086',
    '-e',
    'WORKER_ID=container-worker',
    name,
    'node',
    '--input-type=module',
    '-e',
    "import{runWorker}from'./build/worker.js';await runWorker({base:process.env.QUEUE_URL,token:process.env.ADMIN_TOKEN,id:process.env.WORKER_ID,once:true,log:()=>{}})",
  ]);
  const s = await (
    await fetch(base + '/api/snapshot', { headers: { 'X-Admin-Token': token } })
  ).json();
  assert.equal(s.jobs[0].status, 'SUCCEEDED');
  assert.equal(s.reservations.length, 0);
  console.log(
    'Nonroot/read-only container: authenticated submission, independent worker challenge, verified completion, zero remaining reservations.',
  );
} finally {
  await exec('docker', ['rm', '--force', name]).catch(() => {});
}
