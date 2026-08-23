// Contender cell: parallel sort via node:worker_threads + SharedArrayBuffer.
//
//   node packages/js-sorts/cells/workers.js --input data/tiny/A.tsv --dataset A
//
// THE CONSTRAINT THAT SHAPES THIS ENTIRE CELL
//
// A SharedArrayBuffer holds bytes. Every record here holds strings -- the
// datastring `d`, and one of the two key columns on A and C. JS strings live
// on a per-isolate heap and cannot be placed in shared memory, and a worker
// is a separate isolate. So "sort the records in parallel" is not available:
// the records cannot cross into a worker at all except by structured-clone,
// which would copy every string and cost more than the sort saves.
//
// What CAN be shared is numbers. So the split is:
//
//   shared    Float64Array of the numeric PRIMARY key, one per record, plus
//             an Int32Array index permutation. Both over one SAB.
//   worker    sorts a disjoint index range in place, by primary key only.
//             It never sees a string and never needs to.
//   main      resolves tie-breaks (which need the strings) inside each run,
//             then merges the runs with the full declared comparator, then
//             gathers the records.
//
// That is sound because the declared orders (DATASET-SPEC §6) lead with a
// numeric column on all three datasets: A and B on L1, C on L2. A worker run
// sorted by primary key has all equal-key records contiguous, so the tie
// groups it leaves behind are exactly the ranges the main thread must fix --
// and after that fix each run is in full declared order and a comparator
// merge is correct.
//
// A useful asymmetry falls out of the datasets: A.L1 and B.L1 are unique
// within their dataset, so on A and B the tie-fix pass finds nothing to do
// and the parallel part is the whole sort. C.L2 is unique only within its
// L1 parent, so C has heavy ties and a large fraction of C's ordering work
// is forced back onto the single main thread. C is the case where this
// design is expected to lose hardest, and that is the finding.
//
// SYNCHRONOUS BY CONSTRUCTION. runner.js calls `algorithm(loaded)` and uses
// its return value; there is no await anywhere in the phase timing, and
// adding one would move worker time outside the `work` phase where it would
// stop being measured. So the handshake is Atomics.wait/notify on a shared
// control array, not postMessage: the main thread blocks in Atomics.wait
// while the workers run, and the whole parallel section is an ordinary
// synchronous call from the runner's point of view.
//
// threads: 1 is honoured literally -- no worker is spawned, no SAB traffic
// is paid for, and the same key-sort / tie-fix / gather path runs on the
// main thread alone. BOUNDARY.md §2 requires that of every algorithm, and a
// cell that quietly spawned four threads anyway would make the single-
// threaded column of the matrix a lie.
//
// NOTE: the comparators below are written here, deliberately, and NOT
// imported from the oracle. A cell that sorted using the same comparator the
// oracle checks with would make I3 vacuous -- it would only ever be testing
// that a function agrees with itself. Independent implementations of the
// declared order (DATASET-SPEC §6) are what give the check its value.

import { Worker } from 'node:worker_threads';
import { readFileSync } from 'node:fs';
import { main } from '../lib/runner.js';

const cmpNum = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const cmpStr = (a, b) => (a < b ? -1 : a > b ? 1 : 0); // byte-wise; never localeCompare

// --- how many threads the job actually asked for --------------------------
//
// runner.js hands `algorithm(loaded)` the loaded data and nothing else, so a
// cell cannot see job.threads through the runner's own API. Rather than
// modify the runner -- which is shared and explicitly off limits -- the spec
// is re-read here from argv. This is a read of the same file the runner
// reads, not a second source of truth.
//
// Any failure is swallowed: the runner is about to parse the same file and
// produce the correct exit 2 / exit 3 for it, and throwing at module scope
// would pre-empt that with an unstructured crash.
const DECLARED_THREADS = 4;

function requestedThreads() {
  const argv = process.argv.slice(2);
  const opt = (f) => { const i = argv.indexOf(f); return i >= 0 && argv[i + 1] ? argv[i + 1] : null; };
  try {
    const t = opt('--threads');
    if (t !== null && Number.isInteger(Number(t)) && Number(t) >= 1) return Number(t);
    const jp = opt('--job');
    if (jp) {
      const spec = JSON.parse(readFileSync(jp, 'utf8'));
      if (Number.isInteger(spec?.threads) && spec.threads >= 1) return spec.threads;
    }
  } catch { /* runner will diagnose the spec properly */ }
  return DECLARED_THREADS;
}

// Reported in the manifest as impl.threads. Starts at the declared 4 so the
// runner's CLI path builds a job spec with the cell's own default, and is
// narrowed to what the run actually used before the manifest is assembled.
let effectiveThreads = DECLARED_THREADS;

// --- comparators over an index, one per representation --------------------
//
// The worker half of the sort only ever needs the primary key, so the
// primary is split out from the tie-breaks. `keyOf` is the column the
// workers sort on; `cmp` is the full declared total order and runs only
// where the strings are, on the main thread.

function accessors(loaded) {
  if (loaded.mode === 'soa') {
    return { l1: (i) => loaded.l1[i], l2: (i) => loaded.l2[i], l3: (i) => loaded.l3ord[i] };
  }
  const r = loaded.rows;
  return { l1: (i) => r[i].l1, l2: (i) => r[i].l2, l3: (i) => r[i].l3ord };
}

function plan(loaded) {
  const a = accessors(loaded);
  switch (loaded.dataset) {
    case 'A': return {
      keyOf: a.l1,
      cmp: (x, y) => cmpNum(a.l1(x), a.l1(y)) || cmpStr(a.l2(x), a.l2(y)) || cmpNum(a.l3(x), a.l3(y)),
    };
    case 'B': return {
      keyOf: a.l1,
      cmp: (x, y) => cmpNum(a.l1(x), a.l1(y)) || cmpNum(a.l2(x), a.l2(y)) || cmpNum(a.l3(x), a.l3(y)),
    };
    case 'C': return {
      keyOf: a.l2,
      cmp: (x, y) => cmpNum(a.l2(x), a.l2(y)) || cmpStr(a.l1(x), a.l1(y)) || cmpNum(a.l3(x), a.l3(y)),
    };
    default: throw new Error(`no comparator for dataset '${loaded.dataset}'`);
  }
}

// --- the worker pool ------------------------------------------------------
//
// Control layout, one Int32Array over its own SAB:
//   [0]              workers that have reached their wait loop
//   [1]              shutdown flag
//   [4 + w*4 + 0]    CMD  -- main bumps it to a new token to hand out work
//   [4 + w*4 + 1]    DONE -- worker stores the token back when finished
//   [4 + w*4 + 2..3] LO, HI of the index range to sort
//
// Every wait carries a timeout. A pool that deadlocked would hang a fan-out
// with no diagnostic; a pool that throws becomes exit 3 with stage "work",
// which BOUNDARY.md §4 says is the honest report for "never got far enough
// to have an opinion".
const WAIT_MS = 60000;
const CTRL_BASE = 4;

const WORKER_SRC = `
const { workerData } = require('node:worker_threads');
const C = new Int32Array(workerData.ctrl);
const K = new Float64Array(workerData.keys);
const I = new Int32Array(workerData.idx);
const b = ${CTRL_BASE} + workerData.id * 4;
const CMD = b, DONE = b + 1, LO = b + 2, HI = b + 3;
const cmp = (x, y) => (K[x] < K[y] ? -1 : K[x] > K[y] ? 1 : 0);
let seen = 0;
Atomics.add(C, 0, 1);
Atomics.notify(C, 0);
for (;;) {
  let cur = Atomics.load(C, CMD);
  while (cur === seen && Atomics.load(C, 1) === 0) {
    Atomics.wait(C, CMD, seen, ${WAIT_MS});
    cur = Atomics.load(C, CMD);
  }
  if (Atomics.load(C, 1) !== 0) break;
  seen = cur;
  const lo = Atomics.load(C, LO), hi = Atomics.load(C, HI);
  if (hi - lo > 1) I.subarray(lo, hi).sort(cmp);
  Atomics.store(C, DONE, cur);
  Atomics.notify(C, DONE);
}
`;

let pool = null; // { workers, ctrl, keys, idx, n, nWorkers, token }

function waitFor(ctrl, slot, want) {
  const deadline = Date.now() + WAIT_MS;
  let cur = Atomics.load(ctrl, slot);
  while (cur !== want) {
    if (Date.now() > deadline) throw new Error(`worker pool timed out waiting on slot ${slot} (have ${cur}, want ${want})`);
    Atomics.wait(ctrl, slot, cur, 1000);
    cur = Atomics.load(ctrl, slot);
  }
}

function waitAtLeast(ctrl, slot, want) {
  const deadline = Date.now() + WAIT_MS;
  let cur = Atomics.load(ctrl, slot);
  while (cur < want) {
    if (Date.now() > deadline) throw new Error(`worker pool timed out becoming ready (have ${cur}, want ${want})`);
    Atomics.wait(ctrl, slot, cur, 1000);
    cur = Atomics.load(ctrl, slot);
  }
}

/**
 * Spawn or reuse the pool. `repeat > 1` runs the same n every iteration, so
 * the pool and its shared buffers are built once on the cold run and reused
 * warm -- which is the whole point of reporting cold and warm separately
 * (MEASUREMENT-CONTRACT §4). Thread creation is real and is charged to the
 * cold `work` phase where it happens.
 */
function acquirePool(n, nWorkers) {
  if (pool && pool.n === n && pool.nWorkers === nWorkers) return pool;
  if (pool) shutdownPool();

  const ctrlSab = new SharedArrayBuffer(4 * (CTRL_BASE + nWorkers * 4));
  const keysSab = new SharedArrayBuffer(8 * n);
  const idxSab = new SharedArrayBuffer(4 * n);
  const ctrl = new Int32Array(ctrlSab);
  const keys = new Float64Array(keysSab);
  const idx = new Int32Array(idxSab);

  const workers = [];
  for (let w = 0; w < nWorkers; w++) {
    const worker = new Worker(WORKER_SRC, {
      eval: true,
      workerData: { ctrl: ctrlSab, keys: keysSab, idx: idxSab, id: w },
    });
    // The pool must not hold the process open. runner.js ends by falling off
    // the end of main(); an ref'd worker parked in Atomics.wait would keep
    // the event loop alive forever and the cell would hang after printing a
    // perfectly good manifest.
    worker.unref();
    worker.on('error', (e) => { process.stderr.write(JSON.stringify({ contract: 1, kind: 'error', job_id: null, stage: 'work', code: 'EWORKER', message: e.message, retryable: false }) + '\n'); process.exit(3); });
    workers.push(worker);
  }
  waitAtLeast(ctrl, 0, nWorkers);

  pool = { workers, ctrl, keys, idx, n, nWorkers, token: 0 };
  return pool;
}

function shutdownPool() {
  if (!pool) return;
  Atomics.store(pool.ctrl, 1, 1);
  for (let w = 0; w < pool.nWorkers; w++) Atomics.notify(pool.ctrl, CTRL_BASE + w * 4);
  for (const w of pool.workers) w.terminate().catch(() => {});
  pool = null;
}

// --- the pieces the main thread owns --------------------------------------

/**
 * Within one primary-key-sorted run, records with an equal primary key are
 * contiguous and in arbitrary relative order. Resolve each such group with
 * the full declared comparator. This is the step that cannot be given to a
 * worker: the tie-breaks are `A.L2` / `C.L1`, which are strings.
 */
function fixTies(idx, lo, hi, key, cmp) {
  let i = lo;
  while (i < hi) {
    const k = key[idx[i]];
    let j = i + 1;
    while (j < hi && key[idx[j]] === k) j++;
    if (j - i > 1) {
      const group = new Array(j - i);
      for (let t = i; t < j; t++) group[t - i] = idx[t];
      group.sort(cmp);
      for (let t = i; t < j; t++) idx[t] = group[t - i];
    }
    i = j;
  }
}

function mergeInto(src, dst, lo, mid, hi, cmp) {
  let i = lo, j = mid, k = lo;
  // `cmp(src[j], src[i]) < 0` so an equal pair takes from the LEFT run. The
  // declared orders are total, so nothing here depends on stability -- but a
  // merge that quietly lost it would be a trap for the next reader.
  while (i < mid && j < hi) dst[k++] = cmp(src[j], src[i]) < 0 ? src[j++] : src[i++];
  while (i < mid) dst[k++] = src[i++];
  while (j < hi) dst[k++] = src[j++];
}

/** Pairwise-merge k contiguous sorted runs described by boundary array `b`. */
function mergeRuns(src, dst, b, cmp) {
  while (b.length - 1 > 1) {
    const nb = [b[0]];
    const k = b.length - 1;
    let i = 0;
    while (i < k) {
      if (i + 1 < k) { mergeInto(src, dst, b[i], b[i + 1], b[i + 2], cmp); nb.push(b[i + 2]); i += 2; }
      else { for (let t = b[i]; t < b[i + 1]; t++) dst[t] = src[t]; nb.push(b[i + 1]); i += 1; }
    }
    const swap = src; src = dst; dst = swap;
    b = nb;
  }
  return src;
}

/**
 * Produce the sorted index permutation.
 *
 * threads === 1: no worker, no SAB, plain arrays. Sorting the whole index by
 * primary key and then fixing ties is exactly what a single worker range
 * would have done, so the single- and multi-threaded paths compute the same
 * thing by the same steps and the columns of the matrix stay comparable.
 */
function sortedIndex(loaded, threads) {
  const n = loaded.n;
  const { keyOf, cmp } = plan(loaded);

  if (threads <= 1 || n < 2) {
    const key = new Float64Array(n);
    const idx = new Int32Array(n);
    for (let i = 0; i < n; i++) { key[i] = keyOf(i); idx[i] = i; }
    idx.sort((a, b) => (key[a] < key[b] ? -1 : key[a] > key[b] ? 1 : 0));
    fixTies(idx, 0, n, key, cmp);
    return idx;
  }

  const nWorkers = threads - 1; // the main thread takes one range itself
  const p = acquirePool(n, nWorkers);
  const { ctrl, keys, idx } = p;
  for (let i = 0; i < n; i++) { keys[i] = keyOf(i); idx[i] = i; }

  // Contiguous, near-equal ranges. Equal-size splits are right here because
  // the per-element cost of a numeric sort does not vary with the data.
  const b = [0];
  for (let w = 1; w <= threads; w++) b.push(Math.floor((n * w) / threads));

  const token = ++p.token;
  for (let w = 0; w < nWorkers; w++) {
    const base = CTRL_BASE + w * 4;
    Atomics.store(ctrl, base + 2, b[w + 1]);
    Atomics.store(ctrl, base + 3, b[w + 2]);
    Atomics.store(ctrl, base, token);
    Atomics.notify(ctrl, base);
  }

  // Range 0 on this thread, concurrently with the workers.
  if (b[1] - b[0] > 1) idx.subarray(b[0], b[1]).sort((x, y) => (keys[x] < keys[y] ? -1 : keys[x] > keys[y] ? 1 : 0));

  for (let w = 0; w < nWorkers; w++) waitFor(ctrl, CTRL_BASE + w * 4 + 1, token);

  // Everything below needs the strings, so it is all main-thread work.
  for (let w = 0; w < threads; w++) fixTies(idx, b[w], b[w + 1], keys, cmp);
  return mergeRuns(idx, new Int32Array(n), b, cmp);
}

/**
 * soa cannot sort "the records" -- there are no records, only parallel
 * columns. So it sorts an index permutation and then gathers.
 *
 * That gather is genuine work and stays inside the `work` phase: producing a
 * sorted arrangement is the job, and charging aos for its permutation while
 * excusing soa from its gather would be measuring two different tasks.
 */
function gatherColumns(loaded, idx) {
  const n = loaded.n;
  const gatherAny = (src) => { const out = new Array(n); for (let i = 0; i < n; i++) out[i] = src[idx[i]]; return out; };
  const gatherNum = (src) => { const out = new Float64Array(n); for (let i = 0; i < n; i++) out[i] = src[idx[i]]; return out; };
  const isTyped = (x) => ArrayBuffer.isView(x);

  const l3 = new Int32Array(n);
  for (let i = 0; i < n; i++) l3[i] = loaded.l3ord[idx[i]];

  return {
    ...loaded,
    l1: isTyped(loaded.l1) ? gatherNum(loaded.l1) : gatherAny(loaded.l1),
    l2: isTyped(loaded.l2) ? gatherNum(loaded.l2) : gatherAny(loaded.l2),
    l3ord: l3,
    d: gatherAny(loaded.d),
  };
}

main({
  name: 'workers',
  algorithms: ['workers'],

  // Declared 4. Reported as what the run actually used, because a manifest
  // that said "4" for a job spec that asked for 1 -- which BOUNDARY.md §2
  // requires every algorithm to honour -- would be reporting a property this
  // cell does not have. runner.js reads impl.threads once, after the last
  // run, so a getter is the only channel a cell has for telling the truth
  // here without touching the shared runner.
  get threads() { return effectiveThreads; },
  parallelStrategy: 'worker_threads + SharedArrayBuffer',

  algorithm(loaded) {
    const asked = requestedThreads();
    // The requested thread count is honoured as requested, and NOT clamped to
    // os.cpus().length. Clamping was the first thing written here and it was
    // wrong: on a 2-core box it silently turned a threads:4 job into a
    // threads:2 run, so impl.threads varied with the machine and two rows of
    // the matrix labelled "4" would have meant different things. If a pool
    // oversubscribes the CPU, that is a finding about oversubscription and
    // belongs in the timings, not hidden in a clamp the manifest cannot
    // explain -- the cell has no channel into `notes`.
    //
    // The one clamp that remains is against the data: splitting fewer than
    // two records per range is not parallelism, it is overhead.
    const usable = Math.max(1, Math.min(asked, Math.max(1, loaded.n >> 1)));
    effectiveThreads = usable;

    const idx = sortedIndex(loaded, usable);

    if (loaded.mode === 'soa') return gatherColumns(loaded, idx);

    const src = loaded.rows;
    const rows = new Array(loaded.n);
    for (let i = 0; i < loaded.n; i++) rows[i] = src[idx[i]];
    return { ...loaded, rows };
  },
});
