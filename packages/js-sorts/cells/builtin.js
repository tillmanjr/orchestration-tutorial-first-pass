// Control cell: Array.prototype.sort.
//
//   node packages/js-sorts/cells/builtin.js --input data/tiny/A.tsv --dataset A
//
// This is the control, and it is expected to WIN a good number of the
// single-threaded comparison-sort cells. V8 implements Array.prototype.sort
// as TimSort in C++, so "the JS built-in" is not really a JS sort at all --
// it is a native sort with a JS comparator callback. Any hand-written JS
// merge or quicksort is competing against native code while paying a
// callback per comparison.
//
// That asymmetry is one of the more useful findings the matrix will produce,
// and it is the reason the reference implementation is both the oracle and a
// first-class competitor.
//
// NOTE: the comparators below are written here, deliberately, and NOT
// imported from the oracle. A cell that sorted using the same comparator the
// oracle checks with would make I3 vacuous -- it would only ever be testing
// that a function agrees with itself. Independent implementations of the
// declared order are what give the check its value.

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
  const idx = new Int32Array(n);
  for (let i = 0; i < n; i++) idx[i] = i;
  idx.sort((a, b) => cmp(loaded, a, b));

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
  name: 'builtin',
  algorithms: ['builtin'],
  threads: 1,
  algorithm(loaded) {
    if (loaded.mode === 'soa') return sortColumns(loaded);
    const cmp = ROW_COMPARATORS[loaded.dataset];
    if (!cmp) throw new Error(`no comparator for dataset '${loaded.dataset}'`);
    // slice() so the input array is untouched and I2 compares against a
    // genuinely independent copy rather than against the sorted result.
    const rows = loaded.rows.slice().sort(cmp);
    return { ...loaded, rows };
  },
});
