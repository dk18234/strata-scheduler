# Operations

## Defaults and limits

| Setting           | Value                                                        |
| ----------------- | ------------------------------------------------------------ |
| Runtime           | Node.js 24.14+ with built-in SQLite                          |
| Host / port       | `127.0.0.1:8086`                                             |
| Queue file        | `data/strata.db`                                             |
| Cluster budget    | 8 logical CPU, 2 logical GPU, 4 active slots                 |
| Groups            | Atlas 1×, Boreal 1×, Cedar 2×; each quota bounded by cluster |
| Policy            | Weighted fair with aging guard after 8 ticks                 |
| Tick duration     | 250 ms                                                       |
| Lease             | 1,500 ms, renewals capped at runtime deadline                |
| Runtime deadline  | Declared ticks × tick duration + 1,000 ms grace              |
| Attempt budget    | Three                                                        |
| Job duration      | 1–30 ticks                                                   |
| Request body      | 128 KiB                                                      |
| Batch             | 1–200 jobs                                                   |
| Durable history   | 1,000 jobs; new database for another experiment              |
| Worker identities | 100 per database                                             |
| Events            | Latest 10,000 retained; snapshots return latest 1,000        |
| Browser model     | 500 jobs, bounded 3,000-tick drain horizon                   |

Queue configuration is persisted and must match when reopened. Defaults are selected in `src/store.ts`. A test/embedding caller can supply a bounded configuration directly. The HTTP API cannot rewrite quotas or deployment settings. The browser's weight controls reset only the reference experiment and have no effect on a local backend.

## API behavior

Use a random operator token of at least 24 characters. Keep it in the environment and worker memory, not browser code, Git, or screenshots. Claims return attempt tokens; snapshots do not. The same operator credential is shared by this local teaching setup, so it is not a multi-tenant authentication system.

201 means new jobs were committed; 200 may mean an idempotent replay or successful operation. 400 indicates invalid input, 401 missing operator authorization, 404 an unknown job/route, 409 conflicting ownership/idempotency/result, 413 an oversized request, and 429 a bounded history/identity limit. The caller must handle a null claim as “no eligible work”, not an error.

Workers accept loopback HTTP queue addresses and the explicit Compose service names `strata`/`queue`. Redirects are rejected. Retries after transport errors do not invent ownership. If a heartbeat fails, the worker avoids committing that attempt; recovery later reassigns it. Runtime deadlines prevent endless renewal. A live stalled worker can therefore lose ownership even while heartbeating.

## Shutdown and recovery

SIGTERM stops the server and closes SQLite. SIGKILL relies on committed SQLite WAL state. A worker that exits leaves its reservation until expiry. The coordinator sweeps expired leases every 200 ms and also recovers them inside claims/protocol operations. A new worker needs a fresh token; an old token cannot regain permission by naming the same worker ID.

The token fences database result commits. It cannot stop a disconnected process from consuming real CPU or touching an external service. The included workload has no external side effects. Use a real executor isolation/side-effect design before considering untrusted jobs or production integration.

## Container

Compose uses a persistent named volume and three worker containers. The image runs as UID 1000 and supports a read-only root with `/app/data` mounted writable. Host exposure is loopback. No TLS, public-service identity, distributed lock service, GPU drivers, container placement, or cgroup scheduling is included.

Run `npm run evidence` for a fresh disposable-process drill. Do not kill unrelated processes; the script tracks only its own child PIDs and removes only its own temporary test directory.
