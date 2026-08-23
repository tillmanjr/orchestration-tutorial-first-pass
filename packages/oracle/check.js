// Run invariants against a file. Exits non-zero on any failure, so it works
// as a gate rather than as a report nobody reads.
//
//   node packages/oracle/check.js data/tiny/A.tsv
//   node packages/oracle/check.js out/A.sorted.tsv --sorted --against data/tiny/A.tsv
//   node packages/oracle/check.js data/tiny/A.tsv --mode soa

import { basename } from 'node:path';
import { load } from '../js-sorts/lib/load.js';
import { checkI1, checkI2, checkI3, digest } from './invariants.js';

const argv = process.argv.slice(2);
const files = argv.filter((a) => !a.startsWith('--'));
const flag = (f) => argv.includes(f);
const opt = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };

if (!files.length) { console.error('usage: check.js <file.tsv> [--sorted] [--against <input.tsv>] [--mode aos|soa]'); process.exit(2); }

const path = files[0];
const mode = opt('--mode', 'aos');
const against = opt('--against', null);

const t0 = process.hrtime.bigint();
const loaded = load(path, { mode });
const loadNs = Number(process.hrtime.bigint() - t0);

const results = [checkI1(loaded)];
if (against) results.push(checkI2(digest(load(against, { mode })), digest(loaded)));
if (flag('--sorted')) results.push(checkI3(loaded, loaded.dataset));

const width = 34;
console.log(`${basename(path)}  dataset=${loaded.dataset}  records=${loaded.n}  mode=${mode}  load=${(loadNs / 1e6).toFixed(0)}ms\n`);
for (const r of results) {
  const label = `${r.id} ${r.name}`.padEnd(width);
  console.log(`  ${label} ${r.pass ? 'PASS' : 'FAIL'}${r.inversions ? `  (${r.inversions} inversions)` : ''}`);
  for (const p of r.problems ?? []) console.log(`       ${p.why}${p.prev ? `\n         prev: ${p.prev}\n         curr: ${p.curr}` : ''}`);
}

const failed = results.filter((r) => !r.pass);
console.log(failed.length ? `\n${failed.length} INVARIANT FAILURE(S)` : '\nall invariants passed');
process.exit(failed.length ? 1 : 0);
