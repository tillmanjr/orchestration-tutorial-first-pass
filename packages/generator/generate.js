// Deterministic dataset generator. Milestone M2.
//
//   node packages/generator/generate.js --tier tiny [--seed N] [--out DIR]
//
// Emits A.tsv, B.tsv, C.tsv and generate-manifest.json into <out>/<tier>/.
// The manifest carries per-file SHA-256 and the achieved key-overlap
// statistics, which makes it the artifact M3 compares across platforms: if
// two machines produce identical hashes, PCG32, LF discipline and UTF-8
// handling are all proven correct on both in one comparison.
//
// Three constraints shaped this, and each is worth understanding before
// reading the code:
//
//   Keys must be unique with no dedup pass. Multiplying an index by an odd
//   constant modulo a power of two is a bijection, so uniqueness is
//   structural rather than checked. See lib/spec.js.
//
//   Records must be emitted unordered without holding them. A true shuffle
//   would need ~1.6 GB of JS strings at the large tier. Instead we walk a
//   bijection over the global leaf index and skip values past the end --
//   every leaf exactly once, scattered, in constant memory.
//
//   The pad must not dominate. Drawing 48 characters per leaf would cost
//   ~760 million PRNG draws at the large tier; a 4096-entry pool indexed by
//   a hash of the leaf index costs none, and the pad carries no information.

import { createWriteStream } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { Pcg32, DEFAULT_SEED, STREAM } from './lib/pcg32.js';
import {
  TIERS, FANOUT_L2, FANOUT_L3, OVERLAP_AB, C_MATCH_RATE, BLOCK,
  PAD_POOL_SIZE, intKey, blockOf, stringKey, tagKey, buildPadPool,
  line, makePermutation,
} from './lib/spec.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..');
const argv = process.argv.slice(2);
const arg = (flag, dflt) => { const i = argv.indexOf(flag); return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt; };

const tier = arg('--tier', 'tiny');
const seed = Number(arg('--seed', String(DEFAULT_SEED)));
const outDir = join(resolve(arg('--out', join(REPO, 'data'))), tier);
if (!TIERS[tier]) { console.error(`unknown tier '${tier}'; expected one of ${Object.keys(TIERS).join(', ')}`); process.exit(2); }

const N = TIERS[tier].l1;
const SHARED = Math.round(N * OVERLAP_AB);
const ONLY = N - SHARED;

// --- helpers --------------------------------------------------------------

function shuffle(arr, rng) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = rng.bounded(i + 1);
    const t = arr[i]; arr[i] = arr[j]; arr[j] = t;
  }
  return arr;
}

/** Largest i in [0, len) with cum[i] <= g. cum is non-decreasing, cum[0] === 0. */
function locate(cum, g, len) {
  let lo = 0, hi = len - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (cum[mid] <= g) lo = mid; else hi = mid - 1;
  }
  return lo;
}

/**
 * Draw the L2 layer for every parent. Returns flat parallel arrays plus the
 * cumulative leaf offsets, which together let any global leaf index be
 * resolved back to (parent, l2, ordinal) in a binary search.
 */
function buildTree(rng, n, l2 /* { begin?, child } */) {
  const parentIdx = [], l2key = [], cum = [0];
  let total = 0;
  for (let p = 0; p < n; p++) {
    const kids = rng.range(FANOUT_L2[0], FANOUT_L2[1]);
    const ctx = l2.begin ? l2.begin(rng, p) : null;
    for (let c = 0; c < kids; c++) {
      const key = l2.child(rng, p, c, ctx);
      const leaves = rng.range(FANOUT_L3[0], FANOUT_L3[1]);
      parentIdx.push(p);
      l2key.push(key);
      total += leaves;
      cum.push(total);
    }
  }
  return { parentIdx, l2key, cum, total, nodes: parentIdx.length };
}

// murmur3 finalizer. A single multiply-and-shift over consecutive integers
// produces a lattice rather than a spread -- it left a third of the pad pool
// unused at the tiny tier. Full avalanche costs three more operations and
// removes the artefact.
function mix32(x) {
  let h = x | 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

const DS_SALT = { A: 0x9e3779b1 | 0, B: 0x85ebca77 | 0, C: 0xc2b2ae3d | 0 };

async function emit(ds, keys, tree, padPool, path) {
  const salt = DS_SALT[ds];
  const { parentIdx, l2key, cum, total, nodes } = tree;
  const perm = makePermutation(total);
  const stream = createWriteStream(path, { encoding: 'utf8' });
  const hash = createHash('sha256');

  let buf = [], written = 0;
  const flush = async () => {
    const s = buf.join(''); buf = [];
    hash.update(s, 'utf8');
    if (!stream.write(s)) await once(stream, 'drain');
  };

  for (let x = 0; x < perm.size; x++) {
    const g = perm.at(x);
    if (g >= total) continue;              // index past the end: skip, never reuse
    const idx = locate(cum, g, nodes);
    const ord = g - cum[idx];
    // Pad index is a pure function of the leaf index, so it does not depend
    // on emission order -- change the permutation and the bytes are the same.
    const pad = padPool[mix32(g ^ salt) & (PAD_POOL_SIZE - 1)];
    buf.push(line(ds, keys[parentIdx[idx]], l2key[idx], ord, pad));
    written++;
    if (buf.length >= 8192) await flush();
  }
  if (buf.length) await flush();
  stream.end();
  await once(stream, 'finish');
  if (written !== total) throw new Error(`${ds}: emitted ${written} of ${total} leaves`);
  return { records: written, sha256: hash.digest('hex') };
}

// --- build ----------------------------------------------------------------

const t0 = process.hrtime.bigint();
await mkdir(outDir, { recursive: true });

const rngA = new Pcg32(seed, STREAM.A);
const rngB = new Pcg32(seed, STREAM.B);
const rngC = new Pcg32(seed, STREAM.C);
const padPool = buildPadPool(new Pcg32(seed, STREAM.PAD));

// Level-1 keys. A and B share the first SHARED values exactly; the remainder
// come from disjoint blocks, so the intersection is exact by construction and
// the manifest below verifies it rather than assuming it.
const aKeys = new Float64Array(N);
const bKeys = new Float64Array(N);
for (let i = 0; i < SHARED; i++) { const k = intKey(BLOCK.SHARED, i); aKeys[i] = k; bKeys[i] = k; }
for (let j = 0; j < ONLY; j++) {
  aKeys[SHARED + j] = intKey(BLOCK.A_ONLY, j);
  bKeys[SHARED + j] = intKey(BLOCK.B_ONLY, j);
}

// The pool C draws its matching keys from: every level-1 key in A or B.
const union = new Float64Array(SHARED + ONLY * 2);
union.set(aKeys.subarray(0, N), 0);
union.set(bKeys.subarray(SHARED, N), N);

shuffle(aKeys, rngA);
shuffle(bKeys, rngB);
const cKeys = shuffle(Array.from({ length: N }, (_, i) => stringKey(i)), rngC);

let cMatched = 0, cReserve = 0, cFallback = 0;

const treeA = buildTree(rngA, N, { child: (rng, p, c) => tagKey(c, rng.next()) });

const treeB = buildTree(rngB, N, {
  begin: (rng) => rng.range(1000, 1 << 29),
  child: (rng, p, c, base) => base + c,          // unique within parent, int32
});

const treeC = buildTree(rngC, N, {
  begin: () => new Set(),
  child: (rng, p, c, used) => {
    for (let attempt = 0; attempt < 8; attempt++) {
      const v = rng.bounded(100) < C_MATCH_RATE * 100
        ? union[rng.bounded(union.length)]
        : intKey(BLOCK.C_RESERVE, rng.bounded(N * 4));
      if (!used.has(v)) {
        used.add(v);
        if (blockOf(v) === BLOCK.C_RESERVE) cReserve++; else cMatched++;
        return v;
      }
    }
    // Deterministic escape hatch, unique by construction: distinct index per
    // (parent, child). Counted separately so the manifest shows how often the
    // rejection loop failed rather than hiding it.
    const v = intKey(BLOCK.C_RESERVE, N * 4 + p * 8 + c);
    used.add(v); cFallback++; cReserve++;
    return v;
  },
});

const outA = await emit('A', aKeys, treeA, padPool, join(outDir, 'A.tsv'));
const outB = await emit('B', bKeys, treeB, padPool, join(outDir, 'B.tsv'));
const outC = await emit('C', cKeys, treeC, padPool, join(outDir, 'C.tsv'));

// --- verify the generator's own targets ----------------------------------
//
// These are checks on the GENERATOR, not on any implementation under test.
// The spec commits to key overlaps within ±1%; a generator that silently
// misses them produces data where the join module teaches the wrong thing.

const aSet = new Set(aKeys);
let intersect = 0;
for (const k of bKeys) if (aSet.has(k)) intersect++;

const cTotal = cMatched + cReserve;
const overlapAB = intersect / N;
const matchRateC = cMatched / cTotal;
const okAB = Math.abs(overlapAB - OVERLAP_AB) <= 0.01;
const okC = Math.abs(matchRateC - C_MATCH_RATE) <= 0.01;

const manifest = {
  contract: 1,
  kind: 'generate-manifest',
  tier, seed,
  generator: { runtime: 'node', runtime_version: process.versions.node },
  parameters: {
    l1_per_dataset: N, fanout_l2: FANOUT_L2, fanout_l3: FANOUT_L3,
    target_overlap_ab: OVERLAP_AB, target_match_rate_c: C_MATCH_RATE,
  },
  files: {
    'A.tsv': { ...outA, l1_keys: N, l2_nodes: treeA.nodes },
    'B.tsv': { ...outB, l1_keys: N, l2_nodes: treeB.nodes },
    'C.tsv': { ...outC, l1_keys: N, l2_nodes: treeC.nodes },
  },
  key_relationships: {
    intersect_ab: intersect,
    overlap_ab: Number(overlapAB.toFixed(6)),
    overlap_ab_ok: okAB,
    c_l2_matched: cMatched,
    c_l2_reserve: cReserve,
    c_l2_rejection_fallbacks: cFallback,
    match_rate_c: Number(matchRateC.toFixed(6)),
    match_rate_c_ok: okC,
  },
  elapsed_ns: Number(process.hrtime.bigint() - t0),
};

await writeFile(join(outDir, 'generate-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');

console.log(JSON.stringify(manifest, null, 2));
if (!okAB) console.error(`\nFAIL: A/B overlap ${overlapAB} outside ${OVERLAP_AB} +/- 0.01`);
if (!okC) console.error(`FAIL: C match rate ${matchRateC} outside ${C_MATCH_RATE} +/- 0.01`);
console.log(okAB && okC ? '\nPASS: generator hit its key-relationship targets' : '\nFAIL');
process.exit(okAB && okC ? 0 : 1);
