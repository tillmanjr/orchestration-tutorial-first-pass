// Cell runner. Every JS cell in the matrix goes through this, so phases,
// cold/warm handling, RSS sampling and manifest shape are identical across
// the row and only the algorithm differs.
//
// The cell times ITSELF, here, inside its own runtime. The harness that
// launches it never wraps it in a stopwatch -- that figure would include
// process spawn and pipe transit, neither of which is a property of a sorting
// algorithm. See MEASUREMENT-CONTRACT §1.

import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import os from 'node:os';
import { load } from './load.js';
import { checkI1, checkI2, checkI3, digest } from '../../oracle/invariants.js';

// ms since process start, including Node bootstrap. Captured at import time so
// it is as close to "the process began" as this runtime allows.
const STARTUP_MS = performance.now();

const ns = () => process.hrtime.bigint();

// maxRSS is in kilobytes on every platform Node runs here -- verified, not
// assumed. See MEASUREMENT-CONTRACT §5 and results/instrument/.
const peakRssBytes = () => process.resourceUsage().maxRSS * 1024;

function serialise(loaded) {
  const parts = [];
  if (loaded.mode === 'soa') {
    for (let i = 0; i < loaded.n; i++) {
      parts.push(`${loaded.ds}\t${loaded.l1[i]}\t${loaded.l2[i]}\t${loaded.l3ord[i]}\t${loaded.d[i]}\n`);
    }
  } else {
    for (const r of loaded.rows) parts.push(`${r.ds}\t${r.l1}\t${r.l2}\t${r.l3ord}\t${r.d}\n`);
  }
  return parts.join('');
}

/**
 * @param {object} job         parsed job spec (MEASUREMENT-CONTRACT §6)
 * @param {object} impl        { name, algorithm, threads, parallelStrategy }
 *   algorithm(loaded) -> a loaded-shaped object in sorted order.
 */
export function runCell(job, impl) {
  const input = job.inputs[0];
  const repeat = job.repeat ?? 1;
  const runs = [];
  const notes = [];

  let lastSorted = null, lastLoaded = null;

  for (let i = 0; i < repeat; i++) {
    const t0 = ns();
    const loaded = load(input.path, { mode: job.load_mode ?? 'aos', dataset: input.dataset });
    const t1 = ns();

    const sorted = impl.algorithm(loaded);
    const t2 = ns();

    let emitNs = 0;
    if (job.output?.emit) {
      const text = serialise(sorted);
      mkdirSync(dirname(job.output.path), { recursive: true });
      writeFileSync(job.output.path, text);
      emitNs = Number(ns() - t2);
    }

    runs.push({
      index: i,
      state: i === 0 ? 'cold' : 'warm',
      phases_ns: { load: Number(t1 - t0), work: Number(t2 - t1), emit: emitNs },
      // Named for what it actually is. maxRSS is a PROCESS-LIFETIME high-water
      // mark, so this value only ever rises across runs and is not the memory
      // used by this run. See the manifest-level peak_rss_bytes below.
      rss_high_water_after_run_bytes: peakRssBytes(),
    });

    lastSorted = sorted;
    lastLoaded = loaded;
  }

  // Invariants run AFTER timing and are never inside a measured phase.
  // A cell that verified itself inside `work` would be reporting the cost of
  // its own checking as the cost of its algorithm.
  const inv = {};
  const i1 = checkI1(lastSorted); inv.I1 = i1.pass ? 'pass' : 'fail';
  const i3 = checkI3(lastSorted, lastSorted.dataset); inv.I3 = i3.pass ? 'pass' : 'fail';
  const i2 = checkI2(digest(lastLoaded), digest(lastSorted)); inv.I2 = i2.pass ? 'pass' : 'fail';
  for (const r of [i1, i2, i3]) for (const p of r.problems ?? []) notes.push(`${r.id}: ${p.why}`);
  if (i3.inversions) notes.push(`I3: ${i3.inversions} inversions`);

  // Derived summary. Reported explicitly so consumers do not have to decide
  // how to reduce the runs array, and do not quietly choose a mean.
  //
  // Warm figures use the MINIMUM rather than the mean. A warm run can be
  // interrupted by GC -- observed at the tiny tier as a 103ms work phase
  // among 50ms neighbours -- and a mean silently folds that interruption into
  // the algorithm's cost. The minimum is the closest available estimate of
  // the work itself.
  const workNs = runs.map((r) => r.phases_ns.work);
  const loadNs = runs.map((r) => r.phases_ns.load);
  const warm = workNs.slice(1);

  return {
    contract: 1,
    job_id: job.job_id,
    impl: {
      runtime: 'node',
      runtime_version: process.versions.node,
      name: impl.name,
      algorithm: job.algorithm,
      threads: impl.threads ?? 1,
      parallel_strategy: impl.parallelStrategy ?? null,
      load_mode: job.load_mode ?? 'aos',
    },
    platform: {
      os: process.platform,
      arch: process.arch,
      cpu: os.cpus()[0]?.model ?? null,
      cores_logical: os.cpus().length,
      ram_bytes: os.totalmem(),
    },
    tier: job.tier,
    dataset: input.dataset,
    records_in: lastLoaded.n,
    records_out: lastSorted.n,
    startup_ns: Math.round(STARTUP_MS * 1e6),

    // Process-lifetime high-water mark, which is the only thing maxRSS can
    // report. With repeat > 1 it accumulates across generations that GC had
    // not yet reclaimed, so it overstates a single run's cost and is not
    // comparable between cells run at different repeat counts.
    //
    // MEMORY IS ONLY MEASURED AT repeat = 1. Anything else is a number that
    // looks authoritative and means something other than what a reader will
    // assume -- the exact failure mode rss-probe exists to prevent, recurring
    // one level up.
    peak_rss_bytes: peakRssBytes(),
    memory_measurement_valid: repeat === 1,

    summary_ns: {
      work_cold: workNs[0],
      work_warm_min: warm.length ? Math.min(...warm) : null,
      work_warm_spread: warm.length ? Math.max(...warm) - Math.min(...warm) : null,
      load_min: Math.min(...loadNs),
      reduction: 'warm figures are minima, not means -- see runner.js',
    },
    runs,
    invariants: inv,
    notes,
  };
}

/** Shared CLI wrapper: read a job spec, run, write the manifest, exit on invariant failure. */
export function main(impl) {
  const argv = process.argv.slice(2);
  const opt = (f, d) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };

  let job;
  const jobPath = opt('--job', null);
  if (jobPath) {
    job = JSON.parse(readFileSync(jobPath, 'utf8'));
  } else {
    const input = opt('--input', null);
    if (!input) { console.error('usage: --job <spec.json>  |  --input <file.tsv> [--output <file.tsv>] [--repeat 3] [--tier tiny] [--load-mode aos|soa]'); process.exit(2); }
    const dataset = opt('--dataset', null);
    const output = opt('--output', null);
    job = {
      contract: 1,
      job_id: opt('--job-id', `sort-${dataset ?? 'auto'}-${opt('--tier', 'tiny')}-${impl.name}`),
      op: 'sort',
      tier: opt('--tier', 'tiny'),
      inputs: [{ dataset, path: input }],
      algorithm: impl.name,
      threads: impl.threads ?? 1,
      load_mode: opt('--load-mode', 'aos'),
      output: output ? { path: output, emit: true } : { path: null, emit: false },
      repeat: Number(opt('--repeat', '3')),
    };
  }

  const manifest = runCell(job, impl);
  const out = opt('--manifest', null);
  if (out) { mkdirSync(dirname(out), { recursive: true }); writeFileSync(out, JSON.stringify(manifest, null, 2) + '\n'); }

  console.log(JSON.stringify(manifest, null, 2));
  const failed = Object.entries(manifest.invariants).filter(([, v]) => v !== 'pass');
  if (failed.length) { console.error(`\nINVARIANT FAILURE: ${failed.map(([k]) => k).join(', ')}`); process.exit(1); }
  const s2 = manifest.summary_ns;
  const mem = manifest.memory_measurement_valid
    ? `${(manifest.peak_rss_bytes / 1048576).toFixed(0)}MB`
    : `${(manifest.peak_rss_bytes / 1048576).toFixed(0)}MB (INVALID: repeat>1)`;
  console.error(`\nPASS  load=${(s2.load_min / 1e6).toFixed(1)}ms  work cold=${(s2.work_cold / 1e6).toFixed(1)}ms warm=${s2.work_warm_min === null ? 'n/a' : (s2.work_warm_min / 1e6).toFixed(1) + 'ms'}  peak=${mem}`);
}
