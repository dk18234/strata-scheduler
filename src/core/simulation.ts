import {
  assertCapacity,
  cost,
  defaultGroups,
  InputError,
  validateConfig,
  validateGroup,
  validateJob,
  type Config,
  type Group,
  type Job,
  type JobInput,
  type Event,
  type Policy,
} from './model.js';
import { selectJob } from './planner.js';
export interface WorkerState {
  id: string;
  alive: boolean;
}
export interface Segment {
  job: string;
  group: string;
  worker: string;
  start: number;
  end?: number;
  attempt: number;
  outcome: string;
}
export interface Scenario {
  id: string;
  label: string;
  description: string;
  config: Config;
  groups: Group[];
  jobs: JobInput[];
}
export class Simulation {
  time = 0;
  jobs: Job[] = [];
  groups: Group[];
  workers: WorkerState[];
  events: Event[] = [];
  segments: Segment[] = [];
  stale: { job: string; token: string; attempt: number }[] = [];
  rejected = 0;
  decision = '';
  constructor(
    public config: Config,
    groups: Group[],
    inputs: JobInput[],
  ) {
    validateConfig(config);
    if (
      groups.length < 1 ||
      groups.length > 8 ||
      new Set(groups.map((g) => g.id)).size !== groups.length
    )
      throw new InputError('Provide 1–8 unique groups');
    groups.forEach((g) => validateGroup(g, config));
    this.groups = structuredClone(groups);
    this.workers = Array.from({ length: config.workers }, (_, i) => ({
      id: 'worker-' + (i + 1),
      alive: true,
    }));
    inputs.forEach((j) => this.submit(j));
    this.dispatch();
  }
  log(kind: string, detail: string, job?: string, worker?: string) {
    this.events.push({ time: this.time, kind, detail, job, worker });
    if (this.events.length > 10000) throw new InputError('Simulation event limit reached');
  }
  submit(input: JobInput): Job {
    if (this.jobs.length >= 500) throw new InputError('Simulation is limited to 500 jobs');
    const j = validateJob(input, this.config, this.groups),
      job: Job = {
        ...j,
        submitted: input.submitted === undefined ? this.time : j.submitted!,
        id: 'J' + String(this.jobs.length + 1).padStart(3, '0'),
        seq: this.jobs.length + 1,
        status: 'QUEUED',
        attempt: 0,
      };
    this.jobs.push(job);
    this.log('SUBMITTED', job.label, job.id);
    return job;
  }
  dispatch() {
    for (const worker of this.workers) {
      if (!worker.alive || this.jobs.some((j) => j.status === 'RUNNING' && j.worker === worker.id))
        continue;
      const decision = selectJob(this.jobs, this.running(), this.groups, this.config, this.time);
      this.decision = decision.reason;
      if (!decision.job) continue;
      const j = decision.job;
      j.status = 'RUNNING';
      j.attempt++;
      j.started = this.time;
      j.worker = worker.id;
      j.leaseUntil = this.time + 3;
      j.token = j.id + ':' + j.attempt;
      j.reason = decision.reason;
      this.groups.find((g) => g.id === j.group)!.served += cost(
        j,
        this.groups.find((g) => g.id === j.group)!,
        this.config,
      );
      this.segments.push({
        job: j.id,
        group: j.group,
        worker: worker.id,
        start: this.time,
        attempt: j.attempt,
        outcome: 'RUNNING',
      });
      this.log('DISPATCHED', decision.reason, j.id, worker.id);
    }
    assertCapacity(this.running(), this.groups, this.config);
  }
  running() {
    return this.jobs.filter((j) => j.status === 'RUNNING');
  }
  finishSegment(j: Job, outcome: string) {
    const segment = this.segments
      .slice()
      .reverse()
      .find((s) => s.job === j.id && s.attempt === j.attempt);
    if (segment) {
      segment.end = this.time;
      segment.outcome = outcome;
    }
  }
  advance(count = 1) {
    if (!Number.isInteger(count) || count < 1 || count > 3000)
      throw new InputError('Advance 1–3000 ticks');
    for (let step = 0; step < count; step++) {
      this.time++;
      for (const j of this.running()) {
        if (j.leaseUntil! <= this.time) {
          this.finishSegment(j, 'EXPIRED');
          this.log(
            'LEASE_EXPIRED',
            'Reservation released; ownership token invalidated.',
            j.id,
            j.worker,
          );
          j.status = j.attempt >= 3 ? 'FAILED' : 'QUEUED';
          j.token = undefined;
          j.worker = undefined;
          j.leaseUntil = undefined;
          if (j.status === 'FAILED') j.ended = this.time;
          continue;
        }
        const worker = this.workers.find((w) => w.id === j.worker)!;
        if (worker.alive) {
          j.leaseUntil = this.time + 3;
          if (this.time - j.started! >= j.ticks) {
            j.status = 'SUCCEEDED';
            j.ended = this.time;
            this.finishSegment(j, 'SUCCEEDED');
            this.log(
              'COMPLETED',
              'Current attempt committed once; reservation released.',
              j.id,
              j.worker,
            );
            j.token = undefined;
            j.leaseUntil = undefined;
          }
        }
      }
      this.dispatch();
    }
    return this;
  }
  crash(workerId: string) {
    const w = this.workers.find((w) => w.id === workerId);
    if (!w) throw new InputError('Unknown worker');
    w.alive = false;
    const job = this.running().find((j) => j.worker === workerId);
    if (job?.token) this.stale.push({ job: job.id, token: job.token, attempt: job.attempt });
    this.log(
      'WORKER_LOST',
      'Heartbeats stopped. Resources remain reserved until lease expiry.',
      job?.id,
      workerId,
    );
  }
  restart(workerId: string) {
    const w = this.workers.find((w) => w.id === workerId);
    if (!w) throw new InputError('Unknown worker');
    w.alive = true;
    this.log('WORKER_REJOINED', 'Worker can request fresh ownership.', undefined, workerId);
    this.dispatch();
  }
  lateResult() {
    const old = this.stale.at(-1);
    if (!old) throw new InputError('Crash a worker first to retain an old attempt token');
    const j = this.jobs.find((j) => j.id === old.job)!;
    if (j.status !== 'RUNNING' || j.token !== old.token || j.leaseUntil! <= this.time) {
      this.rejected++;
      this.log(
        'STALE_RESULT_REJECTED',
        `Attempt ${old.attempt} cannot commit under current ownership.`,
        j.id,
      );
      return false;
    }
    this.log(
      'LATE_RESULT_NOT_STALE',
      'The lease is still current. Advance until expiry before testing fencing.',
      j.id,
    );
    return true;
  }
  cancel(id: string) {
    const j = this.jobs.find((j) => j.id === id);
    if (!j) throw new InputError('Unknown job');
    if (!['QUEUED', 'RUNNING'].includes(j.status)) return;
    if (j.status === 'RUNNING') this.finishSegment(j, 'CANCELLED');
    j.status = 'CANCELLED';
    j.ended = this.time;
    j.token = undefined;
    j.leaseUntil = undefined;
    this.log('CANCELLED', 'Job cancelled; active reservation released.', id);
    this.dispatch();
  }
  complete() {
    return this.jobs.every((j) => !['QUEUED', 'RUNNING'].includes(j.status));
  }
  drain(limit = 3000) {
    while (!this.complete() && this.time < limit) this.advance();
    if (!this.complete())
      throw new InputError(
        'Simulation did not drain within the horizon; restart an offline worker',
      );
    return this;
  }
  report() {
    return {
      tool: 'Strata',
      version: '1.0.0',
      mode: 'deterministic browser/local simulation',
      time: this.time,
      config: this.config,
      groups: this.groups,
      jobs: this.jobs,
      segments: this.segments,
      events: this.events,
      staleRejected: this.rejected,
      scope: 'CPU/GPU units are logical reservations. No real cluster or GPU is connected.',
    };
  }
}
export function runScenario(scenario: Scenario, policy: Policy) {
  return new Simulation({ ...scenario.config, policy }, scenario.groups, scenario.jobs).drain();
}
export function comparison(scenario: Scenario) {
  return (['fifo', 'fair', 'guard'] as Policy[]).map((policy) => {
    const sim = runScenario(scenario, policy);
    return {
      policy,
      makespan: sim.time,
      groups: sim.groups.map((g) => {
        const jobs = sim.jobs.filter((j) => j.group === g.id),
          starts = jobs.filter((j) => j.started !== undefined).map((j) => j.started! - j.submitted);
        return {
          id: g.id,
          name: g.name,
          jobs: jobs.length,
          firstStart: starts.length ? Math.min(...starts) : null,
          meanWait: starts.length ? starts.reduce((a, b) => a + b, 0) / starts.length : 0,
        };
      }),
    };
  });
}
export function scenarios(): Scenario[] {
  const config: Config = { cpu: 4, gpu: 0, workers: 4, agingTicks: 12, policy: 'fair' },
    groups = defaultGroups(config);
  groups[2]!.weight = 1;
  const flood: Scenario = {
    id: 'fairness',
    label: '100 jobs vs 2',
    description:
      'Atlas submits 100 jobs. Boreal submits 2. Compare access without changing the workload.',
    config,
    groups,
    jobs: [
      ...Array.from({ length: 100 }, (_, i) => ({
        label: 'Atlas batch ' + (i + 1),
        group: 'atlas',
        cpu: 1,
        gpu: 0,
        ticks: 4,
        submitted: 0,
      })),
      ...Array.from({ length: 2 }, (_, i) => ({
        label: 'Boreal analysis ' + (i + 1),
        group: 'boreal',
        cpu: 1,
        gpu: 0,
        ticks: 4,
        submitted: 0,
      })),
    ],
  };
  const mixConfig: Config = { cpu: 8, gpu: 2, workers: 4, agingTicks: 8, policy: 'guard' };
  const mixed: Scenario = {
    id: 'mixed',
    label: 'CPU + GPU mix',
    description:
      'Different job shapes and group weights compete for the same logical CPU and GPU budget.',
    config: mixConfig,
    groups: defaultGroups(mixConfig),
    jobs: Array.from({ length: 18 }, (_, i) => ({
      label:
        ['Genome alignment', 'Model training', 'Climate ensemble'][i % 3] +
        ' ' +
        (Math.floor(i / 3) + 1),
      group: ['atlas', 'boreal', 'cedar'][i % 3]!,
      cpu: [4, 1, 2][i % 3]!,
      gpu: [0, 1, 1][i % 3]!,
      ticks: [6, 4, 8][i % 3]!,
      submitted: Math.floor(i / 6) * 3,
    })),
  };
  const guardConfig: Config = { cpu: 4, gpu: 0, workers: 3, agingTicks: 4, policy: 'guard' };
  const guard: Scenario = {
    id: 'aging',
    label: 'Protect the big job',
    description:
      'A four-CPU job waits behind smaller work. The aging guard drains conflicting capacity without preemption.',
    config: guardConfig,
    groups: defaultGroups(guardConfig),
    jobs: [
      { label: 'Existing long analysis', group: 'atlas', cpu: 3, gpu: 0, ticks: 8, submitted: 0 },
      { label: 'Waiting whole-node job', group: 'boreal', cpu: 4, gpu: 0, ticks: 5, submitted: 1 },
      ...Array.from({ length: 10 }, (_, i) => ({
        label: 'Small follow-up ' + (i + 1),
        group: 'cedar',
        cpu: 1,
        gpu: 0,
        ticks: 4,
        submitted: i + 1,
      })),
    ],
  };
  const failureConfig: Config = { cpu: 4, gpu: 1, workers: 2, agingTicks: 8, policy: 'fair' };
  const failure: Scenario = {
    id: 'failure',
    label: 'Worker failure',
    description:
      'Stop a worker, let its lease expire, then try its old ownership token after reassignment.',
    config: failureConfig,
    groups: defaultGroups(failureConfig),
    jobs: [
      { label: 'Long genome batch', group: 'atlas', cpu: 2, gpu: 0, ticks: 8 },
      { label: 'GPU feature extraction', group: 'boreal', cpu: 2, gpu: 1, ticks: 5 },
      { label: 'Follow-up analysis', group: 'cedar', cpu: 1, gpu: 0, ticks: 4 },
    ],
  };
  return [flood, mixed, guard, failure];
}
