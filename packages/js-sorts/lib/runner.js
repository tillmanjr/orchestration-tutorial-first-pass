// Cell runner. Every JS cell in the matrix goes through this, so phases,
// cold/warm handling, RSS sampling and manifest shape are identical across
// the row and only the algorithm differs.
//
// The cell times ITSELF, here, inside its own runtime. The harness that
// launches it never wraps it in a stopwatch -- that figure would include
// process spawn and pipe transit, neither of which is a property of a sorting
// algorithm. See MEASUREMENT-CONTRACT §1.

import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';
import os from 'node:os';
import { load } from './load.js';
import { checkI1, checkI2, checkI3, digest } from '../../oracle/invariants.js';

// --- boundary errors ------------------------------------------------------
//
// BOUNDARY.md §4. The distinction that carries the weight:
//
//   exit 1  the cell ran and its output is wrong -- a RESULT, manifest emitted
//   exit 2  the job spec was rejected before any work began
//   exit 3  the cell never got far enough to have an opinion
//
// Collapsing 1 and 3 loses the difference between a broken algorithm and a
// full disk. Before this was enforced, a missing input file exited 1, so a
// nonexistent path would have been recorded as a finding about the algorithm.

class BoundaryError extends Error {
  constructor(exitCode, stage, code, message, retryable = false) {
    super(message);
    Object.assign(this, { exitCode, stage, code, retryable });
  }
}

function failBoundary(job, err) {
  // stderr, never stdout: stdout carries the manifest and nothing else.
  process.stderr.write(JSON.stringify({
    contract: 1,
    kind: 'error',
    job_id: job?.job_id ?? null,
    stage: err.stage,
    code: err.code,
    message: err.message,
    retryable: err.retryable,
  }) + '\n');
  process.exit(err.exitCode);
}

/** Everything checkable before work begins. All failures here are exit 2. */
function validateSpec(job, impl) {
  const bad = (code, msg) => { throw new BoundaryError(2, 'spec', code, msg); };
  if (job?.contract !== 1) bad('ECONTRACT', `unsupported contract version ${job?.contract}; this cell implements 1`);
  if (job.op !== 'sort') bad('ENOTSUP', `op '${job.op}' not supported by this cell`);
  const supported = impl.algorithms ?? [impl.name];
  if (!supported.includes(job.algorithm)) bad('EALGO', `unknown algorithm '${job.algorithm}'; this cell offers ${supported.join(', ')}`);
  if (!Array.isArray(job.inputs) || job.inputs.length !== 1) bad('EINVAL', `op 'sort' takes exactly one input, got ${job.inputs?.length}`);
  for (const i of job.inputs) {
    if (!i?.path) bad('EINVAL', 'input has no path');
    // The cell's working directory is unspecified, so a relative path is a
    // spec error rather than a lookup that might happen to succeed.
    if (!isAbsolute(i.path)) bad('EPATH', `input path must be absolute: '${i.path}'`);
  }
  if (!Number.isInteger(job.threads) || job.threads < 1) bad('EINVAL', `threads must be an integer >= 1, got ${job.threads}`);
  if (job.output?.emit && !job.output.path) bad('EINVAL', 'output.emit is true but output.path is null');
}

// --- benchmark admissibility ---------------------------------------------
//
// MILESTONES.md E8 says the agent's sandbox never runs a benchmark. It was
// written down, it was accurate, and the first fan-out benchmarked there
// anyway -- because device_bash goes there and nothing stopped it. Both
// agents reported warm spreads of 16-200% against the contract's 13% floor
// and concluded the CONTRACT was wrong. It was not. They were on the wrong
// machine.
//
// A precondition that is not enforced is a comment. So: explicit opt-in.
// A host is a benchmark host only if it says so -- an env var or a marker
// file at the repo root. Nothing is auto-detected, because "is this a real
// machine" has no reliable test and a wrong guess here silently certifies
// numbers that mean nothing.
//
// Timings are still recorded when inadmissible: they are useful as a smoke
// test. They are simply not a measurement, and the manifest says so rather
// than leaving a reader to infer it from the platform block.

function benchmarkAdmissibility() {
  if (process.env.ORCH_BENCHMARK_HOST === '1') {
    return { admissible: true, reason: 'ORCH_BENCHMARK_HOST=1' };
  }
  try {
    const marker = new URL('../../../.benchmark-host', import.meta.url);
    readFileSync(marker);
    return { admissible: true, reason: '.benchmark-host marker present at repo root' };
  } catch { /* absent */ }
  return {
    admissible: false,
    reason: 'no benchmark-host opt-in (set ORCH_BENCHMARK_HOST=1 or create .benchmark-host at the repo root). Timings recorded but NOT admissible as measurements -- see MILESTONES.md E8.',
  };
}

const ADMISSIBLE = benchmarkAdmissibility();

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
  validateSpec(job, impl);

  // BOUNDARY.md §2: load_mode is a HINT. A cell that cannot offer the
  // requested mode uses its own and says so, rather than failing a whole
  // matrix row. Previously the runner passed the value straight to load(),
  // which threw and became exit 3 -- so the graceful-degradation clause was
  // unimplementable from inside a cell. Reported by the first cell author.
  const OFFERED = ['aos', 'soa'];
  const requested = job.load_mode ?? 'aos';
  const actualLoadMode = OFFERED.includes(requested) ? requested : 'aos';

  const input = job.inputs[0];
  const repeat = job.repeat ?? 1;
  const runs = [];
  const notes = [];
  if (actualLoadMode !== requested) {
    notes.push(`load_mode: requested '${requested}' not offered; used '${actualLoadMode}'`);
  }

  let lastSorted = null, lastLoaded = null;

  for (let i = 0; i < repeat; i++) {
    // Each phase maps its failures to exit 3 with the stage named, because a
    // fan-out summary of "twenty cells failed at load" is one problem while
    // "twenty failed at work" is twenty.
    const t0 = ns();
    let loaded;
    try {
      loaded = load(input.path, { mode: actualLoadMode, dataset: input.dataset });
    } catch (e) {
      throw new BoundaryError(3, 'load', e.code ?? 'EIO', e.message, e.code === 'ENOENT' ? false : true);
    }
    const t1 = ns();

    let sorted;
    try {
      sorted = impl.algorithm(loaded);
    } catch (e) {
      throw new BoundaryError(3, 'work', e.code ?? 'EWORK', e.message);
    }
    const t2 = ns();

    let emitNs = 0;
    if (job.output?.emit) {
      try {
        const text = serialise(sorted);
        mkdirSync(dirname(job.output.path), { recursive: true });
        writeFileSync(job.output.path, text);
      } catch (e) {
        throw new BoundaryError(3, 'emit', e.code ?? 'EIO', e.message, true);
      }
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

  // Peak RSS is captured HERE -- after the last run's phases, before the
  // invariant checks -- because everything below allocates. digest() runs
  // twice over the full record set and checkI1/checkI3 walk it again.
  //
  // Measured on win32-x64 at the tiny tier, sampling after the checks instead
  // reported 170 MB against 119 MB sampled here: 52 MB of ORACLE cost folded
  // into a figure labelled as the cell's memory use. It would have varied
  // with the checker rather than with the cell.
  const peakAfterWork = peakRssBytes();

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
      load_mode: actualLoadMode,
      load_mode_requested: requested,
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
    peak_rss_bytes: peakAfterWork,
    memory_measurement_valid: repeat === 1,
    peak_rss_includes: 'load, work and emit only; sampled before invariant checks',

    // Every timing and memory figure below is inadmissible as a measurement
    // unless this is true. Correctness results are unaffected.
    benchmark_admissible: ADMISSIBLE.admissible,
    admissibility_reason: ADMISSIBLE.reason,

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

  let manifest;
  try {
    manifest = runCell(job, impl);
  } catch (e) {
    if (e instanceof BoundaryError) failBoundary(job, e);
    failBoundary(job, new BoundaryError(3, 'startup', 'EUNKNOWN', e.message));
  }
  const out = opt('--manifest', null);
  if (out) { mkdirSync(dirname(out), { recursive: true }); writeFileSync(out, JSON.stringify(manifest, null, 2) + '\n'); }

  console.log(JSON.stringify(manifest, null, 2));
  const failed = Object.entries(manifest.invariants).filter(([, v]) => v !== 'pass');
  if (failed.length) { console.error(`\nINVARIANT FAILURE: ${failed.map(([k]) => k).join(', ')}`); process.exit(1); }
  if (!manifest.benchmark_admissible) {
    process.stderr.write(`\nNOT A BENCHMARK HOST -- timings below are a smoke test, not a measurement.\n  ${manifest.admissibility_reason}\n`);
  }
  const s2 = manifest.summary_ns;
  const mem = manifest.memory_measurement_valid
    ? `${(manifest.peak_rss_bytes / 1048576).toFixed(0)}MB`
    : `${(manifest.peak_rss_bytes / 1048576).toFixed(0)}MB (INVALID: repeat>1)`;
  console.error(`\nPASS  load=${(s2.load_min / 1e6).toFixed(1)}ms  work cold=${(s2.work_cold / 1e6).toFixed(1)}ms warm=${s2.work_warm_min === null ? 'n/a' : (s2.work_warm_min / 1e6).toFixed(1) + 'ms'}  peak=${mem}`);
}
