import { pbkdf2, pbkdf2Sync } from 'node:crypto';
import type { Job } from './core/model.js';
type Work = Pick<Job, 'id' | 'label' | 'cpu' | 'gpu' | 'ticks'>;
const input = (j: Work) => JSON.stringify([j.id, j.label, j.cpu, j.gpu, j.ticks]);
/** Small deterministic CPU challenge, not GPU work or a throughput benchmark. */
export function expectedResult(j: Work): string {
  return pbkdf2Sync(input(j), 'strata-synthetic-v1', 1000 * j.ticks, 32, 'sha256').toString('hex');
}
export async function execute(j: Work): Promise<string> {
  return new Promise((done, fail) =>
    pbkdf2(input(j), 'strata-synthetic-v1', 1000 * j.ticks, 32, 'sha256', (error, value) =>
      error ? fail(error) : done(value.toString('hex')),
    ),
  );
}
