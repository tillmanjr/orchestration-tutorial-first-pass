// M3's exit criterion, as a command rather than as a chat message.
//
//   node packages/generator/verify-determinism.js [--tier tiny]
//
// Regenerates the tier into a temporary directory and compares against the
// committed reference in results/determinism/. Exits non-zero on any
// mismatch, so it works as a gate.
//
// The comparison localises the fault rather than just reporting one:
//
//   differing record or node counts  -> the PRNG diverged; look at pcg32.js
//                                       or at draw order (DATASET-SPEC §9.1)
//   matching counts, differing hash  -> structure is right, encoding is not;
//                                       look at line endings, UTF-8, or the
//                                       pad pool (§9.4)

import { spawnSync } from 'node:child_process';
import { readFileSync, mkdtempSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..');
const argv = process.argv.slice(2);
const tier = (() => { const i = argv.indexOf('--tier'); return i >= 0 && argv[i + 1] ? argv[i + 1] : 'tiny'; })();

const refPath = join(REPO, 'results', 'determinism', `tier-${tier}.json`);
let ref;
try { ref = JSON.parse(readFileSync(refPath, 'utf8')); }
catch { console.error(`no committed reference for tier '${tier}' at ${refPath}`); process.exit(2); }

const out = mkdtempSync(join(tmpdir(), 'orch-determinism-'));
const run = spawnSync(process.execPath,
  [join(HERE, 'generate.js'), '--tier', tier, '--seed', String(ref.seed), '--out', out],
  { encoding: 'utf8' });
if (run.status !== 0) { console.error(run.stderr || run.stdout); console.error('generator failed'); process.exit(1); }

const got = JSON.parse(readFileSync(join(out, tier, 'generate-manifest.json'), 'utf8'));

console.log(`tier ${tier}  seed ${ref.seed}  spec v${ref.spec_version}`);
console.log(`this machine: ${process.platform}-${process.arch}, node ${process.versions.node}\n`);

let bad = 0;
for (const [file, want] of Object.entries(ref.files)) {
  const have = got.files[file];
  const countsOk = have && have.records === want.records && have.l2_nodes === want.l2_nodes;
  const hashOk = have && have.sha256 === want.sha256;
  const verdict = hashOk ? 'OK'
    : !countsOk ? 'PRNG DIVERGED'
    : 'ENCODING DIVERGED';
  if (!hashOk) bad++;
  console.log(`  ${file.padEnd(8)} ${verdict}`);
  if (!hashOk) {
    console.log(`      expected ${want.sha256}  records=${want.records} nodes=${want.l2_nodes}`);
    console.log(`      got      ${have?.sha256 ?? '(missing)'}  records=${have?.records} nodes=${have?.l2_nodes}`);
    console.log(countsOk
      ? '      counts match: structure is correct, bytes are not. See DATASET-SPEC §9.4 and line endings.'
      : '      counts differ: the generator diverged. See pcg32.js and DATASET-SPEC §9.1.');
  }
}

const prev = ref.confirmed_on.map((c) => c.platform);
console.log(`\npreviously confirmed on: ${prev.join(', ')}`);
console.log(bad ? `\n${bad} FILE(S) DIVERGED` : '\nPASS: byte-identical to the committed reference');
process.exit(bad ? 1 : 0);
