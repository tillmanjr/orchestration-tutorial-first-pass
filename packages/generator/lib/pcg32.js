// PCG32 (XSH-RR, 64 -> 32), exactly as specified in docs/DATASET-SPEC.md §4.
//
// Two implementations of the same generator:
//
//   Pcg32      32-bit limb arithmetic. Fast. Used everywhere.
//   Pcg32Ref   BigInt. Obviously correct by inspection. Used only to prove
//              the fast one right.
//
// The limb version is fast because it never allocates; the BigInt version is
// trustworthy because it transcribes the specification line for line. Neither
// property is available in one implementation, so we keep both and assert
// they agree (see pcg32.selftest.js). This is the same differential-oracle
// pattern the rest of the project uses, at the smallest possible scale.
//
// Doing this arithmetic in doubles instead would silently lose the low bits
// and produce a generator that is deterministic but NOT the specified one --
// undetected until a Rust implementation disagrees.

export const PCG_MULT_HI = 0x5851f42d;
export const PCG_MULT_LO = 0x4c957f2d; // 6364136223846793005
const MASK64 = (1n << 64n) - 1n;
const MULT_BIG = 6364136223846793005n;

export const DEFAULT_SEED = 20260822;
export const STREAM = Object.freeze({ A: 1, B: 2, C: 3, PAD: 11 });

// --- 64-bit helpers over {hi, lo} pairs of uint32 -------------------------

/** Low 32 bits of a*b for uint32 a, b, plus the high 32. */
function umul32(a, b) {
  const aL = a & 0xffff, aH = a >>> 16;
  const bL = b & 0xffff, bH = b >>> 16;
  const ll = aL * bL;
  const lh = aL * bH;
  const hl = aH * bL;
  const hh = aH * bH;
  const mid = (ll >>> 16) + (lh & 0xffff) + (hl & 0xffff); // < 3 * 2^16
  const lo = (((mid & 0xffff) << 16) | (ll & 0xffff)) >>> 0;
  const hi = (hh + (lh >>> 16) + (hl >>> 16) + (mid >>> 16)) >>> 0;
  return { hi, lo };
}

/**
 * Low 64 bits of a 64x64 product. The high half of the result is discarded,
 * which is why only the cross terms' low 32 bits matter -- anything above
 * bit 63 falls off the end regardless.
 */
function mul64(aHi, aLo, bHi, bLo) {
  const p = umul32(aLo, bLo);
  const cross = (Math.imul(aLo, bHi) + Math.imul(aHi, bLo)) >>> 0;
  return { hi: (p.hi + cross) >>> 0, lo: p.lo };
}

function add64(aHi, aLo, bHi, bLo) {
  const lo = (aLo + bLo) >>> 0;
  // Unsigned carry: the sum wrapped iff the result is below either addend.
  const carry = lo < (aLo >>> 0) ? 1 : 0;
  return { hi: (aHi + bHi + carry) >>> 0, lo };
}

// --- fast implementation --------------------------------------------------

export class Pcg32 {
  /**
   * @param {number} seed   any safe integer; only the low 64 bits matter
   * @param {number} stream distinct per logical sequence (see STREAM)
   */
  constructor(seed = DEFAULT_SEED, stream = 1) {
    this.stateHi = 0;
    this.stateLo = 0;
    // inc = (stream << 1) | 1, always odd
    this.incHi = (stream / 0x80000000) >>> 0;
    this.incLo = (((stream << 1) >>> 0) | 1) >>> 0;

    this.next();
    const s = add64(this.stateHi, this.stateLo,
                    (seed / 0x100000000) >>> 0, seed >>> 0);
    this.stateHi = s.hi;
    this.stateLo = s.lo;
    this.next();
  }

  /** @returns {number} uint32 */
  next() {
    const oHi = this.stateHi, oLo = this.stateLo;

    const m = mul64(oHi, oLo, PCG_MULT_HI, PCG_MULT_LO);
    const s = add64(m.hi, m.lo, this.incHi, this.incLo);
    this.stateHi = s.hi;
    this.stateLo = s.lo;

    // xorshifted = (uint32)(((old >> 18) ^ old) >> 27)
    const sh18Lo = ((oLo >>> 18) | (oHi << 14)) >>> 0;
    const sh18Hi = oHi >>> 18;
    const xLo = (sh18Lo ^ oLo) >>> 0;
    const xHi = (sh18Hi ^ oHi) >>> 0;
    const xorshifted = ((xLo >>> 27) | (xHi << 5)) >>> 0;

    const rot = oHi >>> 27; // old >> 59
    return ((xorshifted >>> rot) | (xorshifted << ((-rot) & 31))) >>> 0;
  }

  /**
   * Unbiased value in [0, n). Rejection sampling -- a plain modulo would
   * skew the low values whenever n does not divide 2^32.
   * @param {number} n positive uint32
   */
  bounded(n) {
    const threshold = (0x100000000 - n) % n;
    for (;;) {
      const r = this.next();
      if (r >= threshold) return r % n;
    }
  }

  /** Inclusive range [lo, hi]. */
  range(lo, hi) {
    return lo + this.bounded(hi - lo + 1);
  }
}

// --- reference implementation --------------------------------------------

export class Pcg32Ref {
  constructor(seed = DEFAULT_SEED, stream = 1) {
    this.state = 0n;
    this.inc = ((BigInt(stream) << 1n) | 1n) & MASK64;
    this.next();
    this.state = (this.state + BigInt(seed)) & MASK64;
    this.next();
  }

  next() {
    const old = this.state;
    this.state = (old * MULT_BIG + this.inc) & MASK64;
    const xorshifted = Number((((old >> 18n) ^ old) >> 27n) & 0xffffffffn);
    const rot = Number(old >> 59n);
    return ((xorshifted >>> rot) | (xorshifted << ((-rot) & 31))) >>> 0;
  }

  bounded(n) {
    const threshold = (0x100000000 - n) % n;
    for (;;) {
      const r = this.next();
      if (r >= threshold) return r % n;
    }
  }

  range(lo, hi) {
    return lo + this.bounded(hi - lo + 1);
  }
}
