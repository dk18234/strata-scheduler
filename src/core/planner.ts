import { canFit, usage, type Job, type Group, type Config, type Decision } from './model.js';
/** Nonpreemptive, declared-cost service ordering; not a formal DRF implementation. */
export function selectJob(
  jobs: Job[],
  running: Job[],
  groups: Group[],
  config: Config,
  now: number,
): Decision {
  const queued = jobs
    .filter((j) => j.status === 'QUEUED' && j.submitted <= now)
    .sort((a, b) => a.submitted - b.submitted || a.seq - b.seq);
  const scores = groups.map((g) => ({ group: g.id, score: g.served }));
  if (!queued.length) return { reason: 'No arrived jobs are waiting.', scores };
  if (running.length >= config.workers) return { reason: 'All worker slots are reserved.', scores };
  if (config.policy === 'fifo') {
    const head = queued[0]!;
    return canFit(head, running, groups, config)
      ? { job: head, reason: 'Oldest queued job fits all cluster and group quotas.', scores }
      : { reason: `FIFO head ${head.id} is waiting for its declared resources.`, scores };
  }
  // FIFO within each group; cross-group ordering uses accumulated declared dominant service.
  const heads = queued.filter((j, i) => queued.findIndex((other) => other.group === j.group) === i);
  const aged =
    config.policy === 'guard'
      ? queued.find((j) => now - j.submitted >= config.agingTicks)
      : undefined;
  if (aged && canFit(aged, running, groups, config))
    return {
      job: aged,
      protectedJob: aged.id,
      reason: `Aging guard: ${aged.id} has waited ${now - aged.submitted} ticks.`,
      scores,
    };
  const free = { cpu: config.cpu - usage(running).cpu, gpu: config.gpu - usage(running).gpu };
  const candidates = heads
    .filter((j) => canFit(j, running, groups, config))
    .filter((j) => !aged || (free.cpu - j.cpu >= aged.cpu && free.gpu - j.gpu >= aged.gpu));
  candidates.sort(
    (a, b) =>
      groups.find((g) => g.id === a.group)!.served - groups.find((g) => g.id === b.group)!.served ||
      a.submitted - b.submitted ||
      a.seq - b.seq,
  );
  const job = candidates[0];
  return job
    ? {
        job,
        protectedJob: aged?.id,
        reason: aged
          ? `Admitted without consuming resources protected for ${aged.id}.`
          : `Lowest accumulated declared dominant service: ${groups.find((g) => g.id === job.group)!.served.toFixed(3)}.`,
        scores,
      }
    : {
        protectedJob: aged?.id,
        reason: aged
          ? `Aging guard is draining capacity for ${aged.id}; no conflicting new work is admitted.`
          : 'Waiting for capacity or a group quota.',
        scores,
      };
}
