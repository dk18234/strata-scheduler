import { QueueStore } from '../../build/store.js';
const q = new QueueStore(process.argv[2], JSON.parse(process.argv[4]), 0);
try {
  const c = q.claim(process.argv[3], 10);
  console.log(JSON.stringify({ id: c.job?.id ?? null, token: c.token ?? null }));
} finally {
  q.close();
}
