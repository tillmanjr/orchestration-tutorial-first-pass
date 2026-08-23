// The verification gate. Every check here is mechanical, and none needs a
// reference implementation -- that is the property the whole project is built
// on, and it comes from the datastring in column 5 making each leaf
// self-describing.

import { reader } from '../js-sorts/lib/load.js';

// --- comparators ----------------------------------------------------------
//
// Each is a TOTAL order. (l1, l2, l3ord) uniquely identifies a record within
// a dataset, so appending those as tie-breaks means a correct sort has
// exactly one valid output and I3 is decisive.
//
// An earlier draft of the spec asked instead for stability with respect to
// l3ord. That was incoherent: stability preserves INPUT order, and the input
// is shuffled, so a stable sort of shuffled data has no unique answer to
// check against. Total order is what makes this verifiable at all.
//
// String comparison is byte-wise over UTF-8 -- plain < and > in JS, never
// localeCompare. C's level-1 keys deliberately mix case (ND / Nd / nD / nd),
// where byte order and locale collation disagree, so an implementation that
// reaches for localeCompare produces a plausible ordering that fails here.

const cmpNum = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const cmpStr = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

export const COMPARATORS = Object.freeze({
  // A: by level-1 (numeric), ties by level-2 (byte-wise), then ordinal.
  A: (R, i, j) => cmpNum(R.l1(i), R.l1(j)) || cmpStr(R.l2(i), R.l2(j)) || cmpNum(R.l3ord(i), R.l3ord(j)),
  // B: by level-1 (numeric), ties by level-2 (numeric), then ordinal.
  B: (R, i, j) => cmpNum(R.l1(i), R.l1(j)) || cmpNum(R.l2(i), R.l2(j)) || cmpNum(R.l3ord(i), R.l3ord(j)),
  // C: by level-2 (numeric), ties by level-1 (byte-wise), then ordinal.
  C: (R, i, j) => cmpNum(R.l2(i), R.l2(j)) || cmpStr(R.l1(i), R.l1(j)) || cmpNum(R.l3ord(i), R.l3ord(j)),
});

// --- I1: self-consistency -------------------------------------------------
//
// Columns 1-4 must equal the first four fields of the parsed datastring.
// Runs against LOADED RECORDS, not against raw file text: the canonical
// loader is shared by every variation in the runtime, so a loader that drops
// or transposes a field fails consistently, which is the kind of bug that
// looks like correctness. Checking only the file on disk would never see it.

export function checkI1(loaded, { limit = 10 } = {}) {
  const R = reader(loaded);
  const problems = [];
  for (let i = 0; i < R.n && problems.length < limit; i++) {
    const d = R.d(i);
    const p = d.split('|');
    if (p.length !== 5) { problems.push({ i, why: `datastring has ${p.length} fields, expected 5` }); continue; }
    if (p[0] !== R.ds(i)) problems.push({ i, why: `ds '${R.ds(i)}' != datastring '${p[0]}'` });
    else if (p[1] !== String(R.l1(i))) problems.push({ i, why: `l1 '${R.l1(i)}' != datastring '${p[1]}'` });
    else if (p[2] !== String(R.l2(i))) problems.push({ i, why: `l2 '${R.l2(i)}' != datastring '${p[2]}'` });
    else if (p[3] !== String(R.l3ord(i))) problems.push({ i, why: `l3ord '${R.l3ord(i)}' != datastring '${p[3]}'` });
  }
  return { id: 'I1', name: 'self-consistency', n: R.n, pass: problems.length === 0, problems };
}

// --- I2: permutation preservation ----------------------------------------
//
// An order-independent digest of the multiset of datastrings. Sum and XOR of
// a 64-bit per-record hash, kept as 32-bit halves so no BigInt appears in the
// inner loop.
//
// Sortedness alone cannot see a dropped, duplicated or fabricated row: a sort
// that silently discards half its input produces perfectly sorted output.
// Comparing this digest before and after is what closes that hole. Both
// accumulators are kept because sum alone misses a swap of two equal-summing
// records and XOR alone misses any duplicated pair.

function hash2(s) {
  let h1 = 0x9e3779b1 | 0, h2 = 0x85ebca77 | 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x5bd1e995);
    h1 ^= h1 >>> 15;
    h2 = Math.imul(h2 + c, 0xc2b2ae35);
    h2 ^= h2 >>> 13;
  }
  return [h1 >>> 0, h2 >>> 0];
}

export function digest(loaded) {
  const R = reader(loaded);
  let sumLo = 0, sumHi = 0, xorLo = 0, xorHi = 0;
  for (let i = 0; i < R.n; i++) {
    const [a, b] = hash2(R.d(i));
    sumLo += a; sumHi += b + Math.floor(sumLo / 0x100000000); sumLo %= 0x100000000;
    sumHi %= 0x100000000;
    xorLo = (xorLo ^ a) >>> 0; xorHi = (xorHi ^ b) >>> 0;
  }
  return { count: R.n, sum: `${sumHi.toString(16)}:${sumLo.toString(16)}`, xor: `${xorHi.toString(16)}:${xorLo.toString(16)}` };
}

export function checkI2(beforeDigest, afterDigest) {
  const same = beforeDigest.count === afterDigest.count
    && beforeDigest.sum === afterDigest.sum
    && beforeDigest.xor === afterDigest.xor;
  return {
    id: 'I2', name: 'permutation preservation', pass: same,
    before: beforeDigest, after: afterDigest,
    problems: same ? [] : [{
      why: beforeDigest.count !== afterDigest.count
        ? `record count changed: ${beforeDigest.count} -> ${afterDigest.count}`
        : 'same count, different multiset: records were substituted or mutated',
    }],
  };
}

// --- I3: sortedness -------------------------------------------------------

export function checkI3(loaded, dataset, { limit = 10 } = {}) {
  const R = reader(loaded);
  const cmp = COMPARATORS[dataset];
  if (!cmp) throw new Error(`no comparator for dataset '${dataset}'`);
  const problems = [];
  let inversions = 0;
  for (let i = 1; i < R.n; i++) {
    if (cmp(R, i - 1, i) > 0) {
      inversions++;
      if (problems.length < limit) {
        problems.push({ i, why: `row ${i - 1} sorts after row ${i}`, prev: R.d(i - 1).split('|').slice(0, 4).join('|'), curr: R.d(i).split('|').slice(0, 4).join('|') });
      }
    }
  }
  return { id: 'I3', name: 'sortedness', n: R.n, inversions, pass: inversions === 0, problems };
}
