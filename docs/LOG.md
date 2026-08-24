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

### DISCOVERY — the first delegated cell found four defects, one of which defeated the conformance suite entirely

A single agent was given the contracts, the reference cell, and a brief. No
conversational context. It produced `packages/js-sorts/cells/merge.js` — a
bottom-up iterative merge sort, both load modes, byte-identical output to the
reference on all three datasets, all invariants passing.

That part worked. The valuable part is what it found.

**1. The conformance suite only passed for the cell it was written against.**
`baseSpec` hardcoded `algorithm: 'builtin'`, so every case handed the new cell
an algorithm it does not offer and `validateSpec` correctly rejected it with
exit 2. Six of ten cases failed for a reason that had nothing to do with the
cell.

This is precisely the property `BOUNDARY.md` §5 claims the suite exists to
test — *"a new runtime can be dropped in and verified without the harness
being touched"* — and the harness needed touching by the second cell. The
suite asserted a property it did not have.

Found at the cheapest possible moment: the first time a second implementation
existed. Fixed by deriving the algorithm from the cell's filename.

**2. Conformance case C2 could not fail for the reason it was looking for.**
It checked that stdout parsed as JSON. Empty stdout parses vacuously, so any
cell that exited before producing output scored a clean pass on "stdout
carries the manifest and nothing else". Now asserts the happy path exits 0 and
stdout is non-empty first.

**3. `BOUNDARY.md` §2's graceful-degradation clause was unimplementable.** The
document said a cell that cannot offer the requested `load_mode` uses its own
and notes it. The runner passed `job.load_mode` straight to the loader, which
threw on an unknown mode and became exit 3 at stage `load`. Doc and code
disagreed and nothing had exercised the path. Fixed in the runner; the
manifest now reports the mode **actually used** alongside the one requested,
because reporting the request would let a summary label a run `soa` that ran
`aos`.

**4. Phase ownership of the defensive input copy was unspecified.** Both
implementations charged it to `work` and both had to guess. Now stated.

### The pattern, again

Every one of these is the same shape as the RSS corrections: something
precise, reproducible, and correctly labelled by its own code, asserting a
property it did not have. The conformance suite is the sharpest instance,
because its entire purpose was to catch exactly this class of error in other
people's cells, and it contained one.

**A checker is not exempt from needing to be checked.** The oracle self-test
was built on that principle and the conformance suite was not, because by then
the principle felt established. Writing `oracle.selftest.js` and then not
writing the equivalent for the conformance suite is the error.

### OBSERVATION — merge vs the built-in, correctly not reported as a difference

The agent applied `MEASUREMENT-CONTRACT` §5a without being told to:

| ds | merge warm_min | merge spread | builtin warm_min | builtin spread |
|---|---|---|---|---|
| A | 43.1 ms | 12.5 ms | 47.0 ms | 5.4 ms |
| B | 27.3 ms | 9.4 ms | 36.9 ms | 2.5 ms |
| C | 41.3 ms | 15.6 ms | 44.9 ms | 7.0 ms |

Merge is nominally 4–10 ms faster; merge's own spread is 9–16 ms. **The gap
does not clear the noise floor and was not reported as a difference.**

What does clear it is the cold/warm asymmetry: merge's cold run is 1.6–2× its
warm minimum, the built-in's is 1.1–1.3×. That is the JS merge loop being
tiered up by the JIT against TimSort already being compiled C++ — which is the
asymmetry `MEASUREMENT-CONTRACT` §4 predicted, showing up in the first cell
that could exhibit it.

### CORRECTION — an unbounded loop in a brief, caught in review before the fan-out ran

The first fan-out script was rejected by the operator with one requirement:
put a limiter on looping. The brief contained the line

    Iterate until all three hold.

That is not an instruction. It is an unbounded loop with no exit condition,
handed to an agent that has no way to know stopping is permitted.

The likely victim was identified in advance: the `workers` cell.
`SharedArrayBuffer` cannot hold JavaScript strings and every record contains
them, so a genuinely parallel string sort may be impossible within the
constraints. An agent told to iterate until it passes, on a task that cannot
pass, does not stop — and the failure is never reported, because it is still
"in progress" when something else kills it.

Three loop sites existed and only one was bounded:

| Site | Before | After |
|---|---|---|
| inside an implement agent | "iterate until all hold" | 5-attempt budget, tool-call ceiling, `blocked` as a legitimate outcome |
| verify agent | single pass — already bounded | made explicit: verification never iterates |
| implement ↔ verify retry | did not exist | kept non-existent, and stated as a rule |

The third is the tempting one. Feeding a failed verdict back for another
attempt reads as diligence, and it is how a two-stage pipeline acquires an
unbounded loop that neither stage contains. **A rejected cell is a result.** A
human decides whether to re-run it, and that decision is the bound.

Written up as `docs/DELEGATION.md` — the rules for briefing an agent that
cannot see the conversation. Companion to `BOUNDARY.md`: that one governs what
crosses a *process* boundary, this one what crosses a *context* boundary.

Two rules in it are worth flagging as non-obvious:

- **`blocked` must be explicitly permitted in the brief.** An agent that
  believes only success is acceptable will manufacture it — weaken a check,
  claim partial work as complete, or grind past usefulness. A well-explained
  impossibility is often the most valuable thing a delegated agent returns.
- **Ask for the defects explicitly.** Without a sentence inviting them, an
  agent optimises for appearing successful and the ambiguities never surface.
  With it, the first delegated cell returned four.

Worth recording how this was caught: **by reading the brief, not by running
it.** No mechanical check would have found it. Every other correction in this
log came from execution; this one came from review, and it is the only class
of error where review is cheaper — an unbounded loop is expensive precisely
because running it is how you discover it.

## The first fan-out — 3 cells, 6 agents, 0 errors

`quick`, `radix` and `workers` implemented and adversarially verified in a
bounded pipeline. All three confirmed. Attempts used: 1, 2, 2 — nobody
approached the budget of 5, nobody reported blocked. Five cells now pass all
ten conformance cases, byte-identical in both load modes, verified
independently after the run.

`workers` was expected to come back blocked and did not. It is a real
`SharedArrayBuffer` + `Atomics.wait` parallel sort: shared `Float64Array` of
primary keys and `Int32Array` index permutation, workers sorting disjoint
ranges, merge and string tie-break resolution on the main thread where the
strings live. `threads: 1` honoured. The prediction was wrong, and being
wrong cost nothing because `blocked` was a permitted answer rather than a
failure.

### FINDING — the benchmarks ran on the machine a precondition forbids

Every timing the fan-out produced is worthless, and the correctness results
are entirely sound.

The agents benchmarked on `linux-x64, 2 logical cores, 3.8 GB` — the agent's
own sandbox. `MILESTONES.md` E8 states plainly that this machine never runs a
benchmark. It goes on doing so because `device_bash` lands there and nothing
stopped it.

Both agents independently reported warm spreads of **16–200% of warm_min**
against the contract's 13% floor. Both concluded the **contract** was wrong.
It was not. They were on the wrong machine, and the contract's figure was
measured on a real one.

The failure is not that the agents were careless. They reported the anomaly
clearly and one of them explicitly declined to name any winner, writing *"the
work phase is not resolvable at repeat=5 in this environment"*. They simply
had no way to know the environment was inadmissible, because nothing in the
manifest, the runner or the brief said so.

**E8 was written down, was accurate, and was ignored — because a precondition
that is not enforced is a comment.**

Fixed by making it a gate. A host is a benchmark host only if it says so:
`ORCH_BENCHMARK_HOST=1` or a `.benchmark-host` marker at the repo root.
Nothing is auto-detected — "is this a real machine" has no reliable test, and
a wrong guess silently certifies numbers that mean nothing. Manifests now
carry `benchmark_admissible` and `admissibility_reason`, and the CLI prints
`NOT A BENCHMARK HOST` rather than leaving a reader to infer it from the
platform block.

Timings are still recorded when inadmissible. They are a useful smoke test.
They are simply not a measurement, and now the manifest says which it is.

### FINDING — the noise floor is a per-host property, stated as a project constant

`MEASUREMENT-CONTRACT` §5a fixed the floor at 13%, measured once on
darwin-arm64. Observed on the sandbox: 16–46% (`quick`), 38–200% (`radix`).

A threshold every comparison in the project is bound by cannot be a single
number measured on one machine at one tier. It is a property of the host, the
tier and the load, and it must be measured where the comparison is made — the
same argument as `rss-probe`, one level up. A `noise-probe` is now owed.

The related defect, also reported: §5a's decision rule is stated in
incommensurable units. "A difference must exceed the observed spread" compares
a spread in milliseconds against a floor quoted as a percentage, and never
reconciles them.

### FINDING — the conformance suite was defective a third and fourth time

Every cell added has found the admission gate broken in a new way:

| Found by | Defect | Effect |
|---|---|---|
| scout (`merge`) | `algorithm` hardcoded to `builtin` | passed only for the cell it was written against |
| scout (`merge`) | C2 passed on empty stdout | could not fail for the reason it checked |
| `radix` | `dataset` hardcoded to `C` | A's string tie-break and B's all-numeric order never exercised |
| `radix` | C10 resolves its reference against `process.cwd()` | verdict depends on the working directory — proven: 1/10 fails when run from `/tmp` |
| `quick` | `load_mode` hardcoded to `aos` | a cell with a broken `soa` path passes all ten cases |
| both | §5 lists a `threads: 1` case the suite never built | the document describes a gate that does not exist |

**The admission gate is the highest-leverage place in the system for an
undetected defect.** A wrong cell fails one row. A wrong gate silently
certifies every row, and nothing downstream re-derives its verdict.

Three agents, three separate defects, each found by the act of adding a cell
rather than by review. The gate was never wrong in a way that made a good cell
fail; it was wrong in ways that made cells pass for reasons unrelated to
themselves.

### FINDING — adversarial verification earned its place twice

The verify stage was not ceremony. Two catches neither the implementer nor I
would have made:

- `quick` reported as a contract defect that *"the conformance gate never sets
  `load_mode`"*. **Factually wrong** — `run.js` sets it, hardcoded to `aos`.
  The substantive conclusion survived (only `aos` is ever exercised) but the
  claim as written was false, and it would have gone into this log as fact.
- `radix`'s header claimed digit extraction verified against BigInt over "3M+
  values". The verifier could reproduce 1,897,736. An overstated verification
  claim, caught by someone trying to reproduce it.

Both are the same species: a confident, specific, checkable statement that
nobody had checked. Neither was caught by any mechanical gate.

### CORRECTION — a delegation rule collided with a precondition

`DELEGATION.md` §6 tells verifiers to check scope with `git status`. On this
mount git cannot unlink, so every verify agent left a `.git/index.lock` behind,
and those locks collided with the operator's commits — one commit failed
silently and was only noticed because HEAD was checked against expectation.

The rule was written for a normal filesystem. E3 was not carried into it.
Fixed: verifiers use `git --no-optional-locks status`, which does not take the
index lock.

### CORRECTION — a verifier left residue it could not remove

Setting up a negative control, one verifier copied `radix.js` to
`packages/js-sorts/cells/.__nc_radix.js` inside the repo and could not delete
it (E3). It reported this itself, which is the only reason it was cleaned up.

Moved to `_to_delete/` — the documented fallback when the mount refuses
`unlink`. Two rules follow, now in `DELEGATION.md`: **scratch files go outside
the repo**, and **an agent that cannot clean up must say so in its report**.

### The bound was never reached, and that is not evidence it was unnecessary

Attempts used: 1, 2, 2 against a budget of 5. Nobody blocked. It would be easy
to conclude the limiter was unnecessary.

It was not tested by this run. `workers` — the cell the bound existed for —
succeeded on attempt 2. The limiter is insurance against the run where it does
not, and the cost of carrying it was one paragraph in a brief.

## Benchmark admissibility — three mechanisms in one sitting

The gate that enforces E8 was rebuilt three times before it worked. Each
revision fixed a real flaw in the previous one, and **every flaw was invisible
until a specific environment exercised it.** None would have been caught by
review.

### v1 — a marker file at the repo root. Wrong for this topology.

*"A host is a benchmark host if `.benchmark-host` exists."* Correct for a
normal setup, and wrong here.

**The agent's sandbox reaches the operator's disk through a mount, so it sees
the operator's files.** A bare marker would have declared the sandbox a
benchmark host — restoring precisely the failure the gate was built to
prevent.

The operator placed his marker outside the repo, in a sibling directory, on
the reasoning that a file which cannot be committed is better than one that
relies on `.gitignore`. That instinct was right and it exposed the flaw: the
obvious fix was to widen the search path, **and widening the search path is
what would have shipped the bug.** The sandbox would have found the marker and
declared itself admissible.

A file cannot answer *"which machine is executing"* when the filesystem is
shared. It answers a question about the disk.

### v2 — keyed on hostname. Process-scoped, and not stable.

Hostname belongs to the process, not the disk, so the sandbox correctly
refuses even while looking straight at the operator's marker file. Verified
both directions: with `claude` listed it reports ADMISSIBLE, without it NOT
ADMISSIBLE, the file visible throughout.

Two further defects surfaced immediately:

- **Case.** Windows reports `Xenomorph9`; a marker written `xenomorph9` would
  have failed to match with a message that reads exactly like a missing entry.
  Matching is now case-insensitive on both sides.
- **Stability.** The Mac reports `shi-fnmy64ktm2.localdomain`. The
  `.localdomain` suffix is DHCP-derived: the same machine can report `.local`
  on another network, or a different name after a lease change or a VPN
  connection. **If it shifts, the machine silently becomes inadmissible — and
  the failure looks exactly like the gate working correctly.**

So hostname fixed *scope* and introduced *fragility*. I checked the first
property and not the second.

### v3 — an environment variable, for hosts where hostname is unstable

`ORCH_BENCHMARK_HOST=1` is both process-scoped and stable. It costs
discoverability — it lives in a shell profile rather than in the project — and
buys immunity to network conditions.

Current state, and it is deliberately not uniform:

| Host | Mechanism | Verdict |
|---|---|---|
| `Xenomorph9` (win32-x64, 32 cores, 63.7 GB) | marker file lists the hostname; a fixed machine name | ADMISSIBLE |
| Mac (darwin-arm64, 14 cores, 24 GB) | `ORCH_BENCHMARK_HOST=1` in `~/.zshrc` | ADMISSIBLE |
| `claude` (agent sandbox, 2 cores, 3.8 GB) | neither | **NOT ADMISSIBLE** |

That third row is the point. A gate that admits everything is not a gate, and
the check that matters is whether it **discriminates**, not whether it exists —
the same standard `oracle.selftest.js` had to meet.

### A disclosure correction

I had suggested that since `.benchmark-host` cannot be committed, its
*expected contents* should be recorded in the repo so a rebuilt machine could
be restored.

Wrong for the Mac. `shi-fnmy64ktm2.localdomain` is a corporate-managed machine
name and this repo is headed for a public audience. The env-var route avoids
writing anything identifying, which is a second reason to prefer it there.

**The repo documents the mechanism. It does not enumerate the hosts.**

### The pattern

Three mechanisms, three flaws, one sitting. Every one was a correct solution
to the problem as understood at the time, defeated by a property of the
environment that had not yet been examined:

1. a shared filesystem, so a file is not a machine
2. a mutable hostname, so a name is not an identity
3. a public repo, so a configuration value is not private

The recurring shape, and it is the same one as the RSS corrections: **the
mechanism was never wrong about what it measured. It was wrong about what that
measurement meant in an environment nobody had checked.**

### FINDING — two variances, and the project was reporting the smaller one

`noise-probe` was built to make §5a's floor a measured per-host quantity
rather than a constant. It found something more useful than a number.

`work_warm_spread` measures variance **inside one invocation**, where page
cache, JIT state and allocator arena are all held constant. But cells are
compared **across** invocations — each cell is its own process, launched
separately. None of those things are constant between two cells being
compared.

So the governing floor for any cell-vs-cell comparison is between-process
variance, and nothing had measured it. On the agent sandbox, 8 invocations of
identical work:

    within-process   median 16.9%   (range 0.1% - 79.3%)
    between-process         22.3%
    between (load)          40.3%

Within-process variance flatters the instrument. An invocation that happens to
land on a warm cache reports 0.1% spread and looks precise — and the same
workload in the next process is 22% away. Reporting that 0.1% as the
measurement's precision would be true and completely misleading.

The floor is now the larger of the two, and a host with no `noise-probe`
result has no floor and therefore cannot host a comparison. Contract v1.5.

This is the same shape as everything else today: the figure was correct about
what it measured and wrong about what it meant — here, wrong about *which
comparison it was licensing*. §5a said "a difference must exceed the observed
spread" and never asked observed under what conditions.

### CORRECTION — four conformance defects fixed, gate now 12 cases

All confirmed by running them, all fixed:

- **cwd-dependence.** C10 resolved its reference with `resolve('results/...')`,
  so the gate's verdict depended on the working directory — proven by running
  it from `/tmp`, where it failed while the cell was unchanged. Now resolved
  from the script's own location. Re-verified: identical result from the repo
  root and from `/tmp`.
- **Single dataset.** Every case hardcoded `C`. A's byte-wise string tie-break
  and B's all-numeric order were never exercised by the gate that admits cells
  into the matrix. C10 and C11 now cover all three datasets.
- **`soa` never exercised.** `load_mode` was hardcoded to `aos`, so a cell with
  a broken `soa` path passed every case. C11 covers it.
- **A documented case that did not exist.** BOUNDARY §5 listed `threads: 1`
  from the start; the suite never implemented it. Now C12 — and it matters most
  for the parallel cell, which must run single-threaded on request.

Two runner defects fixed alongside:

- `--repeat` defaulted to 3 while BOUNDARY documents 1, so anyone running a
  cell by hand silently got `memory_measurement_valid: false` and no
  explanation.
- **Cells had no way to write to `notes`.** BOUNDARY §3 requires a value a cell
  cannot produce to be `null` "with a line in `notes`", but `algorithm()`
  returned only a loaded object. Reported independently by two verifiers, on a
  parallel cell that silently clamped its own thread count with no channel to
  say so. `algorithm()` now receives a note callback.

All five cells pass all 12 cases.

### CORRECTION — the noise floor conflated two statistics, and the fix cost no re-runs

`noise-probe` reported `max(within_process.median, between_process.spread)` as
the resolution floor. Wrong: those measure different things.

`within` is the spread of individual warm repeats. `between` is the spread of
their **minima** across invocations — and a minimum is inherently less variable
than the samples it is drawn from. Taking the larger inflates the floor with a
figure that governs nothing.

The statistic a comparison actually uses is `work_warm_min`. The floor is how
much *that* moves between invocations. Within-process spread is a
**convergence diagnostic** — it says whether the minimum has settled — and is
now reported as one.

Caught on darwin-arm64, where within (15.1%) exceeded between (11.5%) and the
inversion made the conflation visible. On the two noisier hosts the ordering
happened to hide it. A defect that is invisible on the machines where the
numbers are worse.

Corrected floors: **darwin-arm64 11.5%** (admissible, converged),
win32-x64 27.4% (inadmissible — empty marker file, needs one re-run),
sandbox 18.9% (correctly refused).

### The part worth keeping: raw data and derived summary must stay separable

The bug was in a **derivation**, not in a measurement. Every underlying figure
in the result files was correct throughout.

So the fix was `--recompute <file>`: read the measurements the file already
contains, redo the arithmetic, rewrite the summary. Windows' committed result
went 30.6% → 27.4% without re-running anything, and the Mac's stands as
measured.

Had the result file stored only its conclusion — a single `noise_floor: 0.306`
— both hosts would have needed full re-runs to fix an arithmetic error, and
the operator was already out of patience for a third round.

**Record what was measured. Derive what it means. Keep them separable.** Raw
data is expensive; arithmetic over it is free. This applies directly to the
benchmark manifests, which is why they carry per-run phase arrays rather than
only `summary_ns` — a decision made for legibility that turns out to be
insurance.

That is now three artifacts where the measurement was right and the
*interpretation* was wrong: peak RSS (three times), the noise floor, and the
fan-out's inadmissible host. None was a computation error. All were about what
a correct number meant.

## Both hosts measured — and the plan's benchmark machine is the wrong one

First two admissible noise floors, measured identically (10 invocations ×
repeat 5, dataset C, tiny tier), both converged:

| Host | Cores | RAM | Floor | `work_warm_min` |
|---|---|---|---|---|
| Apple M4 Pro, node 24.15.0 | 14 | 24 GB | **11.5%** | 39.7 – 44.3 ms |
| i9-13900F, node 24.6.0 | 32 | 63.7 GB | **21.9%** | 50.3 – 61.3 ms |

**The smaller machine is 1.89× quieter.** That is a finding about measurement
quality, taken the same way on both, and it stands on its own.

> **Corrected same day.** I read this as "Windows is the wrong benchmark
> machine" — an inversion of the M0 plan. The operator corrected the framing:
> cross-machine ranking is not the task at all. The question is *given a Mac,
> or given a Windows box, which scenario performs best and in what way.* Two
> independent matrices, never one table.
>
> Under that framing there is no inversion. Both machines run the scenarios;
> Windows additionally runs `large` because nothing else can hold it. That is
> a capability difference, not a ranking.
>
> The floor difference survives, reframed: it does not rank the machines, it
> determines **what each architecture can resolve.** Windows at 21.9% will
> find cell pairs indistinguishable that the Mac at 11.5% separates, and *"on
> this architecture these two scenarios are the same"* is a legitimate result
> a reader on that architecture actually needs.
>
> Cross-host comparison is now **prohibited** by contract §5c rather than
> regulated — which was the right disposal of the gap I had flagged.

### The speed difference is NOT a finding, and saying why matters

The same table shows the Mac 1.27× faster on `work_warm_min` minima. That gap
clears the floor — 26.7% against 21.9%, or 37.6% on medians — and it is still
not reportable as an architecture result, because it is **confounded**:
different architecture, different OS, *and different Node versions* (24.6.0 vs
24.15.0).

It is not "M4 Pro beats i9-13900F". It is "this whole stack beats that whole
stack", which is a much weaker claim and nearly useless for the tutorial.

**Gap in the contract:** `MEASUREMENT-CONTRACT` §5a governs comparing two
cells *on one host*. It says nothing about comparing across hosts, where the
floors differ, the runtime version differs, and clearing the larger floor is
necessary but nowhere near sufficient. Cross-host comparison needs its own
rule or an explicit prohibition. Currently it has neither, which means the
first person to put both columns in a table will draw a conclusion the
contract never licensed.

### Floor stability is itself unmeasured

The Windows floor moved **27.4% → 21.9%** between two runs of the same command
on the same host. Admissibility does not affect the physics, so that is 5.5
points of movement in the floor measurement itself — roughly a quarter of its
own value.

A threshold that varies by a quarter of itself is soft, and every comparison
in the project is about to be judged against it. Whether 10 invocations is
enough for the floor to converge has not been established; it was chosen
because it seemed reasonable.

The recursion is real and worth naming: **we measured the noise, and have not
measured the noise in the noise measurement.** At some point that terminates
in judgement rather than in data, and the useful discipline is to say where
you stopped rather than to pretend the floor is exact.
