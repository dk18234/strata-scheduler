# Learn Strata from scratch

The finished project is a reference we can take apart later. Start with plain-language predictions and small code changes, one stage at a time.

1. **Understand the queue.** Open “100 jobs vs 2”. Find a queued job, a running job, a resource unit, and a worker. Explain why 100 queued jobs should not automatically own every future slot.
2. **Learn the data.** Read `Job`, `Group`, and `Config` in `src/core/model.ts`. Practice ordinary JavaScript objects, arrays, functions, and TypeScript unions using three tiny jobs.
3. **Rebuild FIFO.** Write a function that picks the oldest job only when it fits. Test a large blocked head and a small job behind it. Explain head-of-line blocking.
4. **Add fairness.** Calculate `max(cpu/capacity, gpu/capacity) × ticks / weight` by hand. Read `selectJob` and implement a two-group version without copying the full file. Change a weight and predict who gets the next turn.
5. **Protect old work.** Explore the aging fixture. Explain why admitting endless small jobs can keep a large one waiting. Implement a simple drain rule and discuss its utilization tradeoff.
6. **Learn transactions.** Read the claim path in `src/store.ts`. Explain the unsafe gap between “check free capacity” and “reserve capacity”. Find the `BEGIN IMMEDIATE` boundary that closes that gap.
7. **Learn leases.** Stop a simulated worker, advance three ticks, and send its old result. Explain the difference between a job ID and temporary ownership. Rebuild a tiny token/version check in memory.
8. **Use the real protocol.** Start the server and two independent workers. Submit two jobs. Inspect the HTTP claim, heartbeat, and complete routes. Learn JSON, headers, async/await, status codes, and idempotency as they appear.
9. **Break and recover it.** Run `npm run evidence`. Read the process drill. Identify which child is killed, which state is persisted, which token becomes stale, and why a late result cannot commit. Explain why this does not physically stop arbitrary external side effects.
10. **Own a feature.** Add a small behavior with an explicit test and documentation. A useful next task is a queue-wait metric based on attempt history or a more explicit operator view of group quotas. Do not remove guards just to make a demonstration pass.

## Explain it in interviews

Be ready to explain the policy formula, transactional reservation, one-worker/one-attempt rule, exact expiry boundary, retry budget, stale-token rejection, browser/backend differences, and the synthetic nature of the resource units. State the single-coordinator SQLite limitation and the lack of real GPU execution.

After you understand and can modify it, a factual project bullet is:

> Developed Strata, a fair compute-scheduling lab and durable Node.js queue with atomic CPU/GPU budget reservations, weighted service ordering, fenced worker leases, crash recovery, and reproducible process-failure tests.

AI assisted the initial implementation. Do not claim production cluster impact, formal DRF guarantees, GPU optimization, or independent expertise you have not yet developed. We can use this code to build that understanding step by step.
