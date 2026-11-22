# Policy and exact scope

## Three policies, one admission boundary

Every policy first requires the requested logical CPU/GPU units, group quotas, and a worker slot to fit. Resources are nonpreemptive and indivisible. Invalid jobs exceeding the cluster/group budget are rejected on submission.

| Policy             | Ordering                                                                        | When a job cannot fit                                                                        |
| ------------------ | ------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Strict FIFO        | Oldest arrival, then submission sequence                                        | Whole queue waits behind the head                                                            |
| Weighted fair      | One FIFO head per group; lowest accumulated declared service first              | Another group's eligible head may run                                                        |
| Fair + aging guard | Weighted policy, with a guard for the oldest arrived job past the age threshold | Drain conflicting capacity; only admit work leaving the protected resource request available |

The guard is intentionally conservative. It is not EASY backfill, does not predict future start times, and does not preempt current work. It can reduce utilization while draining. Complementary work may proceed only when it cannot consume resources needed by the protected job. Group quotas remain enforced.

## Declared service

At dispatch, charge the selected group:

`max(cpu / cluster.cpu, gpu / cluster.gpu) × declaredTicks / weight`

If the cluster has no GPU capacity, its GPU term is zero and GPU jobs cannot be submitted. The score is cumulative for the lifetime of the queue/experiment. It is charged before execution and retained for a cancelled or failed attempt; retries cost additional service. This avoids erasing charged opportunity through cancellation, but it is not measured CPU utilization or true consumed compute.

This policy is inspired by dominant resource shares and weighted fair queueing. It is not an implementation of continuous DRF and does not inherit its formal strategy-proof, envy-free, or max-min guarantees. Job size declarations, indivisibility, new groups, historical scores, quotas, aging, and failures affect observed outcomes. There is no universal latency, fairness, or optimality claim.

## Fixed reference results

| Workload                                          |      FIFO | Weighted fair | Fair + guard |
| ------------------------------------------------- | --------: | ------------: | -----------: |
| 100 Atlas jobs + 2 Boreal jobs: first Boreal wait | 100 ticks |       0 ticks |      0 ticks |
| Same workload: makespan                           | 104 ticks |     104 ticks |    104 ticks |
| Whole-node aging fixture: first Boreal wait       |   7 ticks |      19 ticks |      7 ticks |
| Whole-node aging fixture: makespan                |  29 ticks |      25 ticks |     25 ticks |

These are deterministic outputs of the committed reference fixtures, not generalized performance improvements. The browser computes them by running all policies to completion on the same reference inputs. Interactive additions/faults do not change the reference comparison panel. The current experiment export records its own event history.

## Ownership protocol

A successful claim creates one reservation and one attempt token. A heartbeat may extend that lease only until a hard runtime deadline. At the exact expiry/deadline boundary the token is invalid. Recovery releases resources and requeues the job until the attempt budget is exhausted. Completion validates current ownership and the deterministic workload result before recording success. Repeated completion of an already successful attempt with the same result is idempotent; it cannot create another release or accepted-completion event.

A dead worker can continue doing physical work outside the coordinator's awareness. Fencing prevents its **result commit**, not arbitrary external side effects. There are no external business side effects in the bundled workload. Logical resource accounting is not proof that CPU/GPU use is physically bounded. A production executor needs isolation, cancellation, placement, and side-effect design.
