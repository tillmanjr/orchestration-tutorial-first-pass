# Dataset Specification — v1 (draft)

**Freezes at the start of Module 02.** After that, a change is an event: bump
the version and stop every agent building against it.

Defined precisely enough that any implementation — JS, Rust, C++ — reproduces
the data byte-identically from a seed, and precisely enough that any agent can
verify a sort or a join *without a reference implementation*. Both properties
are load-bearing. Ambiguity here becomes divergence three modules downstream.

---

## 1. Shape

Three datasets, `A`, `B`, `C`. Each is a forest three levels deep:
L1 → L2 → L3 (leaf). Records are emitted unordered.

| Dataset | L1 type | L1 unique | L2 type | L2 unique | L3 |
|---|---|---|---|---|---|
| `A` | int64  | within A | string | within its L1 parent | leaf |
| `B` | int64  | within B | int32  | within its L1 parent | leaf |
| `C` | string | within C | int64  | **within its L1 parent only** | leaf |

Level 1 and level 2 types differ across datasets deliberately. That
heterogeneity is the subject, not an artifact of generation.

---

## 2. Key relationships

These overlaps are the reason the datasets exist. The generator hits them
within ±1% or fails loudly.

- **`A.L1 ∩ B.L1` ≈ 70%** of `min(|A.L1|, |B.L1|)` — the primary
  integer-to-integer join, and the easy case.
- **`C.L2` draws ≈60%** of its values from `A.L1 ∪ B.L1` and ≈40% from a
  disjoint reserve range. The reserve guarantees unmatched rows exist, so
  outer and anti joins have something to do. A dataset where everything
  matches teaches nothing about the cases that break in production.
- **`C.L2` is unique only within its parent.** One integer may appear under
  many different `C.L1` strings, so `A ⋈ C` is **1:N** and output cardinality
  can exceed either input. This is the merge failure mode that catches the
  most people, and it is here on purpose.

---

## 3. Physical format

One leaf per line. TSV, LF endings, UTF-8, no header, no quoting. No field may
contain a tab or a newline.

    ds <TAB> l1 <TAB> l2 <TAB> l3ord <TAB> datastring

Column 5, pipe-delimited:

    <ds>|<l1>|<l2>|<l3ord>|<pad>

`pad` is deterministic filler of `PAD_BYTES` width drawn from `[A-Za-z0-9]`.
It exists for one reason: to make memory pressure real rather than
theoretical. Without it everything fits in cache and the tradeoffs this
tutorial is about never appear.

### The redundancy is the oracle

Columns 1–4 duplicate the first four fields of column 5. That is not sloppy
schema design — it is the verification mechanism, and it is why this problem
was chosen over any other.

**Columns 1–4 are what you sort and join on. Column 5 is what proves you did
it correctly.** Every leaf carries its own dataset, parent, and grandparent,
so after any sort, partition, or join, structural correctness is checkable in
one linear pass with no reference implementation and no golden file.

Two rules protect this and are non-negotiable:

1. No implementation may derive columns 1–4 from column 5, or the reverse, at
   runtime. The oracle compares them; deriving one from the other makes the
   comparison vacuous.
2. No implementation may parse column 5 during the operation under test. It is
   opaque payload during work, and evidence afterward.

---

## 4. Determinism

All randomness is PCG32 (XSH-RR, 64→32), specified exactly so a Rust or C++
generator reproduces the JS generator byte for byte — which makes the
generator itself a differential test.

    state : uint64
    inc   : uint64, always odd

    init(seed, stream):
        state = 0
        inc   = (stream << 1) | 1
        next()
        state = state + seed
        next()

    next() -> uint32:
        old   = state
        state = old * 6364136223846793005 + inc      // wrapping
        xor   = ((old >> 18) ^ old) >> 27            // low 32 bits
        rot   = old >> 59                            // 0..31
        return (xor >> rot) | (xor << ((-rot) & 31)) // 32-bit rotate

    bounded(n) -> uint32:                            // unbiased
        threshold = (2^32 - n) % n
        loop: r = next(); if r >= threshold: return r % n

Streams: `A = 1`, `B = 2`, `C = 3`, padding `= 11`. Default `seed = 20260822`.

**In JS this must be BigInt or an explicit 32-bit-limb implementation.** PCG32
in doubles silently loses the low bits and yields a generator that is
deterministic but not the specified one — undetected until a Rust
implementation disagrees.

---

## 5. Tiers

One generator, three sizes. Verify on `tiny`, iterate on `mid`, benchmark on
`large`. Fan-out is uniform: L1→L2 draws `1..6`, L2→L3 draws `1..8`.
`PAD_BYTES = 48`, giving ≈105 bytes per line.

| Tier | L1 keys | ≈ leaves | ≈ size (per dataset) | Role |
|---|---|---|---|---|
| `tiny`  | 10,000    | 158 k  | 17 MB   | correctness; every invariant, every run |
| `mid`   | 250,000   | 3.9 M  | 410 MB  | iteration, **and the demo tier** — fits 24 GB with room |
| `large` | 1,000,000 | 15.8 M | 1.65 GB | benchmark only; ≈5 GB for all three |

`large` is deliberately sized past the point where naive JS holding parsed
objects (≈8–12 GB resident) meets Node's old-space ceiling. That wall is a
**result**, not a failure — exactly located and reproducible. It runs on a
64 GB machine and does not run on 24 GB, and the asymmetry is the lesson.

> `data/` is gitignored. Point `DATA_DIR` at a drive that is neither synced
> nor backed up before generating anything above `mid`.

---

## 6. Sort tasks

| Dataset | Key | Comparator |
|---|---|---|
| `A` | `L1` | numeric ascending |
| `B` | `L1` | numeric ascending |
| `C` | `L2` | numeric ascending; ties by `L1`, then `l3ord` |

**All string comparison is byte-wise over UTF-8. Never locale collation.** In
JS that means `<` / `>`, never `localeCompare`; in Rust, `str::cmp`. Stated
because locale collation is the classic silent cross-language divergence — two
implementations both "sorted correctly" and disagreeing on where `Z` sits
relative to `a`.

Sorts are **stable** with respect to `l3ord` within an equal key, so the
permutation check below has a unique expected answer.

---

## 7. Invariants — the verification gate

The oracle. Every implementation is checked against all applicable invariants
before its results are believed. None requires a reference implementation.

| | Invariant |
|---|---|
| **I1** | *Self-consistency.* For every row, columns 1–4 equal the first four fields of the parsed datastring. **Runs against in-memory records, not only against the file** — see §8. |
| **I2** | *Permutation preservation.* The multiset of datastrings after a sort equals the multiset before. Catches dropped, duplicated, and fabricated rows, which a sortedness check alone cannot see. |
| **I3** | *Sortedness.* Every adjacent pair satisfies the declared comparator, tie-break chain included. |
| **I4** | *Join provenance.* Every output row carries the full source datastring from each side. Both must parse, and their join keys must be equal under the declared rule. |
| **I5** | *Inner-join cardinality.* `\|inner\| = Σ_k countA(k) × countC(k)` over matched keys, computed independently from key histograms — never from the join output. |
| **I6** | *Outer and anti identities.* `\|left\| = \|inner\| + \|A unmatched\|`; `\|anti\| = \|A\| − \|A matched\|`; `\|full\| = \|left\| + \|right\| − \|inner\|`. |
| **I7** | *No coercion.* An integer key never matches a string key of the same digits. `42` and `"42"` are distinct. An implementation that joins them has failed, however plausible its output looks. |

I5 and I6 matter most in the zip module. They are cheap, exact, and catch the
errors that produce output of the right shape and the wrong size.

---

## 8. The canonical loader

Each runtime has exactly one loader, shared by every variation in that
runtime. Otherwise the matrix measures twenty TSV parsers rather than twenty
algorithms, and intra-runtime parse variance swamps the signal.

Loaders are **not** normalized across runtimes. Zero-copy `&str` slicing
versus a JS string allocation per field is a genuine language difference and a
finding in its own right; `load` is reported as its own phase precisely so it
stays visible.

A shared loader is a single point of failure that fails *consistently*, which
is the kind of bug that looks like correctness. This is why I1 must run
against loaded in-memory records: a loader that drops or transposes a field
otherwise passes every check and corrupts every cell in the matrix
identically.

---

## 9. Change control

| Version | Date | Change |
|---|---|---|
| v1 | 2026-08-22 | Initial draft. |
