import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_CONFIG,
  defaultGroups,
  validateJob,
  validateConfig,
  validateGroup,
  cost,
  assertCapacity,
} from '../build/core/model.js';
import { selectJob } from '../build/core/planner.js';
import { Simulation, comparison, scenarios } from '../build/core/simulation.js';
const cfg = { cpu: 4, gpu: 2, workers: 4, agingTicks: 5, policy: 'fair' },
  groups = () => defaultGroups(cfg);
const queued = (id, group = 'atlas', cpu = 1, gpu = 0, submitted = 0) => ({
  id,
  seq: Number(id.replace(/\D/g, '')) || 1,
  label: id,
  group,
  cpu,
  gpu,
  ticks: 4,
  submitted,
  status: 'QUEUED',
  attempt: 0,
});
test('100 versus 2: FIFO waits 100 ticks; weighted policies admit Boreal at tick 0', () => {
  const r = comparison(scenarios()[0]);
  assert.equal(r[0].groups.find((g) => g.id === 'boreal').firstStart, 100);
  for (const result of r.slice(1))
    assert.equal(result.groups.find((g) => g.id === 'boreal').firstStart, 0);
  assert.ok(r.every((x) => x.makespan === 104));
});
for (const s of scenarios())
  for (const policy of ['fifo', 'fair', 'guard'])
    test(`${s.id}/${policy} drains with valid reservations at every tick`, () => {
      const sim = new Simulation({ ...s.config, policy }, s.groups, s.jobs);
      for (let i = 0; !sim.complete() && i < 3000; i++) {
        assertCapacity(sim.running(), sim.groups, sim.config);
        sim.advance();
      }
      assert.ok(sim.complete());
      assert.ok(sim.jobs.every((j) => j.status === 'SUCCEEDED'));
      assert.equal(sim.running().length, 0);
    });
test('weighted declared service gives a 2:1 saturated single-slot share', () => {
  const c = { cpu: 1, gpu: 0, workers: 1, agingTicks: 200, policy: 'fair' },
    g = defaultGroups(c);
  g[1].weight = 2;
  const jobs = [
    ...Array.from({ length: 100 }, () => ({
      label: 'A',
      group: 'atlas',
      cpu: 1,
      gpu: 0,
      ticks: 1,
    })),
    ...Array.from({ length: 100 }, () => ({
      label: 'B',
      group: 'boreal',
      cpu: 1,
      gpu: 0,
      ticks: 1,
    })),
  ];
  const s = new Simulation(c, g, jobs);
  s.advance(59);
  const counts = s.segments.reduce((a, x) => ((a[x.group] = (a[x.group] || 0) + 1), a), {});
  assert.equal(counts.atlas, 20);
  assert.equal(counts.boreal, 40);
});
test('aging guard bounds this whole-node fixture wait without changing makespan', () => {
  const result = comparison(scenarios()[2]);
  assert.equal(result[1].groups.find((g) => g.id === 'boreal').firstStart, 19);
  assert.equal(result[2].groups.find((g) => g.id === 'boreal').firstStart, 7);
  assert.equal(result[1].makespan, result[2].makespan);
});
test('FIFO blocks behind a non-fitting head; fair mode can use another group', () => {
  const active = { ...queued('J0', 'cedar', 3), status: 'RUNNING', worker: 'w0' },
    q = [queued('J1', 'atlas', 4), queued('J2', 'boreal', 1)];
  assert.equal(selectJob(q, [active], groups(), { ...cfg, policy: 'fifo' }, 0).job, undefined);
  assert.equal(selectJob(q, [active], groups(), cfg, 0).job.id, 'J2');
});
test('per-group order does not bypass the group head', () => {
  const active = { ...queued('J0', 'cedar', 3), status: 'RUNNING', worker: 'w0' },
    q = [queued('J1', 'atlas', 4), queued('J2', 'atlas', 1)];
  assert.equal(selectJob(q, [active], groups(), cfg, 0).job, undefined);
});
test('GPU and CPU resource dimensions both constrain admission', () => {
  const running = [{ ...queued('J1', 'atlas', 1, 2), status: 'RUNNING', worker: 'w1' }];
  assert.equal(selectJob([queued('J2', 'boreal', 1, 1)], running, groups(), cfg, 0).job, undefined);
  assert.equal(selectJob([queued('J3', 'boreal', 3, 0)], running, groups(), cfg, 0).job.id, 'J3');
});
test('group CPU and running quotas constrain claims', () => {
  const g = groups();
  g[0].cpuQuota = 1;
  g[0].maxRunning = 1;
  const running = [{ ...queued('J1', 'atlas', 1), status: 'RUNNING', worker: 'w1' }];
  assert.equal(selectJob([queued('J2')], running, g, cfg, 0).job, undefined);
});
test('future arrivals are not eligible', () =>
  assert.equal(selectJob([queued('J1', 'atlas', 1, 0, 5)], [], groups(), cfg, 4).job, undefined));
test('dominant cost uses the larger resource fraction and group weight', () => {
  const g = groups()[0];
  g.weight = 2;
  assert.equal(cost({ cpu: 1, gpu: 1, ticks: 8 }, g, cfg), 2);
});
test('a crashed worker holds resources until expiry and cannot commit after reassignment', () => {
  const s = scenarios()[3],
    sim = new Simulation(s.config, s.groups, s.jobs);
  sim.crash('worker-1');
  const job = sim.jobs[0];
  sim.advance(2);
  assert.equal(job.status, 'RUNNING');
  sim.advance();
  assert.equal(job.status, 'QUEUED');
  assert.equal(sim.lateResult(), false);
  sim.restart('worker-1');
  sim.drain();
  assert.equal(job.status, 'SUCCEEDED');
  assert.equal(job.attempt, 2);
  assert.equal(sim.lateResult(), false);
  assert.equal(sim.rejected, 2);
});
test('crash before lease expiry is not falsely reported as stale', () => {
  const s = scenarios()[3],
    sim = new Simulation(s.config, s.groups, s.jobs);
  sim.crash('worker-1');
  assert.equal(sim.lateResult(), true);
  assert.equal(sim.rejected, 0);
});
test('cancelling a running job revokes ownership and releases reservations', () => {
  const s = scenarios()[3],
    sim = new Simulation(s.config, s.groups, s.jobs),
    j = sim.jobs[0];
  sim.cancel(j.id);
  assert.equal(j.status, 'CANCELLED');
  assert.equal(j.token, undefined);
  assertCapacity(sim.running(), sim.groups, sim.config);
  sim.drain();
  assert.equal(sim.jobs.filter((x) => x.status === 'CANCELLED').length, 1);
});
test('new interactive jobs arrive at the current simulation tick', () => {
  const s = scenarios()[3],
    sim = new Simulation(s.config, s.groups, s.jobs);
  sim.advance(2);
  const j = sim.submit({ label: 'new', group: 'atlas', cpu: 1, gpu: 0, ticks: 1 });
  assert.equal(j.submitted, 2);
});
for (const field of ['cpu', 'gpu', 'ticks'])
  for (const value of [-1, 1.5, NaN, Infinity])
    test(`reject invalid ${field} ${value}`, () => {
      assert.throws(() =>
        validateJob(
          { label: 'test', group: 'atlas', cpu: 1, gpu: 0, ticks: 1, [field]: value },
          cfg,
          groups(),
        ),
      );
    });
test('reject unknown groups, oversized resource requests, and unknown job fields', () => {
  for (const x of [{ group: 'missing' }, { cpu: 5 }, { gpu: 3 }, { label: '' }, { extra: 'x' }])
    assert.throws(() =>
      validateJob({ label: 'test', group: 'atlas', cpu: 1, gpu: 0, ticks: 1, ...x }, cfg, groups()),
    );
});
test('reject invalid configurations and group weights', () => {
  assert.throws(() => validateConfig({ ...cfg, workers: 0 }));
  assert.throws(() => validateConfig({ ...cfg, policy: 'random' }));
  assert.throws(() => validateGroup({ ...groups()[0], weight: 0 }, cfg));
  assert.throws(() => validateGroup({ ...groups()[0], served: NaN }, cfg));
});
test('duplicate worker ownership and oversubscription invariants fail loudly', () => {
  assert.throws(() =>
    assertCapacity(
      [
        { ...queued('J1', 'atlas', 3), worker: 'w' },
        { ...queued('J2', 'boreal', 3), worker: 'w2' },
      ],
      groups(),
      cfg,
    ),
  );
  assert.throws(() =>
    assertCapacity(
      [
        { ...queued('J1'), worker: 'w' },
        { ...queued('J2', 'boreal'), worker: 'w' },
      ],
      groups(),
      cfg,
    ),
  );
});
test('simulation enforces input, advance, and job-count limits', () => {
  assert.throws(
    () =>
      new Simulation(
        cfg,
        groups(),
        Array.from({ length: 501 }, () => ({
          label: 'x',
          group: 'atlas',
          cpu: 1,
          gpu: 0,
          ticks: 1,
        })),
      ),
  );
  const s = scenarios()[3],
    sim = new Simulation(s.config, s.groups, s.jobs);
  assert.throws(() => sim.advance(0));
  assert.throws(() => sim.advance(3001));
  assert.throws(() => sim.lateResult());
});
