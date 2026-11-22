export type Policy = 'fifo' | 'fair' | 'guard';
export type Status = 'QUEUED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED';
export interface Config {
  cpu: number;
  gpu: number;
  workers: number;
  agingTicks: number;
  policy: Policy;
}
export interface Group {
  id: string;
  name: string;
  weight: number;
  cpuQuota: number;
  gpuQuota: number;
  maxRunning: number;
  served: number;
}
export interface Job {
  id: string;
  seq: number;
  label: string;
  group: string;
  cpu: number;
  gpu: number;
  ticks: number;
  submitted: number;
  status: Status;
  attempt: number;
  started?: number;
  ended?: number;
  worker?: string;
  leaseUntil?: number;
  token?: string;
  reason?: string;
}
export interface JobInput {
  label: string;
  group: string;
  cpu: number;
  gpu: number;
  ticks: number;
  submitted?: number;
}
export interface Decision {
  job?: Job;
  reason: string;
  protectedJob?: string;
  scores: { group: string; score: number }[];
}
export interface Event {
  time: number;
  kind: string;
  job?: string;
  worker?: string;
  detail: string;
}
export class InputError extends Error {
  constructor(
    message: string,
    public code = 'INVALID_INPUT',
    public status = 400,
  ) {
    super(message);
    this.name = 'InputError';
  }
}
export const DEFAULT_CONFIG: Config = {
  cpu: 8,
  gpu: 2,
  workers: 4,
  agingTicks: 6,
  policy: 'guard',
};
export const policies: Record<Policy, string> = {
  fifo: 'Strict FIFO',
  fair: 'Weighted fair',
  guard: 'Fair + aging guard',
};
export function defaultGroups(c: Config): Group[] {
  return [
    {
      id: 'atlas',
      name: 'Atlas Lab',
      weight: 1,
      cpuQuota: c.cpu,
      gpuQuota: c.gpu,
      maxRunning: c.workers,
      served: 0,
    },
    {
      id: 'boreal',
      name: 'Boreal Lab',
      weight: 1,
      cpuQuota: c.cpu,
      gpuQuota: c.gpu,
      maxRunning: c.workers,
      served: 0,
    },
    {
      id: 'cedar',
      name: 'Cedar Lab',
      weight: 2,
      cpuQuota: c.cpu,
      gpuQuota: c.gpu,
      maxRunning: c.workers,
      served: 0,
    },
  ];
}
export const integer = (value: unknown, min: number, max: number, label: string): number => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max)
    throw new InputError(`${label} must be an integer from ${min} to ${max}`);
  return value;
};
export function validateConfig(c: Config): void {
  integer(c.cpu, 1, 64, 'CPU capacity');
  integer(c.gpu, 0, 16, 'GPU capacity');
  integer(c.workers, 1, 16, 'Worker slots');
  integer(c.agingTicks, 1, 200, 'Aging threshold');
  if (!Object.hasOwn(policies, c.policy)) throw new InputError('Unknown policy');
}
export function validateGroup(g: Group, c: Config): void {
  if (!/^[a-z][a-z0-9-]{0,23}$/.test(g.id) || typeof g.name !== 'string' || g.name.length > 60)
    throw new InputError('Invalid group');
  if (typeof g.weight !== 'number' || !Number.isFinite(g.weight) || g.weight < 0.1 || g.weight > 10)
    throw new InputError('Group weight must be between 0.1 and 10');
  integer(g.cpuQuota, 1, c.cpu, 'Group CPU quota');
  integer(g.gpuQuota, 0, c.gpu, 'Group GPU quota');
  integer(g.maxRunning, 1, c.workers, 'Group running quota');
  if (!Number.isFinite(g.served) || g.served < 0)
    throw new InputError('Group service must be finite and nonnegative');
}
export function validateJob(input: unknown, c: Config, groups: Group[]): JobInput {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new InputError('Job must be an object');
  const j = input as Record<string, unknown>;
  if (
    Object.keys(j).some((k) => !['label', 'group', 'cpu', 'gpu', 'ticks', 'submitted'].includes(k))
  )
    throw new InputError('Unknown job field');
  if (typeof j.label !== 'string' || !j.label.trim() || j.label.length > 80)
    throw new InputError('Job label must contain 1–80 characters');
  const group = groups.find((g) => g.id === j.group);
  if (!group) throw new InputError('Unknown research group');
  const cpu = integer(j.cpu, 1, Math.min(c.cpu, group.cpuQuota), 'Requested CPU'),
    gpu = integer(j.gpu, 0, Math.min(c.gpu, group.gpuQuota), 'Requested GPU'),
    ticks = integer(j.ticks, 1, 30, 'Duration');
  return {
    label: j.label.trim(),
    group: group.id,
    cpu,
    gpu,
    ticks,
    submitted: j.submitted === undefined ? 0 : integer(j.submitted, 0, 3000, 'Arrival tick'),
  };
}
export function cost(job: Pick<Job, 'cpu' | 'gpu' | 'ticks'>, group: Group, c: Config): number {
  return (Math.max(job.cpu / c.cpu, c.gpu ? job.gpu / c.gpu : 0) * job.ticks) / group.weight;
}
export function usage(jobs: Job[]) {
  return jobs.reduce((u, j) => ({ cpu: u.cpu + j.cpu, gpu: u.gpu + j.gpu, count: u.count + 1 }), {
    cpu: 0,
    gpu: 0,
    count: 0,
  });
}
export function canFit(job: Job, running: Job[], groups: Group[], c: Config): boolean {
  const all = usage(running),
    own = usage(running.filter((j) => j.group === job.group)),
    g = groups.find((g) => g.id === job.group);
  return (
    !!g &&
    all.count < c.workers &&
    all.cpu + job.cpu <= c.cpu &&
    all.gpu + job.gpu <= c.gpu &&
    own.count < g.maxRunning &&
    own.cpu + job.cpu <= g.cpuQuota &&
    own.gpu + job.gpu <= g.gpuQuota
  );
}
export function assertCapacity(running: Job[], groups: Group[], c: Config): void {
  const u = usage(running);
  if (u.cpu > c.cpu || u.gpu > c.gpu || u.count > c.workers)
    throw new Error('Cluster reservation invariant violated');
  for (const g of groups) {
    const own = usage(running.filter((j) => j.group === g.id));
    if (own.cpu > g.cpuQuota || own.gpu > g.gpuQuota || own.count > g.maxRunning)
      throw new Error('Group reservation invariant violated');
  }
  if (
    new Set(running.map((j) => j.worker).filter(Boolean)).size <
    running.filter((j) => j.worker).length
  )
    throw new Error('Worker owns multiple active attempts');
}
