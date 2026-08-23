# Working Log

Dated decisions, discoveries, corrections and failures, recorded as they
happen.

This exists because of M8. Its exit criterion forbids writing performance
claims from an agent's recollection — and the same objection applies to the
narrative. Reconstructing *why* a decision was made, from a git log, months
later, produces a confident and partly fictional account. Every entry here is
written the day it happened, and the finished tutorial is assembled from these
rather than from memory.

Entry types: **DECISION** (a choice with live alternatives), **DISCOVERY**
(something the work revealed), **CORRECTION** (a document or design that was
wrong), **FAILURE** (something that went wrong, including process failures).

Preconditions live in `MILESTONES.md` Part 1; this log records events.

---

## 2026-08-22

### DECISION — the problem is a sort-then-zip over three hierarchical datasets

Proposed by the operator, and better than the alternatives on one specific
ground: **every leaf is self-describing.** Column 5 encodes the record's
dataset, parent and grandparent, so structural correctness after any sort or
join is checkable in one linear pass with no reference implementation and no
golden file.

That property is what makes it safe to fan work out across many agents, and
it is unusual — most candidate problems require a second implementation
before any verification is possible at all.

Rejected alternative: a generic "expensive computation" in Rust called from
JS. Cheaper to build, but verification would have depended on a JS reference
implementation being correct, which is a much weaker oracle.

### DECISION — this is a language/runtime comparison, not an FFI study

The question is what each runtime costs and buys for this shape of work.
JavaScript is the harness. It orchestrates, collects and reports; **it never
times anything it did not execute.**

Consequence: every implementation times itself with its own monotonic clock
and reports phases in its manifest. The process boundary stops being a
variable and becomes a footnote measured once. This is why the boundary
carries a job spec and a manifest while the data stays in files — a wire
format that serialised the dataset would have made the boundary cost
inseparable from the sort cost.

### DECISION — C's level-2 key is unique only within its parent

Makes `A ⋈ C` a 1:N join, so output cardinality can exceed either input.
Chosen over globally-unique (1:1, simplest, teaches least) and over
duplicates-everywhere (N:M, realistic but would dominate the module).

### DISCOVERY — RSS units vary by access path, not by platform

`rss-probe` was built first, before any measurement, on the principle that an
unverified instrument is worse than no instrument because it looks
authoritative. It immediately falsified §5 of the measurement contract.

The contract listed units per platform. That is true of the underlying OS
calls and false of what a runtime hands you on top of them. Node normalises
through libuv and reports **kilobytes on all three platforms** — now verified
on win32-x64 and darwin-arm64, not assumed. Native code does not: `getrusage`
returns **bytes on Darwin** and **kilobytes on Linux**, and Windows'
`PeakWorkingSetSize` is bytes.

So a Rust cell and a Node cell on the same machine, measuring the same
quantity, read it through sources disagreeing by a factor of 1024 — and
neither program looks wrong. It would have surfaced as Rust apparently using
a thousand times more memory than JS, which is the kind of result that gets
rationalised rather than investigated.

Contract → v1.1, rewritten around access path. New rule: every runtime ships
and passes its own probe before its first benchmark is believed. The Rust and
C++ probes are gates on M6.

### CORRECTION — the sort specification was incoherent

§6 v1 required sorts to be "stable with respect to `l3ord`". Stability
preserves **input** order, and the input is deliberately shuffled — so a
stable sort of shuffled data has no unique expected output and I3 would have
had nothing to check against.

Corrected to **total orders** on `(L1, L2, l3ord)`, which makes a correct
sort have exactly one valid output.

Found while writing the oracle. That is the argument for building the checker
before the implementations: had the sorts been written first, they would have
been "verified" against a criterion that could not distinguish right from
wrong.

### DISCOVERY — the collation trap, quantified

Sorting `C` with `localeCompare` on the tie-break produces **4,851
inversions** at the tiny tier — while I2 passes, because every record is
present and unmutated. The output is complete, plausible, and wrong.

Also demonstrated in the same self-test: **I3 passes on output that is
missing a record.** A sort that silently drops half its input produces
perfectly sorted output. Only I2 sees it. Neither invariant is sufficient
alone, which is why the oracle runs both.

### DISCOVERY — three-platform byte identity

`tiny` generates byte-identically on linux-x64, win32-x64 and darwin-arm64.
The architecture change was the real test: the limb PCG32 depends on
`Math.imul` and `>>>` being bit-exact, and arm64 is a different Node build.

One comparison proved PCG32, the emission bijection, the murmur3 pad hash,
UTF-8 encoding and LF discipline correct on both targets simultaneously.
Reference committed to `results/determinism/tier-tiny.json`.

### FAILURE — an unverified inference nearly destroyed the repo

The operator created a correctly-spelled folder alongside the misspelled one.
A `find` showed the new path existing, and Claude reported "rename picked up
cleanly — everything I wrote is intact under the corrected path."

The new folder was empty. Nothing had been renamed. The write that should
have caught it *did* fail, and the failure was misread as a mount-caching
quirk and moved past. The error survived several turns because nothing tested
it, and was caught only when the operator announced he was about to delete the
misspelled directory — which held all the work.

This is precondition E6 on live ammunition: a locally plausible inference,
believed because it was reasonable rather than because it was checked. It is
the same shape as the failures the oracle exists to catch, and it happened in
a conversation *about* that shape.

Consequence: **M0 needs an exit criterion that verifies content, not path
existence.** Pending.

### FAILURE — the implementation drifted from its own specification

Three generator behaviours — draw order, the emission bijection, and the pad
pool — were implemented and documented only in code comments. A Rust port
written from `DATASET-SPEC.md` §§1–8 would have produced valid-looking data
with different hashes, and the divergence would have been indistinguishable
from a PRNG bug.

Caught by the operator asking whether documentation was up to date, not by
any check. Fixed in spec v1.2 by adding §9, the normative generation
algorithm.

The general lesson is worth keeping: a contract that describes *what the data
is* is not sufficient for a port to reproduce it. It also needs *how it is
produced*, at the level of draw order.

### DECISION — two tranches in sequence, not interleaved

The Excel module's purpose is to demonstrate that the orchestration lessons
are not specific to writing software. That makes it a *validation* of Tranche
1 rather than a second worked example — and validation cannot be collected
before the thing being validated exists.

So: complete and demonstrate the programming track first, then open a second
tranche framed as "useful not only for application development, but also…".

An interleaved structure — each lesson appearing once in code and once in
Excel — was considered and rejected on the grounds that it would slow the
primary track for a benefit unavailable until that track is finished.

The transfer mapping worked out during this discussion is preserved in
`TUTORIAL-PLAN.md` Tranche 2 rather than acted on. Notably, T3 (choose a
problem carrying its own oracle) appears *stronger* outside code: accounting
identities are load-bearing rather than synthetic, unlike the datastring
redundancy designed into this dataset on purpose.

### DISCOVERY — `load` costs more than `work`

At the tiny tier, dataset C: `load` ≈ 95–101 ms, `work` ≈ 48 ms. Parsing the
file costs roughly twice what sorting it does, before any algorithm has been
optimised.

This is the phase decomposition earning its place on the first measurement.
A single total runtime would have hidden it, and every subsequent
"optimisation" of the sort would have moved a number that was never the
bottleneck. It also sharpens what the Rust comparison will actually be about:
if `load` dominates, zero-copy parsing matters more than a faster sort.

### CORRECTION — peak RSS is process-lifetime, so memory is only valid at repeat = 1

The first manifests reported `peak_rss_bytes` inside each entry of the `runs`
array, which reads as per-run memory. It is not. `maxRSS` is a
process-lifetime high-water mark, so it only ever rises: observed climbing
130 → 177 → 229 → 229 MB across four runs of identical work, as each run
allocated a fresh copy before GC reclaimed the previous one.

Comparing that figure between cells run at different repeat counts would have
produced a confident memory ranking that measured GC timing rather than
memory use.

Fixed: the per-run field is renamed `rss_high_water_after_run_bytes` — named
for what it is — and the manifest carries a single `peak_rss_bytes` plus
`memory_measurement_valid`, true only when `repeat === 1`. The CLI prints
`(INVALID: repeat>1)` rather than a bare number.

This is exactly the failure `rss-probe` exists to prevent, recurring one level
up: a number that looks authoritative and means something other than what a
reader will assume. Verifying the instrument does not immunise you against
misusing it.

### DECISION — warm figures are minima, not means

A warm run was observed at 103 ms among 50 ms neighbours — a GC pause folded
into the measurement. A mean would have absorbed that interruption into the
algorithm's reported cost.

The manifest reports `work_warm_min` alongside `work_warm_spread`, so the
noise is visible rather than averaged away.

### DISCOVERY — aos and soa produce byte-identical output

The control cell handles both load modes: `aos` sorts an array of row objects
directly; `soa` sorts an index permutation and gathers the columns. Different
representation, different comparator implementation, different strategy — and
the emitted files are byte-identical, because both implement the same declared
total order.

That is a free differential test, and it arrived as a side effect of
supporting two representations rather than by being designed in.

Also settled: **a cell must not import the oracle's comparator.** Sorting with
the same function the oracle checks with would make I3 vacuous — it would only
ever confirm that a function agrees with itself. The cells implement the
declared order independently, and that independence is what gives the check
its value.

### CORRECTION — the memory figure was wrong a third time, and the third was introduced by the second's fix

Running the control cell on win32-x64 produced a manifest with two numbers
that should have been nearly equal and were not:

    peak_rss_bytes                    177,741,824   (170 MB)
    rss_high_water_after_run_bytes    125,091,840   (119 MB)

Nothing runs between them except the invariant checks — and `digest()` walks
the full record set twice while `checkI1` and `checkI3` walk it again. So
**52 MB of oracle cost was being reported as the cell's memory use.** The
figure would have varied with the checker rather than with the cell, and a
cell whose output happened to be more expensive to verify would have looked
memory-hungry.

Fixed by sampling peak RSS immediately after the last run's phases and before
any check. The two figures now agree exactly.

### The pattern is the finding

The same failure has now occurred three times on the same quantity:

1. **Units assumed from documentation.** Caught by building `rss-probe`
   before taking any measurement. Node normalises to kilobytes; native code
   does not.
2. **Process-lifetime reported as per-run.** Caught by reading a manifest and
   noticing a number that only ever rose across identical work.
3. **The verifier's allocations counted as the subject's.** Caught by the
   operator running the cell and two fields in one manifest disagreeing.

Every instance produced a number that was *precise, reproducible, and
labelled correctly according to its own code* — and meant something other
than what a reader would assume. None was a bug in the sense of a crash or a
wrong calculation.

**And the third was introduced by the fix for the second.** Moving the sample
point to solve one scoping error created another, because the label
`peak_rss_bytes` stayed the same while the boundary it described moved.

The lesson for T1 is therefore stronger than "verify your instrument once
before you start". A measurement's meaning is set by *where its boundary
falls*, that boundary moves whenever the surrounding code changes, and the
name never moves with it. `peak_rss_includes` is now an explicit field in the
manifest for exactly this reason: the scope is recorded next to the number
rather than left to be inferred from the code that produced it.

### DISCOVERY — the collation trap is identical across platforms

The oracle self-test reports **4,851 inversions** for a `localeCompare`-ordered
`C` on linux-x64 (node 22.23.2), win32-x64 (node 24.6.0) and darwin-arm64
(node 24.15.0). Identical, not approximately equal.

This was not a planned check. `localeCompare` uses ICU collation data bundled
with each Node build, and nothing guaranteed that three different builds on
three platforms would agree on where `Z` sits relative to `a`. They do.

Consequence for the tutorial: 4,851 is a stable fact that can be stated
outright rather than an observation needing a per-platform caveat. Consequence
for the project: the byte-vs-locale trap behaves identically everywhere, so a
port that reaches for locale collation fails the same way on every target
rather than only on some — which is better, because a fault that appears on
one platform only is the kind that ships.

### OBSERVATION — not a measurement

darwin-arm64 (M4 Pro) against win32-x64 (i9-13900F), dataset C, tiny tier:

    load    54.9 ms   vs   79.6 ms
    work    43.5 ms   vs   50.3 ms

The Mac is ahead on both phases despite far fewer cores. This is filed as an
**observation, not a finding**: different Node versions, different operating
systems, a single cold run each, no repeat, and the smallest tier. It is the
architecture axis showing signs of life, nothing more.

Recorded deliberately in this form. Treating a suggestive number as a result
is the same error as the three RSS corrections above — the difference between
a measurement and a number you happen to have is whether you can say what it
excludes.

### DISCOVERY — single-run variance is 13%, and it ate one of two "results"

The RSS fix verified on darwin-arm64: `peak_rss_bytes` 140,427,264 against
`rss_high_water_after_run_bytes` 140,378,112 — 48 KB apart, the object
construction between the two sample points. Previously 45 MB.

The more useful finding came free. Two cold runs on the **same machine, same
input, same code**:

    phase      run 1     run 2    spread
    work      43.5 ms   49.1 ms    +13%
    load      54.9 ms   61.5 ms    +12%
    startup   13.9 ms   19.6 ms    +41%

The observation filed above — M4 Pro apparently beating the i9 on `work`,
43.5 ms against 50.3 ms — is a **14% gap against 13% single-run noise**. It
was never a result. Run 2's 49.1 ms lands within 2.3% of the Windows figure.

The `load` difference survives: 61.5 vs 79.6 ms is 23% against 12% noise.
So of two apparent architecture differences, one is real and one was an
artefact of running each machine once.

Three consequences, all now binding:

1. **No single-run comparison is admissible.** Every benchmark cell reports
   `repeat` with the spread visible, and `work_warm_spread` exists so a
   reader can see whether a difference clears the noise floor.
2. **A difference must exceed the observed spread before it is called a
   difference.** The comparison table in the final tutorial needs the noise
   floor beside it, or every reader will do what I nearly did.
3. **`startup_ns` at 41% spread is close to useless at this scale** and
   should be reported as a distribution over many runs, or not compared at
   all. It is excluded from every phase, so nothing depends on it — but it
   should not be presented as though it means something.

Filing the earlier comparison as an *observation* rather than a *finding* was
correct, and this quantifies why. The discipline is cheap. The alternative is
a tutorial asserting an architecture advantage that a second run would have
falsified.
