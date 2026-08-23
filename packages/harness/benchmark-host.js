// Report this machine's hostname and whether it is admissible as a benchmark
// host.
//
//   node packages/harness/benchmark-host.js
//
// Admissibility is keyed on HOSTNAME, not on the presence of a file, because
// the agent sandbox reaches the operator's disk through a mount and therefore
// sees the operator's files. A bare marker file would declare the sandbox a
// benchmark host -- restoring exactly the failure the gate exists to prevent.
// A file cannot answer "which machine is executing" when the filesystem is
// shared. A hostname can.

import { hostname, cpus, totalmem } from 'node:os';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Hostnames are case-insensitive by convention, and Windows reports casing
  // inconsistently across contexts. Match lowercased or 'Xenomorph9' silently
  // fails against 'xenomorph9' with a message that looks like a missing entry.
  const here = hostname().toLowerCase();
const root = dirname(fileURLToPath(new URL('../../package.json', import.meta.url)));

console.log(`hostname          ${here}`);
console.log(`platform          ${process.platform}-${process.arch}`);
console.log(`cores / ram       ${cpus().length} logical, ${(totalmem() / 1073741824).toFixed(1)} GB`);
console.log(`env override      ORCH_BENCHMARK_HOST=${process.env.ORCH_BENCHMARK_HOST ?? '(unset)'}`);
console.log('\nsearching upward from the repo root for .benchmark-host:');

let dir = root, found = null;
for (let up = 0; up < 3; up++) {
  const c = join(dir, '.benchmark-host');
  let state = 'absent';
  try { readFileSync(c); state = 'FOUND'; found ??= c; } catch { /* absent */ }
  console.log(`  ${state.padEnd(7)} ${c}`);
  dir = dirname(dir);
}

let admissible = process.env.ORCH_BENCHMARK_HOST === '1';
let why = admissible ? 'ORCH_BENCHMARK_HOST=1' : 'no env override';
if (!admissible && found) {
  const lines = readFileSync(found, 'utf8').split('\n').map((l) => l.trim().toLowerCase()).filter((l) => l && !l.startsWith('#'));
  console.log(`\n  ${found} lists: ${lines.join(', ') || '(empty)'}`);
  admissible = lines.includes('*') || lines.includes(here);
  why = admissible ? `listed in ${found}` : `'${here}' is not listed in ${found}`;
}

console.log(`\n${admissible ? 'ADMISSIBLE' : 'NOT ADMISSIBLE'} -- ${why}`);
if (!admissible) {
  console.log(`\nTo admit this machine, add its hostname to a .benchmark-host file at or above`);
  console.log(`the repo root (outside the repo is better -- it cannot then be committed):`);
  console.log(`\n  echo '${here}' >> ${join(dirname(root), '.benchmark-host')}`);
}
process.exit(admissible ? 0 : 1);
