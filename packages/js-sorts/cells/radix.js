// Contender cell: LSD radix on the primary numeric key, comparison sort inside
// each equal-primary-key group.
//
//   node packages/js-sorts/cells/radix.js --input data/tiny/A.tsv --dataset A
//
// THIS IS A HYBRID, DELIBERATELY, AND IT HAS TO BE.
//
// A pure radix sort orders by a sequence of small integer digits. The declared
// orders (DATASET-SPEC §6) are not expressible that way:
//
//   A   L1 numeric asc, then L2 BYTE-WISE STRING asc, then l3ord
//   B   L1 numeric asc, then L2 numeric asc,          then l3ord
//   C   L2 numeric asc, then L1 BYTE-WISE STRING asc, then l3ord
//
// A and C tie-break on a variable-length UTF-8 string. Radix-ing a string key
// means padding to the longest key and running one pass per byte -- for C's
// 11-character L1 that is 11 extra passes over the whole array to resolve ties
// that only occur inside groups, and it would still need a rule for the
// unequal-length case. B's tie-break IS numeric and could be radixed, but then
// the cell would be three different algorithms wearing one name and the row in
// the matrix would mean nothing.
//
// So: radix where radix is strong (one wide numeric key, n records, no
// comparisons), comparison where comparison is necessary (arbitrary tie-break
// predicates over groups that are small). The interesting number this cell
// produces is what that split costs relative to a single comparison sort over
// the same data -- see MEASUREMENT-CONTRACT §8.
//
// DIGIT EXTRACTION, AND WHY IT IS EXACT.
//
// The primary keys are large: measured on tiny they run from 1_099_511_627_776
// (2^40) to about 1.4e12, held as float64 by the loader. They are NOT small
// ints -- they do not fit in an int32 -- so the extraction has to be chosen
// rather than assumed. What is used here is
//
//     digit = Math.floor(v / 2**(11*p)) % 2048
//
// and the divisor being a POWER OF TWO is the load-bearing part. Dividing a
// float64 by a power of two is exact: it only decrements the exponent, no
// mantissa rounding, no underflow at these magnitudes. So Math.floor sees the
// true quotient and cannot land on the wrong side of an integer boundary.
// A non-power-of-two radix (base 1000, base 10000) rounds, and the damage
// surfaces in the MOST significant digit, which reorders whole blocks while
// every group inside them still looks correctly sorted.
//
// Two claims about JS bitwise operators are worth stating precisely, because
// the obvious version of each is wrong and I checked rather than reasoned:
//
//   `(v / 2**(11*p)) & 2047` is in fact EXACT for the non-negative keys here,
//   despite the int32 coercion. ToInt32 truncates toward zero (= floor, for a
//   positive quotient) and then reduces mod 2^32; masking to 11 bits after
//   that is unaffected, because 2048 divides 2^32. It is not a defect and
//   this file does not claim it is. It is avoided only because its
//   correctness depends on that two-step argument, and on the keys never
//   being negative, whereas the arithmetic form is exact on its face.
//
//   `v >>> (11*p)` IS a defect, and a quiet one: ToUint32 truncates the key to
//   its low 32 bits before shifting, and the shift count is itself masked to
//   5 bits, so `>>> 33` silently means `>>> 1`.
//
// All three variants were run against the reference output before this comment
// was written. Dropping the top pass, using a base-2000 divisor, and the
// `>>>` form each produce a file that differs from the reference and fail I3;
// the `& 2047` form is byte-identical. The check is not vacuous, and the
// paragraph above is a measurement, not an argument.
//
// 11-bit digits over a 41-bit key range means 4 passes. The pass count is
// derived from the observed maximum key rather than hardcoded, so a wider tier
// gets more passes rather than a truncated key. `checkKeys` proves the
// precondition (non-negative, integral, <= 2^53-1) instead of assuming it; if
// the data violates it -- a corrupted numeric column parsing to NaN, say --
// the cell falls back to a straight comparison sort rather than crashing or
// emitting a silently truncated order. BOUNDARY §4: a wrong answer that is
// reported is a result; a crash destroys the finding.
//
// NOTE: the comparators below are written here, deliberately, and NOT imported
// from the oracle. A cell that sorted using the same comparator the oracle
// checks with would make I3 vacuous -- it would only ever be testing that a
// function agrees with itself.

import { main } from '../lib/runner.js';

const cmpNum = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const cmpStr = (a, b) => (a < b ? -1 : a > b ? 1 : 0); // byte-wise; never localeCompare

// Which column is the radix key, per DATASET-SPEC §6.
const PRIMARY = { A: 'l1', B: 'l1', C: 'l2' };

const RADIX_BITS = 11;
const RADIX = 1 << RADIX_BITS;          // 2048 buckets
// Exact powers of two: 2^0, 2^11, 2^22, ... Division by these is lossless.
const POW = [];
for (let p = 0; p < 5; p++) POW.push(Math.pow(2, RADIX_BITS * p));

/** True when every key can be radixed exactly. */
function checkKeys(keys, n) {
  for (let i = 0; i < n; i++) {
    const v = keys[i];
    if (!(v >= 0) || v > Number.MAX_SAFE_INTEGER || !Number.isInteger(v)) return false;
  }
  return true;
}

/** Digits needed to represent max in base 2^RADIX_BITS. Never fewer than 1. */
function passesFor(max) {
  let p = 0;
  let m = max;
  while (m > 0) { p++; m = Math.floor(m / RADIX); }
  return p < 1 ? 1 : p;
}

/**
 * Stable LSD radix sort of an index permutation by `keys`.
 *
 * The key array is carried along and permuted with the indices rather than
 * being read through the permutation, so each pass is one sequential read and
 * one scattered write instead of two scattered reads. Returns both, because
 * the caller needs the sorted keys to find the group boundaries and re-reading
 * them through the permutation would undo the point.
 */
function radixPermutation(keys, n, passes) {
  let idxA = new Int32Array(n);
  let idxB = new Int32Array(n);
  let keyA = keys;
  let keyB = new Float64Array(n);
  for (let i = 0; i < n; i++) idxA[i] = i;

  const count = new Int32Array(RADIX);

  for (let p = 0; p < passes; p++) {
    const div = POW[p];
    count.fill(0);
    for (let i = 0; i < n; i++) {
      // Math.floor of an exact quotient, then a modulo on an exact integer.
      count[Math.floor(keyA[i] / div) % RADIX]++;
    }
    // Every key shares this digit: the pass is a no-op permutation. Skipping
    // it keeps the arrays where they are, which is why the buffers are chosen
    // by reference below rather than by pass parity.
    let skip = false;
    for (let d = 0; d < RADIX; d++) if (count[d] === n) { skip = true; break; }
    if (skip) continue;

    let sum = 0;
    for (let d = 0; d < RADIX; d++) { const c = count[d]; count[d] = sum; sum += c; }
    for (let i = 0; i < n; i++) {
      const k = keyA[i];
      const pos = count[Math.floor(k / div) % RADIX]++;
      idxB[pos] = idxA[i];
      keyB[pos] = k;
    }
    let t = idxA; idxA = idxB; idxB = t;
    let u = keyA; keyA = keyB; keyB = u;
  }
  return { idx: idxA, sortedKeys: keyA };
}

// --- the comparison half --------------------------------------------------
//
// Applied only inside a run of equal primary key, so it never re-tests the
// primary. Insertion sort below the run threshold; bottom-up merge above it,
// so a pathologically large tie group stays O(k log k) rather than O(k^2).

const RUN = 32;

function insertionRange(idx, lo, hi, cmp) {
  for (let i = lo + 1; i < hi; i++) {
    const v = idx[i];
    let j = i - 1;
    while (j >= lo && cmp(idx[j], v) > 0) { idx[j + 1] = idx[j]; j--; }
    idx[j + 1] = v;
  }
}

function sortRange(idx, tmp, lo, hi, cmp) {
  const n = hi - lo;
  if (n < 2) return;
  if (n <= RUN) { insertionRange(idx, lo, hi, cmp); return; }
  for (let s = lo; s < hi; s += RUN) insertionRange(idx, s, s + RUN < hi ? s + RUN : hi, cmp);
  let src = idx, dst = tmp;
  for (let width = RUN; width < n; width <<= 1) {
    const step = width << 1;
    for (let l = lo; l < hi; l += step) {
      const mid = l + width < hi ? l + width : hi;
      const h = l + step < hi ? l + step : hi;
      if (mid >= h) { for (let k = l; k < h; k++) dst[k] = src[k]; continue; }
      let i = l, j = mid, k = l;
      while (i < mid && j < h) dst[k++] = cmp(src[j], src[i]) < 0 ? src[j++] : src[i++];
      while (i < mid) dst[k++] = src[i++];
      while (j < h) dst[k++] = src[j++];
    }
    const t = src; src = dst; dst = t;
  }
  if (src !== idx) for (let k = lo; k < hi; k++) idx[k] = src[k];
}

/**
 * Per-dataset, per-representation accessors.
 *
 * `key(i)` is the radix key of ORIGINAL record i. `tie(a, b)` compares two
 * original record indices on the tie-breaks ONLY -- it is called with a and b
 * known to share a primary key. `full(a, b)` is the whole declared order, used
 * only by the fallback path.
 */
function accessors(loaded) {
  const ds = loaded.dataset;
  const prim = PRIMARY[ds];
  if (!prim) throw new Error(`no declared order for dataset '${ds}'`);

  if (loaded.mode === 'soa') {
    const l1 = loaded.l1, l2 = loaded.l2, l3 = loaded.l3ord;
    const tie = ds === 'A'
      ? (a, b) => cmpStr(l2[a], l2[b]) || cmpNum(l3[a], l3[b])
      : ds === 'B'
        ? (a, b) => cmpNum(l2[a], l2[b]) || cmpNum(l3[a], l3[b])
        : (a, b) => cmpStr(l1[a], l1[b]) || cmpNum(l3[a], l3[b]);
    const pcol = prim === 'l1' ? l1 : l2;
    return { key: (i) => pcol[i], tie, full: (a, b) => cmpNum(pcol[a], pcol[b]) || tie(a, b) };
  }

  const r = loaded.rows;
  const tie = ds === 'A'
    ? (a, b) => cmpStr(r[a].l2, r[b].l2) || cmpNum(r[a].l3ord, r[b].l3ord)
    : ds === 'B'
      ? (a, b) => cmpNum(r[a].l2, r[b].l2) || cmpNum(r[a].l3ord, r[b].l3ord)
      : (a, b) => cmpStr(r[a].l1, r[b].l1) || cmpNum(r[a].l3ord, r[b].l3ord);
  const key = prim === 'l1' ? (i) => r[i].l1 : (i) => r[i].l2;
  return { key, tie, full: (a, b) => cmpNum(key(a), key(b)) || tie(a, b) };
}

/** The permutation that puts the records into the declared total order. */
function permutation(loaded) {
  const n = loaded.n;
  const acc = accessors(loaded);

  const keys = new Float64Array(n);
  for (let i = 0; i < n; i++) keys[i] = acc.key(i);

  const tmp = new Int32Array(n);

  if (!checkKeys(keys, n)) {
    // Precondition violated -- the primary column is not a non-negative
    // integer everywhere. Radix cannot express this; degrade to the plain
    // comparison order so the run still produces a manifest and the
    // invariants get to report on it.
    const idx = new Int32Array(n);
    for (let i = 0; i < n; i++) idx[i] = i;
    sortRange(idx, tmp, 0, n, acc.full);
    return idx;
  }

  let max = 0;
  for (let i = 0; i < n; i++) if (keys[i] > max) max = keys[i];

  const { idx, sortedKeys } = radixPermutation(keys, n, passesFor(max));

  // Comparison half: one contiguous run per distinct primary key.
  let lo = 0;
  for (let i = 1; i <= n; i++) {
    if (i === n || sortedKeys[i] !== sortedKeys[lo]) {
      if (i - lo > 1) sortRange(idx, tmp, lo, i, acc.tie);
      lo = i;
    }
  }
  return idx;
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
  name: 'radix',
  algorithms: ['radix'],
  threads: 1,
  algorithm(loaded) {
    const idx = permutation(loaded);
    if (loaded.mode === 'soa') return gatherColumns(loaded, idx);
    // A fresh array, so the input is untouched and I2 compares against a
    // genuinely independent copy rather than against the sorted result.
    const src = loaded.rows;
    const rows = new Array(loaded.n);
    for (let i = 0; i < loaded.n; i++) rows[i] = src[idx[i]];
    return { ...loaded, rows };
  },
});
