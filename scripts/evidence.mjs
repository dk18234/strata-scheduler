import { mkdir, writeFile } from 'node:fs/promises';
import { scenarios, comparison } from '../build/core/simulation.js';
import { runProcessDrill } from './process-drill.mjs';
await mkdir('reports', { recursive: true });
const results = scenarios().map((s) => ({ scenario: s.id, results: comparison(s) }));
await writeFile('reports/fairness.json', JSON.stringify(results, null, 2) + '\n');
const proof = await runProcessDrill('reports/process-drill.json');
console.log(
  'Reference policy results saved. Process drill:',
  proof.lateResult.code,
  proof.acceptedCompletions,
  'accepted completions,',
  proof.remainingReservations,
  'active reservations.',
);
