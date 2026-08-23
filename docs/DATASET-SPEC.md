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

Each comparator is a **total order**. `(L1, L2, l3ord)` uniquely identifies a
record within a dataset, so a correct sort has exactly one valid output and
invariant I3 is decisive.

| Dataset | Primary | Tie-break 1 | Tie-break 2 |
|---|---|---|---|
| `A` | `L1` numeric asc | `L2` byte-wise asc | `l3ord` numeric asc |
| `B` | `L1` numeric asc | `L2` numeric asc | `l3ord` numeric asc |
| `C` | `L2` numeric asc | `L1` byte-wise asc | `l3ord` numeric asc |

> **Correction, v1.1.** v1 of this document asked instead for sorts to be
> *stable with respect to `l3ord`*. That was incoherent. Stability preserves
> **input** order, and the input is deliberately shuffled — so a stable sort
> of shuffled data has no unique expected output, and there would be nothing
> for I3 to check against. Requiring a total order is what makes the result
> verifiable at all. The error was caught while writing the oracle, which is
> the argument for building the checker before the implementations rather
> than after.

**All string comparison is byte-wise over UTF-8. Never locale collation.** In
JS that means `<` / `>`, never `localeCompare`; in Rust, `str::cmp`.

This is not a stylistic preference, and `C` is built to prove it. Its level-1
keys carry the prefixes `ND`, `Nd`, `nD`, `nd` in near-equal proportion, and
ties on `L2` are common because 60% of those values are drawn from a shared
pool. Byte order puts every uppercase letter before every lowercase one;
ICU collation treats case as a tertiary difference and orders them roughly
the other way.

Measured on the tiny tier: sorting `C` with `localeCompare` on the tie-break
produces **4,851 inversions** — while I2 passes, because every record is
present and unmutated. The output is complete, plausible, and wrong. That is
the failure this rule exists to prevent, and it is the reason a sortedness
check on its own is not sufficient evidence.

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

## 9. Reference generation algorithm (normative)

Sections 1–8 describe what the data *is*. This section describes exactly how
it is produced, because two implementations agreeing on the shape of the data
is not the same as producing identical bytes — and identical bytes is what M3
and M6 check.

**This section is normative.** A port that follows sections 1–8 but not this
one will generate valid-looking data with different hashes, and the
divergence will be indistinguishable from a PRNG bug.

### 9.1 Streams and draw order

Determinism depends on the *order* of draws, not only on the generator. Each
dataset draws from its own stream, in exactly this sequence:

1. Level-1 keys are built (no draws), then Fisher–Yates shuffled: for
   `i` from `n-1` down to `1`, `j = bounded(i+1)`, swap.
2. For each parent `p` in `0..n-1`:
   a. `kids = range(1, 6)`
   b. per-dataset parent context, if any (`B` draws its L2 base here)
   c. for each child `c` in `0..kids-1`: the L2 key material, then
      `leaves = range(1, 8)`

Per-dataset L2 key material, drawn at step 2c:

| Dataset | Draws | L2 value |
|---|---|---|
| `A` | one `next()` | `t{c}-{TAGS[draw & 15]}` |
| `B` | none (base drawn at 2b as `range(1000, 2^29)`) | `base + c` |
| `C` | see 9.2 | int64 |

### 9.2 C's level-2 selection

For each child, up to 8 attempts; each attempt draws `bounded(100)` and then
one further draw:

- if `bounded(100) < 60`: `union[bounded(|union|)]`, where `union` is the
  concatenation of A's level-1 keys then B's non-shared level-1 keys, **in
  unshuffled construction order**
- otherwise: `intKey(C_RESERVE, bounded(4n))`

An attempt is accepted if the value is not already used by this parent.
After 8 failed attempts, fall back to `intKey(C_RESERVE, 4n + 8p + c)`, which
is unique by construction. The manifest reports fallback count; it is 0 at
every tier tested so far.

### 9.3 Emission order

A true shuffle would require holding every record — roughly 1.6 GB of strings
at the large tier — and bucket files would leave temporaries that cannot be
deleted under precondition E3. Instead, emission walks a bijection over the
global leaf index:

    bits  = smallest k such that 2^k >= T        (T = total leaves)
    mask  = 2^bits - 1
    perm(x):
        v = (x * 0x9E3779) & mask                 // low 32 bits via imul, then mask
        v = (v ^ ((v >>> max(1, bits >> 1)) & mask)) & mask
        return v

Iterate `x` from `0` to `2^bits - 1`; skip any `perm(x) >= T`; otherwise emit
leaf `perm(x)`. Multiplication by an odd constant modulo a power of two is a
bijection, and xor-shift-right is a bijection on fixed width, so each leaf is
emitted exactly once.

**What this guarantees and what it does not.** It guarantees every leaf
exactly once, in an order uncorrelated with the sort keys, in constant memory.
It is *not* a uniform random permutation — it is one fixed permutation
determined by `T`. That is sufficient here: the requirement is that the input
contain no exploitable order. Measured at the tiny tier, the longest ascending
run in A's emitted key order is **8 of 158,723**, so a run-detecting sort such
as TimSort finds nothing to use.

A global leaf index is resolved back to a record by binary search over the
cumulative leaf offsets of the level-2 nodes: the largest node index whose
cumulative start is `<= g`, with `l3ord = g - cumulativeStart`.

### 9.4 Padding

The pad is **not** generated per leaf. Drawing 48 characters per record would
cost roughly 760 million PRNG draws at the large tier and would dominate
generation entirely.

Construction, once per run, from stream `PAD` (11):

    ring = 65536 + 48 characters drawn as ALPHABET[bounded(62)]
    pool[i] = ring[i .. i+48]           for i in 0..65535

    ALPHABET = A-Z a-z 0-9   (in that order, 62 characters)

Selection, per leaf:

    padIndex = mix32(g ^ SALT[ds]) & 65535

    SALT = { A: 0x9E3779B1, B: 0x85EBCA77, C: 0xC2B2AE3D }

    mix32(x):                                   // murmur3 finalizer
        h = x
        h = (h ^ (h >>> 16)) * 0x85EBCA6B        // low 32 bits
        h = (h ^ (h >>> 13)) * 0xC2B2AE35        // low 32 bits
        return (h ^ (h >>> 16)) >>> 0

Two details that are not optional. **The salt** stops the nth record of A, B
and C sharing a pad — harmless in itself, but it reads as a bug at exactly the
moment you need to trust the generator. **The murmur3 finalizer** replaced a
single multiply-and-shift, which over consecutive indices produced a lattice
rather than a spread and left a third of the pool unused (46,351 distinct pads
where a uniform hash gives ~59,700; now 59,772).

This is sound because the pad carries no information and nothing joins on it.
Datastrings stay unique because `ds|l1|l2|l3ord` already is, so I2 is
unaffected. And V8 does not intern strings produced by slicing at runtime, so
each record's pad is still a distinct object — the memory pressure the pad
exists to create is real, which is the justification for pooling at all.

---

## 10. Change control

| Version | Date | Change |
|---|---|---|
| v1 | 2026-08-22 | Initial draft. |
| v1.1 | 2026-08-22 | §6: comparators are total orders; the stability requirement was incoherent against shuffled input. Collation trap quantified against the tiny tier. |
| v1.2 | 2026-08-22 | Added §9, the normative generation algorithm. Draw order, C's L2 selection, the emission bijection, and the pad pool were implemented but undocumented — a port written from §§1–8 alone would have produced valid data with different hashes. |
