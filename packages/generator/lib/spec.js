// Constants and derivations from docs/DATASET-SPEC.md. Anything here that the
// spec does not state is a decision, and it is commented as one.

export const TIERS = Object.freeze({
  tiny:  { l1: 10_000 },
  mid:   { l1: 250_000 },
  large: { l1: 1_000_000 },
});

export const FANOUT_L2 = [1, 6];   // children per L1, inclusive
export const FANOUT_L3 = [1, 8];   // leaves per L2, inclusive
export const PAD_BYTES = 48;
export const OVERLAP_AB = 0.70;    // |A.L1 ∩ B.L1| / n
export const C_MATCH_RATE = 0.60;  // share of C.L2 drawn from A.L1 ∪ B.L1

// --- integer keyspace -----------------------------------------------------
//
// Keys live in four disjoint blocks of 2^36, based at 2^40 so they look like
// plausible large identifiers rather than small ordinals. Within a block,
// key(i) = BASE + block*2^36 + ((i * ODD) mod 2^36).
//
// Multiplication by an odd constant modulo a power of two is a bijection, so
// keys are distinct BY CONSTRUCTION: no dedup pass, no rejection loop, no
// hash set of a million entries. Disjoint blocks then make "is this key from
// A, from B, or from C's reserve?" answerable by range alone -- which is what
// lets the oracle compute join cardinalities independently of the join.
//
// BigInt here rather than doubles: i * ODD exceeds 2^53 for the large tier,
// and this runs once per L1 key rather than once per leaf, so the cost is
// irrelevant.

const KEY_BASE = 1n << 40n;
const KEY_BLOCK = 1n << 36n;
const KEY_ODD = 2654435761n;

export const BLOCK = Object.freeze({ SHARED: 0, A_ONLY: 1, B_ONLY: 2, C_RESERVE: 3 });

export function intKey(block, i) {
  const mixed = (BigInt(i) * KEY_ODD) & (KEY_BLOCK - 1n);
  return Number(KEY_BASE + BigInt(block) * KEY_BLOCK + mixed);
}

/** Which block a key came from. Used by the oracle, never by an implementation under test. */
export function blockOf(key) {
  return Math.floor((key - Number(KEY_BASE)) / Number(KEY_BLOCK));
}

// --- C level-1 string keys ------------------------------------------------
//
// The prefix varies in case on purpose. C is sorted by L2 with ties broken by
// L1, and byte-wise UTF-8 order puts every uppercase letter before every
// lowercase one -- so 'ND-...' < 'Nd-...' < 'nD-...' < 'nd-...'. Locale
// collation does not agree. An implementation that reaches for localeCompare
// produces a plausible ordering that fails I3, which is the entire point of
// including these.

const C_PREFIXES = ['ND', 'Nd', 'nD', 'nd'];

export function stringKey(i) {
  const mixed = (BigInt(i) * KEY_ODD) & (KEY_BLOCK - 1n);
  const body = mixed.toString(36).toUpperCase().padStart(8, '0');
  return `${C_PREFIXES[i & 3]}-${body}`;
}

// --- A level-2 string tags ------------------------------------------------

const TAGS = [
  'alpha', 'bravo', 'delta', 'echo', 'flux', 'gamma', 'helix', 'ion',
  'jade', 'kilo', 'lumen', 'mesa', 'nova', 'onyx', 'pivot', 'quartz',
];

/** Unique within a parent: the childIdx prefix guarantees it regardless of tag. */
export function tagKey(childIdx, r) {
  return `t${childIdx}-${TAGS[r & 15]}`;
}

// --- padding --------------------------------------------------------------
//
// DEVIATION FROM A NAIVE READING OF THE SPEC, stated openly: the pad is drawn
// from a precomputed pool of 4096 deterministic strings rather than generated
// fresh per leaf. Generating 48 characters per leaf would mean ~760 million
// PRNG draws for the large tier and would dominate generation entirely.
//
// This is sound because the pad's only job is to occupy memory. It carries no
// information and nothing joins on it. Datastrings remain unique because
// ds|l1|l2|l3ord already is, so invariant I2 is unaffected.
//
// Two details that are not optional:
//
//   The pool is indexed by a hash of the leaf index SALTED PER DATASET.
//   Without the salt, the nth record of A, B and C all receive the same pad
//   -- harmless, but it reads as a bug and invites doubt about the generator
//   at exactly the moment you need to trust it.
//
//   V8 does not intern strings produced by slicing at runtime, so each
//   record's pad is a distinct object even though only PAD_POOL_SIZE values
//   exist. The memory pressure the pad exists to create is therefore real,
//   which is the whole justification for pooling in the first place.

const PAD_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
export const PAD_POOL_SIZE = 65536;

export function buildPadPool(rng) {
  const ringLen = PAD_POOL_SIZE + PAD_BYTES;
  let ring = '';
  for (let i = 0; i < ringLen; i++) ring += PAD_ALPHABET[rng.bounded(PAD_ALPHABET.length)];
  const pool = new Array(PAD_POOL_SIZE);
  for (let i = 0; i < PAD_POOL_SIZE; i++) pool[i] = ring.slice(i, i + PAD_BYTES);
  return pool;
}

// --- record format --------------------------------------------------------

export function datastring(ds, l1, l2, l3ord, pad) {
  return `${ds}|${l1}|${l2}|${l3ord}|${pad}`;
}

export function line(ds, l1, l2, l3ord, pad) {
  return `${ds}\t${l1}\t${l2}\t${l3ord}\t${datastring(ds, l1, l2, l3ord, pad)}\n`;
}

// --- streaming permutation -----------------------------------------------
//
// The spec requires records to be emitted unordered. A true shuffle would
// mean holding every leaf in memory -- ~1.6 GB of JS strings at the large
// tier, on a machine we also want to benchmark. Writing bucket files instead
// would leave temporaries the agent cannot delete (precondition E3).
//
// So instead: walk a bijection over the global leaf index. x -> (x * ODD) mod
// 2^k followed by an xor-shift is a permutation of [0, 2^k); values landing
// past the true leaf count are skipped, which yields each index exactly once,
// in scattered order, in constant memory and a single streaming pass.
//
// k <= 24 for every tier, so all of this stays inside exact 32-bit integer
// arithmetic. Math.imul gives the low 32 bits exactly; masking to k bits is
// then correct.

const PERM_ODD = 0x9e3779 | 1;

export function makePermutation(total) {
  let bits = 1;
  while ((1 << bits) < total) bits++;
  const mask = (1 << bits) - 1;
  return {
    bits,
    size: 1 << bits,
    at(x) {
      let v = Math.imul(x, PERM_ODD) & mask;
      v ^= (v >>> Math.max(1, bits >> 1)) & mask; // xor-shift: bijective on k bits
      return v & mask;
    },
  };
}
