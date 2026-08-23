# Tutorial Plan

The deliverable is an **ordered set of tutorials** for software developers —
some teaching a lesson, some walking a worked example, most doing both. The
code in this repo is not the product. It is the specimen the tutorials
dissect.

Delivered in two tranches, in sequence. **Tranche 1 is the whole of the
current work and must be complete and demonstrable before Tranche 2 begins.**

---

## The ordering principle

**Build order is not teaching order, and conflating them is the most common
way a technical tutorial becomes unreadable.**

This repo was built in dependency order — verify the instrument, then
generate the data, then build the checker, then write the implementations —
because that is what the work required. A reader does not learn that way. A
reader needs the *problem* before the machinery that solves it, and needs to
watch something fail before being told how to prevent it.

`LOG.md` records chronology, which is the right shape for evidence and the
wrong shape for a reader. This document is the reordering, and it exists
because the mapping from "what happened" to "what it teaches" is exactly what
gets lost if it isn't written while the reasons are fresh.

## Two kinds of entry

**Lesson** — a principle, argued, with the concrete moment it was earned as
its evidence. Short. The reader should be able to apply it to work that has
nothing to do with sorting.

**Worked example** — a thing built end to end, with the commands, the output,
and the decisions visible. Long. The reader should be able to reproduce it.

Most entries are a lesson with a worked example attached. The lesson is what
survives; the example is what makes it believable.

## The rule that follows

**Each tutorial is written when its material completes, not at the end.**

M8 as originally stated treats synthesis as one final step. That is wrong for
an ordered set: it would mean reconstructing six tutorials' worth of
reasoning from a git log months later, which is the failure M8 itself
prohibits for performance claims. Write each one as its milestone closes,
while the alternatives that were rejected are still recallable.

Correction filed against M8 in `MILESTONES.md`.

---

## Tranche 1 — the programming track


Status is `earned` when the material and evidence exist, `written` when the
tutorial does, `pending` when the work has not happened yet.

### T0 · Orchestration fundamentals
**Lesson.** Boundaries, contracts, gates. The decomposition test, pipeline
versus barrier, why the author cannot verify their own work, and when not to
orchestrate at all.
**Status: written** — published as the Agent Orchestration Workbook artifact.
**Stale:** predates every lesson below and should be revised once T1–T6 exist.

### T1 · Verify the instrument before you measure
**Lesson + worked example.** An unverified measurement is worse than none,
because it looks authoritative. Build the probe first.
**Artifact:** `packages/harness/rss-probe/`.
**Evidence:** LOG 2026-08-22, *RSS units vary by access path*. The probe
falsified the measurement contract before a single benchmark ran — Node
normalises to kilobytes everywhere via libuv, native code does not, and the
same `getrusage` call returns bytes on Darwin and kilobytes on Linux. A Rust
cell and a Node cell would have disagreed by 1024× with neither looking wrong.

**The lesson is larger than the title, and the material for it is unusually
good.** The same quantity was measured wrongly three separate times — units
assumed from documentation, process-lifetime reported as per-run, and the
verifier's allocations counted as the subject's — and the third was
*introduced by the fix for the second*. Every instance was precise,
reproducible, and correctly labelled by its own code.

So the tutorial should not argue "verify your instrument before you start".
It should argue that a measurement's meaning is set by where its boundary
falls, that the boundary moves whenever surrounding code changes, and that
the name never moves with it. See LOG, *the pattern is the finding*.
**Status: earned.**

### T2 · Build the checker before the implementation
**Lesson + worked example.** Writing the oracle first found that the sort
specification was incoherent — it required stability against deliberately
shuffled input, so there was no unique correct output to check against. Had
the sorts been written first, they would have been "verified" against a
criterion that could not distinguish right from wrong.
**Artifact:** `packages/oracle/`, especially `oracle.selftest.js`.
**Evidence:** LOG, *the sort specification was incoherent*; spec v1.1 §6.
**Status: earned.**

### T3 · Choose a problem that comes with its own oracle
**Lesson.** Verification is the part everyone skips, and the cheapest way to
stop skipping it is to pick a problem where correctness is structurally
checkable. Self-describing records make any sort, partition or join verifiable
in one linear pass with no reference implementation and no golden file — which
is what makes it safe to fan work out across many agents.
**Artifact:** `DATASET-SPEC.md` §3, the deliberate column 1–4 / column 5
redundancy.
**Status: earned.**

### T4 · A deterministic generator is a free cross-platform differential test
**Lesson + worked example.** One comparison proved PCG32, the emission
bijection, the pad hash, UTF-8 encoding and LF discipline simultaneously
correct on x86-64 and arm64.
**Artifact:** `packages/generator/`, `verify-determinism.js`,
`results/determinism/`.
**Evidence:** LOG, *three-platform byte identity*.
**Also covers:** two implementations of PCG32 — limb for speed, BigInt for
obvious correctness — asserted equal. The same differential pattern at the
smallest possible scale.
**Status: earned.**

### T5 · A contract that describes the data is not enough to reproduce it
**Lesson.** Draw order, emission order and padding were implemented and
documented only in code comments. A port written from the specification would
have produced valid-looking data with different bytes, and the divergence
would have been indistinguishable from a PRNG bug. A reproducibility contract
needs *how it is produced*, not only *what it is*.
**Artifact:** spec v1.2 §9.
**Evidence:** LOG, *the implementation drifted from its own specification* —
caught by a question, not by a check.
**Status: earned.**

### T6 · Enforcement is structural; instructions are probabilistic
**Lesson.** Instruction-following degrades under long context and locally
plausible reasoning. Gate by reversibility, not by importance: gate at push
rather than at commit, and isolate rather than restrict.
**Evidence:** precondition E6, and LOG, *an unverified inference nearly
destroyed the repo* — a `find` showed a path existing, the rename was reported
as successful, the folder was empty, and the error survived several turns
because nothing tested it. It happened during a conversation about that exact
failure shape.
**Status: earned.** The strongest material in the set, because it is a live
failure rather than a constructed one.

### T7 · The first fan-out
**Worked example.** Several JS algorithms built concurrently against a frozen
contract. Pipeline versus barrier, and why a fan-out must collapse into a
result rather than into N summaries.

**Artifacts:** `packages/harness/conformance/` (the admission gate),
`docs/DELEGATION.md` (how a brief is written).

**Material already earned, before the fan-out completed:**

- *A good contract can remove the need for isolation.* Worktree isolation was
  planned. It turned out unnecessary: each agent owns exactly one new file and
  cell discovery is filesystem-based, so there is no shared file to contend
  over. Decomposing so agents never touch the same thing beats isolating them
  after they do.
- *The conformance suite asserted a property it did not have* — it passed only
  for the cell it was written against, which is the exact thing it existed to
  prevent. Found by the first agent to add a second cell. A checker is not
  exempt from needing to be checked.
- *Unbounded iteration in a brief*, caught in review rather than by running
  it. The only error class in this project where review was cheaper than
  execution, because running it is what makes it expensive.
- *Asking agents what was ambiguous returns defects.* The first cell returned
  four, in the harness rather than in its own work.

**From the fan-out itself:**

- *The headline.* Three cells were built and verified correctly, and every
  timing was worthless — the agents benchmarked on the machine a written
  precondition forbids. **A precondition that is not enforced is a comment.**
  E8 existed, was accurate, and was ignored, and the agents blamed the
  contract rather than their host because nothing told them otherwise.
- *The admission gate is the highest-leverage place for an undetected defect.*
  Three agents found three separate defects in the conformance suite, each by
  the act of adding a cell. A wrong cell fails one row; a wrong gate silently
  certifies every row.
- *Adversarial verification is not ceremony.* It caught an implementer's
  reported defect being factually wrong, and an overstated verification claim
  ("3M+ values" against a reproducible 1.9M). Neither was reachable by any
  mechanical check.
- *A permitted negative answer costs nothing and buys accuracy.* `workers` was
  predicted to be impossible and was not. Being wrong was free because
  `blocked` was an allowed outcome rather than a failure.
- *The bound was never reached, which is not evidence it was unnecessary.*
  Attempts used were 1, 2, 2 against a budget of 5. The run that needed it did
  not happen; the limiter cost one paragraph.

**Status: in progress (M5). Correctness half done, measurement half not.**

### T8 · Adding a runtime costs a row, not a project
**Worked example.** The Rust row, then C++. Tests the claim that a correct
contract makes a new runtime an extension of the work list rather than new
work. The claim is only worth anything once it has been tried.
**Status: pending M6.**

### T9 · Merge tactics and their failure modes
**Worked example.** Inner, left, anti and full joins over a 1:N relationship
with a type boundary on the key. Cardinality identities catch the errors that
produce output of the right shape and the wrong size.
**Status: pending M7.**

### T10 · Gating a stage that has no oracle
**Lesson.** Prose cannot be differential-tested. Code samples get extracted
and executed; performance claims get regenerated from committed manifests.
An ungated synthesis stage produces a confident, plausible, wrong tutorial —
which is the same failure as T2's, one level up.
**Status: pending M8.**

---

## Note on sequence

T1 through T6 are all earned and none of them required a sorting algorithm to
exist. That is not an accident of scheduling: **the transferable lessons come
from the scaffolding, not from the subject matter.** The sort-and-zip problem
is the vehicle, and a reader who never sorts anything should still leave with
T1, T2, T3, T5 and T6.

T7 through T10 are where the subject matter finally earns its place, because
they need real implementations, real measurements and real merge failures to
say anything.

---

# Tranche 2 — beyond application development

**Deferred until Tranche 1 is complete and demonstrable.** Nothing here is
scheduled, and no decision below is settled. It is recorded now only because
the reasoning is cheap to preserve and expensive to reconstruct.

## Purpose

Tranche 1 could be read as advice about building software. Tranche 2 exists to
show it is not — that the same orchestration discipline applies to a complex
problem with no code in it, framed as *"this is useful not only for
application development, but also…"*.

A structured financial model: a consolidation workbook, workbooks supplying
data, and per-jurisdiction tax calculation workbooks over synthetic
authorities with rule sheets kept in-repo. The N-identical-items fan-out with
per-item verification, in a domain where the fan-out is the natural shape of
the work rather than an imposed one.

## Why this is a real test rather than a restatement

The lessons from Tranche 1 either transfer or they are programming folklore
that happened to be dressed as principle. Provisional mapping:

| Lesson | Form outside code |
|---|---|
| **T1** verify the instrument | Excel's instrument defects are well documented: IEEE-754 display rounding, the deliberate 1900 leap-year bug, text-vs-number coercion on import. A probe workbook establishing what this build actually does with these value types, before any model logic exists. |
| **T2** build the checker first | The checks-and-ties sheet. Every competent modeller knows to have one; most still build it after the model has taught them what they wish they had checked. |
| **T3** a problem with its own oracle | Accounting identities. Assets = liabilities + equity; opening + additions − disposals = closing; debits = credits. |
| **T5** the contract must describe production | "Column C is revenue" tells a downstream workbook nothing about period convention, currency, or rounding order — three things that silently produce different numbers from the same inputs. |
| **T6** enforcement is structural | Cell protection, named ranges and data validation, versus a note in row 1 asking people not to overwrite the formula. |

**T3 is stronger here than in Tranche 1.** The datastring redundancy in
`DATASET-SPEC.md` is synthetic — the oracle was designed into the data
deliberately. Accounting identities are load-bearing: they exist because the
domain requires them, they are already present in every model ever built, and
almost nobody exploits them systematically as a verification gate. That is a
better demonstration of the principle than anything constructible.

## Open question — the model structure

Unresolved, and it is a genuine tension rather than a detail.

A **leveraged lease** (USLL/JLL — aircraft, rail fleets) is expert-verifiable
and reader-opaque. The operator can spot a wrong answer instantly, which
supplies the expert oracle the tax fan-out otherwise lacks. But a developer
audience decoding what a sinking fund is will not absorb the orchestration
lesson underneath it.

A **simpler structure** — a single asset lease with debt amortisation,
depreciation, and tax across jurisdictions — keeps the roll-forwards and
balance identities that make it verifiable while cutting the conventions that
need explaining.

Leaning toward the simpler structure: expert judgment still catches a wrong
depreciation roll-forward whether or not the instrument is exotic, whereas
reader accessibility cannot be recovered afterwards. Not decided.

## Structure note

An earlier proposal to interleave the two tranches — each lesson appearing
once in code and once in Excel — was rejected. It would delay Tranche 1 for a
benefit that cannot be collected until Tranche 1 exists.
