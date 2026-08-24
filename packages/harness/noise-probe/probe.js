// noise-probe -- measure this host's timing resolution floor before comparing
// anything on it. MEASUREMENT-CONTRACT §5a.
//
//   node packages/harness/noise-probe/probe.js [--runs 10] [--repeat 3] [--write]
//
// §5a v1.2 fixed the floor at 13%, measured once on one machine at one tier,
// and bound every comparison in the project to it. The first fan-out observed
// 16-200% on a 2-core host and both agents concluded the CONTRACT was wrong.
// The floor is a property of the host, the tier and the load. It must be
// measured where the comparison is made -- the same argument as rss-probe,
// one level up.
//
// TWO VARIANCES, AND THE PROJECT WAS MEASURING THE WRONG ONE
//
//   within-process   spread across warm repeats inside ONE invocation. This
//                    is what work_warm_spread reports and what §5a described.
//
//   between-process  spread of the same figure across SEPARATE invocations.
//
// Cells are compared across process invocations -- each cell is its own
// process, launched separately, possibly minutes apart. So between-process
// variance is the floor that actually governs a cell-vs-cell comparison, and
// nothing had measured it. Within-process spread flatters the instrument: it
// holds page cache, JIT state and allocator arena constant, none of which are
// constant between two cells being compared.
//
// THE FLOOR IS between-process ALONE. An earlier version of this file took
// max() of the two, which was wrong.
//
// They measure different statistics. `within` is the spread of individual warm
// repeats; `between` is the spread of their MINIMA across invocations, and a
// minimum is inherently less variable than the samples it is drawn from.
// Comparing them is not like for like, and max() inflates the floor with a
// figure that governs nothing.
//
// The statistic a comparison actually uses is `work_warm_min`. The floor is
// how much THAT moves between invocations. Within-process spread is a
// diagnostic -- it says whether the minimum has converged -- and is reported
// for that reason, not as a threshold.
//
// Caught on darwin-arm64, where within (15.1%) exceeded between (11.5%) and
// the inversion made the conflation visible. On the two noisier hosts the
// ordering happened to hide it.

import { spawnSync } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import os from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));

// --- recompute -----------------------------------------------------------
//
//   node packages/harness/noise-probe/probe.js --recompute <result.json>
//
// The floor is DERIVED from measurements the file already contains. When the
// derivation is wrong -- as it was once, taking max() of two incommensurable
// statistics -- the fix must never cost a re-run. Raw data is expensive;
// arithmetic over it is free.
//
// This is a small instance of a general rule worth keeping: record the
// measurements, derive the summary, and keep the two separable. A result file
// that stored only the conclusion would have had to be regenerated.
if (process.argv.includes('--recompute')) {
  const { readFileSync: rf, writeFileSync: wf } = await import('node:fs');
  const target = process.argv[process.argv.indexOf('--recompute') + 1];
  if (!target) { console.error('--recompute needs a path to a noise-probe result'); process.exit(2); }
  const m = JSON.parse(rf(target, 'utf8'));
  const oldFloor = m.resolution_floor_frac;
  const floor = m.between_process?.spread_frac ?? null;
  const withinMed = m.within_process?.median_frac ?? 0;
  const converged = withinMed <= 3 * (floor ?? Infinity);
  m.resolution_floor_frac = floor;
  m.floor_source = 'between_process.spread_frac -- movement of work_warm_min, the statistic comparisons actually use';
  m.within_process_converged = converged;
  m.recomputed = true;
  wf(target, JSON.stringify(m, null, 2) + '\n');
  const pc = (x) => (x == null ? 'n/a' : `${(x * 100).toFixed(1)}%`);
  console.error(`${target}\n  floor ${pc(oldFloor)} -> ${pc(floor)}   (${m.platform?.os}-${m.platform?.arch}, admissible: ${m.benchmark_admissible})`);
  console.error(`  within-process median ${pc(withinMed)} -- ${converged ? 'converged' : 'WIDE, raise --repeat next time'}`);
  process.exit(0);
}

const REPO = resolve(HERE, '..', '..', '..');
const argv = process.argv.slice(2);
const opt = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };

const RUNS = Number(opt('--runs', '10'));
const REPEAT = Number(opt('--repeat', '3'));
const DATA = resolve(opt('--data', join(REPO, 'data', 'tiny')));
const TIER = opt('--tier', 'tiny');
const CELL = join(REPO, 'packages', 'js-sorts', 'cells', 'builtin.js');

const stats = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const min = s[0], max = s[s.length - 1];
  const median = s[Math.floor(s.length / 2)];
  return { min, max, median, spread: max - min, spread_frac: min ? (max - min) / min : null };
};

console.error(`noise-probe: ${RUNS} invocations x repeat ${REPEAT}, dataset C, tier ${TIER}`);

const invocations = [];
for (let i = 0; i < RUNS; i++) {
  const r = spawnSync(process.execPath, [
    CELL, '--input', join(DATA, 'C.tsv'), '--dataset', 'C',
    '--repeat', String(REPEAT), '--tier', TIER,
  ], { encoding: 'utf8' });
  if (r.status !== 0) { console.error(r.stderr.slice(0, 400)); throw new Error(`control cell exited ${r.status}`); }
  const m = JSON.parse(r.stdout);
  invocations.push({
    work_cold: m.summary_ns.work_cold,
    work_warm_min: m.summary_ns.work_warm_min,
    work_warm_spread: m.summary_ns.work_warm_spread,
    load_min: m.summary_ns.load_min,
    admissible: m.benchmark_admissible,
  });
  process.stderr.write(`  ${i + 1}/${RUNS}\r`);
}
process.stderr.write('\n');

// Within-process: the spread each invocation reported internally, expressed
// as a fraction of that invocation's own warm minimum.
const withinFracs = invocations
  .filter((v) => v.work_warm_min && v.work_warm_spread !== null)
  .map((v) => v.work_warm_spread / v.work_warm_min);
const within = stats(withinFracs);

// Between-process: how much the warm minimum itself moves across invocations.
const between = stats(invocations.map((v) => v.work_warm_min ?? v.work_cold));
const betweenCold = stats(invocations.map((v) => v.work_cold));
const betweenLoad = stats(invocations.map((v) => v.load_min));

const floor = between.spread_frac ?? null;
// A minimum drawn from wildly scattered repeats is a lucky sample rather than
// a converged figure. This does not change the floor; it flags that the floor
// may be optimistic.
const converged = (within.median ?? 0) <= 3 * (floor ?? Infinity);

const result = {
  contract: 1,
  probe: 'noise',
  runtime: 'node',
  runtime_version: process.versions.node,
  platform: {
    os: process.platform, arch: process.arch,
    cpu: os.cpus()[0]?.model ?? null,
    cores_logical: os.cpus().length,
    ram_bytes: os.totalmem(),
  },
  benchmark_admissible: invocations[0]?.admissible ?? null,
  tier: TIER, dataset: 'C', invocations: RUNS, repeat_per_invocation: REPEAT,
  within_process: {
    note: 'spread across warm repeats inside one invocation, as a fraction of that invocation\'s warm minimum',
    median_frac: within.median, min_frac: within.min, max_frac: within.max,
  },
  between_process: {
    note: 'movement of work_warm_min itself across separate invocations -- the variance a cell-vs-cell comparison is actually exposed to',
    min_ns: between.min, median_ns: between.median, max_ns: between.max,
    spread_frac: between.spread_frac,
  },
  between_process_cold: { min_ns: betweenCold.min, max_ns: betweenCold.max, spread_frac: betweenCold.spread_frac },
  between_process_load: { min_ns: betweenLoad.min, max_ns: betweenLoad.max, spread_frac: betweenLoad.spread_frac },
  resolution_floor_frac: floor,
  floor_source: 'between_process.spread_frac -- movement of work_warm_min, the statistic comparisons actually use',
  within_process_converged: converged,
  within_process_note: converged
    ? 'warm repeats are consistent enough that work_warm_min is a converged figure'
    : 'warm repeats scatter widely relative to the floor: work_warm_min may be a lucky sample rather than a converged minimum. Raise --repeat.',
  rule: 'A difference between two cells is reportable only if it exceeds resolution_floor_frac of the smaller figure. Below that it is not a difference.',
};

const pct = (x) => (x === null || x === undefined ? 'n/a' : `${(x * 100).toFixed(1)}%`);
console.error(`
  within-process  median ${pct(within.median)}   (range ${pct(within.min)} - ${pct(within.max)})
  between-process        ${pct(between.spread_frac)}   work_warm_min moved ${(between.min / 1e6).toFixed(1)}ms -> ${(between.max / 1e6).toFixed(1)}ms
  between (cold)         ${pct(betweenCold.spread_frac)}
  between (load)         ${pct(betweenLoad.spread_frac)}

  RESOLUTION FLOOR: ${pct(floor)}   admissible host: ${result.benchmark_admissible}
  (between-process only; within-process is a convergence diagnostic, not the floor)
  ${converged ? 'work_warm_min is converged.' : 'WARNING: warm repeats scatter widely -- work_warm_min may be a lucky sample. Raise --repeat.'}
  A gap smaller than this is not a difference.`);

console.log(JSON.stringify(result, null, 2));

if (argv.includes('--write')) {
  const dir = join(REPO, 'results', 'instrument');
  mkdirSync(dir, { recursive: true });
  const p = join(dir, `noise-probe.node.${process.platform}-${process.arch}.json`);
  writeFileSync(p, JSON.stringify(result, null, 2) + '\n');
  console.error(`\nwrote ${p}`);
}
