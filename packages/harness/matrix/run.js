// The matrix. Every cell x dataset x load_mode on THIS host, judged against
// THIS host's measured noise floor.
//
//   node packages/harness/matrix/run.js [--repeat 5] [--tier tiny] [--data <dir>] [--write]
//
// THE QUESTION THIS ANSWERS, AND THE ONE IT DOES NOT
//
// Answers: given this machine, which scenario performs best and in what way.
// Does not answer: whether this machine is better than another one.
//
// Results are per-host and never combined. A table with two architectures in
// it is confounded by OS and runtime version as well as hardware, and clearing
// the larger of two floors is necessary but nowhere near sufficient. Each host
// produces its own matrix and its own conclusions.
//
// Refuses to run without an admissible host and a measured floor. A comparison
// with no floor is not a comparison -- there is nothing to judge a difference
// against, and every gap looks meaningful.

import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve, basename } from 'node:path';
import os from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..', '..');
const argv = process.argv.slice(2);
const opt = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };

const TIER = opt('--tier', 'tiny');
const REPEAT = Number(opt('--repeat', '5'));
const DATA = resolve(opt('--data', join(REPO, 'data', TIER)));
const DATASETS = (opt('--datasets', 'A,B,C')).split(',');
const MODES = (opt('--modes', 'aos,soa')).split(',');
const HOST = `${process.platform}-${process.arch}`;

// --- preconditions --------------------------------------------------------

// --floor allows a floor file outside the repo -- useful where the marker
// convention already keeps host-specific state out of version control.
const floorPath = resolve(opt('--floor', join(REPO, 'results', 'instrument', `noise-probe.node.${HOST}.json`)));
if (!existsSync(floorPath)) {
  console.error(`No measured noise floor for ${HOST}.\n  expected: ${floorPath}\n\nRun:  node packages/harness/noise-probe/probe.js --runs 10 --repeat 5 --write\n\nA comparison with no floor is not a comparison: every gap looks meaningful.`);
  process.exit(2);
}
const floorDoc = JSON.parse(readFileSync(floorPath, 'utf8'));
if (!floorDoc.benchmark_admissible) {
  console.error(`The noise floor for ${HOST} was measured on an inadmissible host.\n  ${floorPath}\n  reason: ${floorDoc.admissibility_reason ?? '(not recorded)'}\n\nRe-measure on a declared benchmark host. See MEASUREMENT-CONTRACT §5b.`);
  process.exit(2);
}
const FLOOR = floorDoc.resolution_floor_frac;

const cellDir = join(REPO, 'packages', 'js-sorts', 'cells');
let cells = readdirSync(cellDir).filter((f) => f.endsWith('.js') && !f.startsWith('.')).sort();

// --only quick,radix restricts the run to named cells. Six of thirty rows came
// back UNCONVERGED at mid with --repeat 5, including two scenario winners.
// Re-running those at a higher repeat should not cost a full pass -- and a
// full pass is exactly what someone will skip rather than pay, leaving the
// flag standing in the committed result.
const ONLY = opt('--only', null);
if (ONLY) {
  const want = new Set(ONLY.split(',').map((x) => x.trim()));
  cells = cells.filter((f) => want.has(basename(f, '.js')));
  if (!cells.length) { console.error(`--only '${ONLY}' matched no cells`); process.exit(2); }
}

console.error(`matrix: ${cells.length} cells x ${DATASETS.length} datasets x ${MODES.length} modes, repeat ${REPEAT}`);
console.error(`host:   ${HOST}  ${os.cpus()[0]?.model ?? ''}`);
console.error(`floor:  ${(FLOOR * 100).toFixed(1)}%  (${basename(floorPath)})\n`);

// --- run ------------------------------------------------------------------

const runs = [];
let n = 0, total = cells.length * DATASETS.length * MODES.length;
for (const cell of cells) {
  for (const ds of DATASETS) {
    for (const mode of MODES) {
      n++;
      process.stderr.write(`  ${n}/${total} ${basename(cell, '.js')} ${ds} ${mode}          \r`);
      const r = spawnSync(process.execPath, [
        join(cellDir, cell), '--input', join(DATA, `${ds}.tsv`), '--dataset', ds,
        '--repeat', String(REPEAT), '--tier', TIER, '--load-mode', mode,
      ], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
      if (r.status !== 0) {
        runs.push({ cell: basename(cell, '.js'), dataset: ds, mode, failed: true, exit: r.status, stderr: r.stderr.slice(0, 300) });
        continue;
      }
      const m = JSON.parse(r.stdout);
      const warm = (m.runs ?? []).slice(1).map((x) => x.phases_ns.work);
      const inv = Object.entries(m.invariants ?? {}).filter(([, v]) => v !== 'pass');
      runs.push({
        cell: basename(cell, '.js'), dataset: ds, mode, failed: false,
        threads: m.impl.threads,
        work_warm_min: m.summary_ns.work_warm_min ?? m.summary_ns.work_cold,
        work_cold: m.summary_ns.work_cold,
        work_warm_spread: m.summary_ns.work_warm_spread,
        warm_runs: warm,
        load_min: m.summary_ns.load_min,
        invariants_ok: inv.length === 0,
        notes: m.notes ?? [],
      });
    }
  }
}
process.stderr.write('\n\n');

// --- judge ----------------------------------------------------------------
//
// Two cells are DISTINGUISHABLE only if their gap exceeds the floor as a
// fraction of the faster one. Anything less is not a difference, and saying
// "X is 4% faster" on a host with an 11.5% floor is reporting noise as a
// result.

const ms = (x) => (x / 1e6).toFixed(1);
const report = [];

for (const ds of DATASETS) {
  for (const mode of MODES) {
    const group = runs.filter((r) => r.dataset === ds && r.mode === mode && !r.failed)
                      .sort((a, b) => a.work_warm_min - b.work_warm_min);
    if (!group.length) continue;
    const fastest = group[0];
    // A lead smaller than the floor is not a lead. Naming the top row
    // "fastest" regardless is how a 16% gap on a 21.9%-floor host became a
    // reported result -- the runner said "indistinguishable" in one column and
    // "fastest" in another, and every downstream conclusion read the second.
    const runnerUp = group[1];
    const leadFrac = runnerUp ? (runnerUp.work_warm_min - fastest.work_warm_min) / fastest.work_warm_min : Infinity;
    const hasWinner = leadFrac > FLOOR;
    const rows = group.map((r) => {
      const gap = (r.work_warm_min - fastest.work_warm_min) / fastest.work_warm_min;
      const ties = group.filter((o) => o !== r &&
        Math.abs(o.work_warm_min - r.work_warm_min) / Math.min(o.work_warm_min, r.work_warm_min) < FLOOR
      ).map((o) => o.cell);
      // Dispersion as RELATIVE IQR, not range.
      //
      // The first version used (max - min) / min. Range is a valid dispersion
      // statistic and a broken convergence indicator, because it grows
      // monotonically with sample count: every extra repeat is another chance
      // to catch a GC pause. Going from --repeat 5 to --repeat 15 took the
      // UNCONVERGED count from 6 to 9 -- MORE evidence made the quality flag
      // worse, which is backwards.
      //
      // IQR over the median is sample-size stable, so more repeats now make a
      // row more likely to be judged converged rather than less.
      const warm = (r.warm_runs ?? []).slice().sort((x, y) => x - y);
      const q = (f) => warm.length ? warm[Math.min(warm.length - 1, Math.floor(f * warm.length))] : null;
      const med = q(0.5), p25 = q(0.25), p75 = q(0.75);
      const spreadFrac = (med && p25 != null && p75 != null) ? (p75 - p25) / med : null;
      const converged = spreadFrac == null ? null : spreadFrac <= FLOOR;
      return {
        cell: r.cell, work_warm_min_ns: r.work_warm_min, work_warm_spread_ns: r.work_warm_spread,
        spread_frac: spreadFrac, converged,
        load_min_ns: r.load_min, threads: r.threads, invariants_ok: r.invariants_ok,
        gap_vs_fastest: gap,
        distinguishable_from_fastest: gap > FLOOR,
        indistinguishable_from: ties,
      };
    });
    report.push({ dataset: ds, mode, rows, has_distinguishable_winner: hasWinner,
                  lead_frac: leadFrac === Infinity ? null : leadFrac,
                  winner: hasWinner ? fastest.cell : null });

    console.log(`dataset ${ds}, load_mode ${mode}` + (hasWinner
      ? `   winner: ${fastest.cell} (leads by ${(leadFrac * 100).toFixed(1)}%)`
      : `   NO DISTINGUISHABLE WINNER (top lead ${(leadFrac * 100).toFixed(1)}% is inside the ${(FLOOR * 100).toFixed(1)}% floor)`));
    console.log(`  ${'cell'.padEnd(10)}${'work'.padStart(9)}${'iqr'.padStart(8)}${'load'.padStart(9)}${'vs best'.padStart(10)}   verdict`);
    for (const r of rows) {
      const verdict = r === rows[0] ? (hasWinner ? 'winner' : 'nominally first, not a winner')
        : r.distinguishable_from_fastest ? `slower than ${fastest.cell}`
        : `indistinguishable from ${fastest.cell}`;
      const inv = (r.invariants_ok ? '' : '  [INVARIANT FAILURE]')
        + (r.converged === false ? `  [UNCONVERGED spread ${(r.spread_frac * 100).toFixed(0)}%]` : '');
      console.log(`  ${r.cell.padEnd(10)}${ms(r.work_warm_min_ns).padStart(7)}ms${(r.spread_frac == null ? 'n/a' : (r.spread_frac * 100).toFixed(0) + '%').padStart(8)}${ms(r.load_min_ns).padStart(7)}ms${(r.gap_vs_fastest * 100).toFixed(1).padStart(9)}%   ${verdict}${inv}`);
    }
    console.log('');
  }
}

const failed = runs.filter((r) => r.failed);
if (failed.length) {
  console.log(`${failed.length} RUN(S) FAILED:`);
  for (const f of failed) console.log(`  ${f.cell} ${f.dataset} ${f.mode}: exit ${f.exit}`);
  console.log('');
}

const result = {
  contract: 1, kind: 'matrix',
  host: HOST, cpu: os.cpus()[0]?.model ?? null, cores_logical: os.cpus().length,
  runtime: 'node', runtime_version: process.versions.node,
  tier: TIER, repeat: REPEAT,
  partial: ONLY ? ONLY.split(',').map((x) => x.trim()) : null,
  floor: { value: FLOOR, source: basename(floorPath), admissible: floorDoc.benchmark_admissible },
  scope: 'THIS HOST ONLY. Results are not comparable with another host: a cross-host table is confounded by OS and runtime version as well as hardware.',
  report, failed,
};

if (argv.includes('--write')) {
  const dir = join(REPO, 'results', 'matrix');
  mkdirSync(dir, { recursive: true });
  // --only produces a PARTIAL matrix. Writing it to the canonical filename
  // replaced a five-cell result with a four-cell one and silently dropped
  // `workers` from the record. A convenience that was correct about what it
  // ran and wrong about what it wrote.
  const suffix = ONLY ? `.only-${ONLY.replace(/[^a-z0-9]+/gi, '-')}` : '';
  const p = join(dir, `matrix.node.${HOST}.${TIER}${suffix}.json`);
  writeFileSync(p, JSON.stringify(result, null, 2) + '\n');
  console.error(`wrote ${p}`);
}
process.exit(failed.length ? 1 : 0);
