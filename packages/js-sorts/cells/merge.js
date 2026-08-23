// Contender cell: bottom-up iterative merge sort.
//
//   node packages/js-sorts/cells/merge.js --input data/tiny/A.tsv --dataset A
//
// BOTTOM-UP, and deliberately not recursive. A top-down merge sort recurses to
// depth log2(n), which at the large tier is ~25 frames and perfectly safe --
// but the recursion is not what makes it interesting, and V8's stack is a
// shared, fixed and comparatively small resource that this project has no
// reason to spend. The iterative form has the same O(n log n) comparisons, the
// same stability, no frame overhead per subarray, and a stack depth of one.
//
// It merges width-1 runs into width-2 runs, those into width-4, and so on,
// ping-ponging between two buffers so no pass allocates. The final result may
// end up in either buffer depending on the parity of the pass count, which is
// why the sort returns the buffer rather than writing back into the input.
//
// This is competing against Array.prototype.sort, which V8 implements as
// TimSort in C++ with a JS callback per comparison. A hand-written JS merge
// pays interpreter/JIT cost for the merge loop itself as well as the
// comparator, so losing to the control here is the expected result and is
// itself the finding -- see MEASUREMENT-CONTRACT §8.
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

/**
 * Bottom-up merge of an array of records.
 *
 * `src` is consumed and may be returned; `dst` is scratch of the same length.
 * The comparison is `cmp(right, left) < 0` so that an equal pair takes from
 * the LEFT run, which is what keeps the merge stable. The declared orders are
 * total -- (l1, l2, l3ord) is unique -- so stability is not load-bearing for
 * correctness here, but a merge sort that quietly lost it would be a trap for
 * the next algorithm that reuses this file.
 */
function mergeSortArray(src, dst, cmp) {
  const n = src.length;
  for (let width = 1; width < n; width <<= 1) {
    const step = width << 1;
    for (let lo = 0; lo < n; lo += step) {
      const mid = lo + width < n ? lo + width : n;
      const hi = lo + step < n ? lo + step : n;
      // A run that is already wholly to the left of the file end has nothing
      // to merge with; copy it through so the ping-pong stays consistent.
      if (mid >= hi) { for (let k = lo; k < hi; k++) dst[k] = src[k]; continue; }
      let i = lo, j = mid, k = lo;
      while (i < mid && j < hi) dst[k++] = cmp(src[j], src[i]) < 0 ? src[j++] : src[i++];
      while (i < mid) dst[k++] = src[i++];
      while (j < hi) dst[k++] = src[j++];
    }
    const swap = src; src = dst; dst = swap;
  }
  return src;
}

/** The same passes over an index permutation, so soa never moves a record. */
function mergeSortIndex(src, dst, less) {
  const n = src.length;
  for (let width = 1; width < n; width <<= 1) {
    const step = width << 1;
    for (let lo = 0; lo < n; lo += step) {
      const mid = lo + width < n ? lo + width : n;
      const hi = lo + step < n ? lo + step : n;
      if (mid >= hi) { for (let k = lo; k < hi; k++) dst[k] = src[k]; continue; }
      let i = lo, j = mid, k = lo;
      while (i < mid && j < hi) dst[k++] = less(src[j], src[i]) ? src[j++] : src[i++];
      while (i < mid) dst[k++] = src[i++];
      while (j < hi) dst[k++] = src[j++];
    }
    const swap = src; src = dst; dst = swap;
  }
  return src;
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
  const idx = mergeSortIndex(a, new Int32Array(n), (x, y) => cmp(loaded, x, y) < 0);

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
  name: 'merge',
  algorithms: ['merge'],
  threads: 1,
  algorithm(loaded) {
    if (loaded.mode === 'soa') return sortColumns(loaded);
    const cmp = ROW_COMPARATORS[loaded.dataset];
    if (!cmp) throw new Error(`no comparator for dataset '${loaded.dataset}'`);
    // slice() so the input array is untouched and I2 compares against a
    // genuinely independent copy rather than against the sorted result.
    const rows = mergeSortArray(loaded.rows.slice(), new Array(loaded.n), cmp);
    return { ...loaded, rows };
  },
});
