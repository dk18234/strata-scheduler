import { runWorker } from '../build/worker.js';
const stop = new AbortController();
process.once('SIGTERM', () => stop.abort());
await runWorker({
  base: process.env.QUEUE_URL,
  token: process.env.ADMIN_TOKEN,
  id: process.env.WORKER_ID,
  signal: stop.signal,
  log: () => {},
  onClaim: (claim) => process.send?.({ type: 'CLAIMED', ...claim }),
});
