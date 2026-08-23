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
// The reported floor is the LARGER of the two, because a comparison has to
// clear whichever noise it is actually exposed to.

import { spawnSync } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import os from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
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

const floor = Math.max(within.median ?? 0, between.spread_frac ?? 0);

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
  rule: 'A difference between two cells is reportable only if it exceeds resolution_floor_frac of the smaller figure. Below that it is not a difference.',
};

const pct = (x) => (x === null || x === undefined ? 'n/a' : `${(x * 100).toFixed(1)}%`);
console.error(`
  within-process  median ${pct(within.median)}   (range ${pct(within.min)} - ${pct(within.max)})
  between-process        ${pct(between.spread_frac)}   work_warm_min moved ${(between.min / 1e6).toFixed(1)}ms -> ${(between.max / 1e6).toFixed(1)}ms
  between (cold)         ${pct(betweenCold.spread_frac)}
  between (load)         ${pct(betweenLoad.spread_frac)}

  RESOLUTION FLOOR: ${pct(floor)}   admissible host: ${result.benchmark_admissible}
  A gap smaller than this is not a difference.`);

console.log(JSON.stringify(result, null, 2));

if (argv.includes('--write')) {
  const dir = join(REPO, 'results', 'instrument');
  mkdirSync(dir, { recursive: true });
  const p = join(dir, `noise-probe.node.${process.platform}-${process.arch}.json`);
  writeFileSync(p, JSON.stringify(result, null, 2) + '\n');
  console.error(`\nwrote ${p}`);
}
