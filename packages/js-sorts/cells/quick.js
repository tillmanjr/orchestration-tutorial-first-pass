// Contender cell: iterative quicksort.
//
//   node packages/js-sorts/cells/quick.js --input data/tiny/A.tsv --dataset A
//
// ITERATIVE, and deliberately not recursive. The textbook quicksort recurses
// on both partitions, and its stack depth is O(n) in the worst case rather
// than O(log n) -- a sorted or adversarial input blows V8's stack rather than
// merely running slowly. Three properties here, together, remove that risk:
//
//   1. An EXPLICIT stack of (lo, hi) ranges. No call frames, so depth costs
//      two array slots rather than a V8 frame, and the ceiling is heap rather
//      than the fixed --stack-size.
//   2. ALWAYS PUSH THE LARGER PARTITION, loop on the smaller. Every pushed
//      range is at most half the range that produced it, so the stack holds
//      at most log2(n) entries -- 25 at the large tier, on ANY input. This is
//      the part that makes the worst case bounded rather than merely
//      unlikely; the loop-on-smaller half is a tail call taken by hand.
//   3. MEDIAN-OF-THREE pivot selection, which also plants the two sentinels
//      the partition loop relies on (see partitionRange).
//
// Ranges of 16 or fewer elements are finished with insertion sort instead of
// being partitioned further. Below that size the partition bookkeeping costs
// more than the O(k^2) it saves, and insertion sort on a nearly-sorted short
// run is close to linear.
//
// Against Array.prototype.sort (V8's TimSort, in C++) this pays interpreter
// cost for the partition loop as well as for the comparator, so losing to the
// control is the expected result and is itself the finding -- see
// MEASUREMENT-CONTRACT §8.
//
// NOTE: the comparators below are written here, deliberately, and NOT imported
// from the oracle. A cell that sorted using the same comparator the oracle
// checks with would make I3 vacuous -- it would only ever be testing that a
// function agrees with itself. Independent implementations of the declared
// order (DATASET-SPEC §6) are what give the check its value.

import { main } from '../lib/runner.js';

const cmpNum = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const cmpStr = (a, b) => (a < b ? -1 : a > b ? 1 : 0); // byte-wise; never localeCompare

const ROW_COMPARATORS = {
  A: (x, y) => cmpNum(x.l1, y.l1) || cmpStr(x.l2, y.l2) || cmpNum(x.l3ord, y.l3ord),
  B: (x, y) => cmpNum(x.l1, y.l1) || cmpNum(x.l2, y.l2) || cmpNum(x.l3ord, y.l3ord),
  C: (x, y) => cmpNum(x.l2, y.l2) || cmpStr(x.l1, y.l1) || cmpNum(x.l3ord, y.l3ord),
};

// Column comparators for soa. Same declared order, different access pattern.
const COL_COMPARATORS = {
  A: (L, a, b) => cmpNum(L.l1[a], L.l1[b]) || cmpStr(L.l2[a], L.l2[b]) || cmpNum(L.l3ord[a], L.l3ord[b]),
  B: (L, a, b) => cmpNum(L.l1[a], L.l1[b]) || cmpNum(L.l2[a], L.l2[b]) || cmpNum(L.l3ord[a], L.l3ord[b]),
  C: (L, a, b) => cmpNum(L.l2[a], L.l2[b]) || cmpStr(L.l1[a], L.l1[b]) || cmpNum(L.l3ord[a], L.l3ord[b]),
};

// Ranges at or below this length are finished with insertion sort.
const SMALL = 16;

/** Insertion sort over the inclusive range [lo, hi]. A no-op when lo >= hi. */
function insertionSort(a, lo, hi, cmp) {
  for (let i = lo + 1; i <= hi; i++) {
    const v = a[i];
    let j = i - 1;
    while (j >= lo && cmp(a[j], v) > 0) { a[j + 1] = a[j]; j--; }
    a[j + 1] = v;
  }
}

/**
 * Median-of-three partition of the inclusive range [lo, hi]; returns the
 * final index of the pivot.
 *
 * Only called with hi - lo + 1 > SMALL, so the range holds at least 17
 * elements and lo < mid < hi strictly.
 *
 * The three-element sort leaves a[lo] <= a[mid] <= a[hi]. Parking the median
 * at hi-1 leaves a[lo] as a sentinel no smaller-scan can run past and a[hi]
 * as one no larger-scan can run past, so neither inner loop needs a bounds
 * test. Position hi-1 itself is never touched by the swap loop: j is
 * pre-decremented from hi-1 and i < j at every swap, so both indices stay
 * within [lo+1, hi-2].
 */
function partitionRange(a, lo, hi, cmp) {
  const mid = lo + ((hi - lo) >> 1);
  let t;
  if (cmp(a[mid], a[lo]) < 0) { t = a[mid]; a[mid] = a[lo]; a[lo] = t; }
  if (cmp(a[hi], a[mid]) < 0) {
    t = a[hi]; a[hi] = a[mid]; a[mid] = t;
    if (cmp(a[mid], a[lo]) < 0) { t = a[mid]; a[mid] = a[lo]; a[lo] = t; }
  }
  t = a[mid]; a[mid] = a[hi - 1]; a[hi - 1] = t;
  const pivot = a[hi - 1];

  let i = lo, j = hi - 1;
  for (;;) {
    while (cmp(a[++i], pivot) < 0);
    while (cmp(a[--j], pivot) > 0);
    if (i >= j) break;
    t = a[i]; a[i] = a[j]; a[j] = t;
  }
  t = a[i]; a[i] = a[hi - 1]; a[hi - 1] = t;
  return i;
}

/**
 * Iterative quicksort over the whole of `a`, in place.
 *
 * `a` is either an array of records (aos) or an Int32Array of indices (soa) --
 * the algorithm never inspects an element, only compares two, so one body
 * serves both representations.
 *
 * The explicit stack holds at most log2(n) ranges because only the LARGER
 * half is ever pushed. Pre-sized to 64 pairs, which covers n up to 2^64 and
 * so is never grown in practice; push() would still be correct if it were.
 */
function quickSortInPlace(a, cmp) {
  const n = a.length;
  const stackLo = new Int32Array(64);
  const stackHi = new Int32Array(64);
  let sp = 0;

  let lo = 0;
  let hi = n - 1;
  for (;;) {
    while (hi - lo + 1 > SMALL) {
      const p = partitionRange(a, lo, hi, cmp);
      // Push the larger side, continue on the smaller. Bounds depth to
      // O(log n) even when every pivot is pessimal.
      if (p - lo > hi - p) {
        stackLo[sp] = lo; stackHi[sp] = p - 1; sp++;
        lo = p + 1;
      } else {
        stackLo[sp] = p + 1; stackHi[sp] = hi; sp++;
        hi = p - 1;
      }
    }
    insertionSort(a, lo, hi, cmp);
    if (sp === 0) break;
    sp--;
    lo = stackLo[sp]; hi = stackHi[sp];
  }
  return a;
}

/**
 * soa cannot sort "the records" -- there are no records, only parallel
 * columns. So it sorts an index permutation and then gathers.
 *
 * That gather is genuine work and stays inside the `work` phase: producing a
 * sorted arrangement is the job, and charging aos for its permutation while
 * excusing soa from its gather would be measuring two different tasks.
 */
function sortColumns(loaded) {
  const n = loaded.n;
  const cmp = COL_COMPARATORS[loaded.dataset];
  if (!cmp) throw new Error(`no comparator for dataset '${loaded.dataset}'`);
  const a = new Int32Array(n);
  for (let i = 0; i < n; i++) a[i] = i;
  const idx = quickSortInPlace(a, (x, y) => cmp(loaded, x, y));

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
  name: 'quick',
  algorithms: ['quick'],
  threads: 1,
  algorithm(loaded) {
    if (loaded.mode === 'soa') return sortColumns(loaded);
    const cmp = ROW_COMPARATORS[loaded.dataset];
    if (!cmp) throw new Error(`no comparator for dataset '${loaded.dataset}'`);
    // slice() so the input array is untouched and I2 compares against a
    // genuinely independent copy rather than against the sorted result.
    // BOUNDARY §5: that copy is charged to `work`, not to `load`.
    const rows = quickSortInPlace(loaded.rows.slice(), cmp);
    return { ...loaded, rows };
  },
});
