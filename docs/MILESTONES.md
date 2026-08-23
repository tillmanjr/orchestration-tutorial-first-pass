# Milestones and Preconditions

Two things a tutorial usually leaves out, and both of which determine whether
anyone can reproduce it.

**Preconditions** are the environment facts this project was built inside.
None of them is in the code, several were discovered rather than chosen, and
each one changed a design decision. A reader whose environment differs must
know which of our choices were forced, so they can tell which to copy and
which to replace.

**Milestones** are the checkpoints, each with an entry condition, a
deliverable, and — most importantly — an **exit criterion that can be
checked mechanically**. A milestone whose completion is a matter of opinion is
not a milestone.

---

# Part 1 — Preconditions (the pseudo-externals)

## E1 · Two machines, deliberately unequal

Development on Windows / x86-64 / 64 GB. Demo on macOS / arm64 / 24 GB.

**Effect on design.** Tiers are sized so `mid` runs anywhere and `large` sits
deliberately past the point where naive JS meets Node's memory ceiling.
Benchmark manifests are *committed data*, so `large`-tier figures produced on
the big machine are displayed on the small one without being re-run. The
architecture difference stopped being an obstacle and became a second axis:
the same matrix on two architectures says more than either alone.

**If you have one machine:** you lose the architecture axis and the memory
wall. Keep the manifests-as-committed-data pattern anyway — it is what lets
any expensive result outlive the machine that produced it.

## E2 · GitHub as the bridge between machines

Chosen over file sync because `.gitignore` is honored, so build artifacts
never replicate between an ARM and an x86 checkout.

**Effect on design.** `.gitattributes` forces LF everywhere, because the
generator emits LF and the oracle compares bytes — a CRLF checkout would
corrupt every datastring on one platform only. `.donotdelete` markers keep
empty directories, with explicit `data/*` + `!data/.donotdelete` negations,
because a bare `data/` ignore stops git descending into the directory at all
and the marker would never survive a clone. Build output lives outside the
tree via `CARGO_TARGET_DIR`.

## E3 · The agent cannot delete files

Discovered, not chosen. The device bridge forbids `unlink` in mounted folders,
and this session has no tool to request deletion rights. It surfaced when git
could not remove its own lock files.

**Effect on design.** Every git command is run by the human. That is a real
cost, and it is also the approval gate Module 06 teaches, arriving
structurally instead of by discipline.

The deeper effect is better: **determinism converts deletion from a
destructive act into a cache eviction.** Everything under `data/` regenerates
byte-identically from a seed, so nothing under it is information — it is a
rebuildable artifact. A project whose expensive intermediates are reproducible
from a specification is a project where the delete permission barely matters.
That property is worth engineering for on its own merits.

## E4 · No Rust toolchain in the agent's sandbox

The agent's Linux sandbox has node, npm, git and python, but no cargo, and the
Rust distribution host is blocked by the egress proxy.

**Effect on design.** `cargo build --release` is a human step. This is
tolerable only because the boundary is a child process invoked *by path* — the
harness runs an existing binary and never needs to build one. A tighter
coupling (a native addon, a WASM module built during install) would have made
this precondition fatal instead of merely inconvenient.

**Generalization:** when part of your toolchain is outside the agent's reach,
put the boundary there. Loose coupling is not only an architecture preference;
it is what makes a heterogeneous environment workable at all.

## E5 · Two separate filesystems

The agent's device sandbox and its cloud container do not share storage. A
file written by one is invisible to the other.

**Effect on design.** One location per file, decided once, never mixed. The
repo lives on the device; nothing important is authored in the container.

## E6 · Instruction-following is probabilistic; enforcement must be structural

Established from the operator's direct experience over months of use, not from
theory. An instruction in a project file constrains behavior with high but not
unit probability, and it degrades under long context, competing instructions,
and locally plausible reasoning — a file *looks* stale, deleting it *looks*
like tidying, and the local justification defeats the global rule.

**Effect on design.** Gates are placed by reversibility, not by importance:

| Tier | Examples | Gate |
|---|---|---|
| Reversible, contained | write files, build, generate data, benchmark | **none** — agents must be free here or there is no orchestration to observe |
| Irreversible, contained | delete under `data/`, `bench-out/` | scoped grant; safe because the contents are regenerable (E3) |
| Irreversible, escaping containment | push, force-push, anything outside the tree | **hard gate, always** |

Two consequences worth stating as rules:

- **Gate at push, not at commit.** A commit is reversible, a local branch is
  reversible, a force-push is not. Gating the one operation that leaves the
  machine costs almost no autonomy.
- **Isolate rather than restrict.** Agents work in their own worktrees with
  full freedom; the merge is the gate. Do not constrain the agent — constrain
  what its mistakes can reach.

## E7 · Instruments are unverified until probed

Peak-RSS reporting differs by platform in *units*, not merely in value —
bytes on Darwin, kilobytes on Linux — and runtime-level accessors may
normalize or may not.

**Effect on design.** `rss-probe` is the first deliverable of the first
milestone, before any measurement is taken. A memory comparison built on an
assumed unit is worse than no comparison, because it looks authoritative.

## E8 · The agent's sandbox is small

The Linux VM the agent runs commands in has ~4 GB of RAM. It can generate and
verify the `tiny` tier; it cannot touch `mid` or `large`.

**Effect on design.** The agent writes and unit-tests code; the operator's
machines generate real data and run every benchmark. This is not a limitation
worth engineering around — it enforces a separation that is correct anyway,
since a benchmark run on a shared virtualised host is not a measurement.

---

# Part 2 — Milestones

Exit criteria are mechanical. If you cannot run a command that answers yes or
no, it is not an exit criterion.

## Status

| | Milestone | Status | Evidence |
|---|---|---|---|
| **M0** | Contracts drafted, repo bridged | **met** | clone on darwin-arm64 reproduces the tree; `git status` clean on both |
| **M1** | Instrument verified | **met** | `results/instrument/rss-probe.node.{win32-x64,darwin-arm64}.json` — and it falsified the contract, see LOG 2026-08-22 |
| **M2** | Walking skeleton green | **met** | `builtin` cell sorts A/B/C at tiny in both load modes; I1–I3 pass under independent oracle verification; manifests emitted with phases, cold/warm and RSS |
| **M3** | Determinism across platforms | **met** | `results/determinism/tier-tiny.json`; byte-identical on linux-x64, win32-x64, darwin-arm64. Re-check with `node packages/generator/verify-determinism.js` |
| **M4** | Contracts frozen; boundary written | not started | |
| **M5** | First fan-out — the JS row | not started | |
| **M6** | Second runtime — the Rust row | not started | |
| **M7** | Zip and merge | not started | |
| **M8** | Synthesis, gated | not started | |

Status is recorded here and nowhere else. A milestone is *met* only when its
exit command has been run on every platform the criterion names — not when
the code that would satisfy it exists.

## M0 · Contracts drafted, repo bridged

**Entry** Two machines; node and cargo on both; a GitHub account.
**Deliverables** Repo tree, `.gitattributes`, `.donotdelete` markers,
`DATASET-SPEC.md` v1 draft, `MEASUREMENT-CONTRACT.md` v1 draft, first commit
pushed.
**Exit** A fresh clone on the second machine produces a byte-identical working
tree, and `git status` is clean on both.
**Lesson** The contract precedes the code. Portability is validated while
there is nothing to port; retrofitted later it costs a weekend.

## M1 · Instrument verified

**Entry** M0.
**Deliverable** `packages/harness/rss-probe`.
**Exit** On each platform, the probe allocates and touches a known number of
bytes and reports a peak RSS within 10% of it. §5 of the measurement contract
is confirmed against reality, or corrected in the document.
**Lesson** Verify the instrument before the measurement.

## M2 · Walking skeleton green

**Entry** M1.
**Deliverables** Generator, canonical JS loader, oracle (I1–I3), the
built-in-sort control cell, manifest writer.
**Exit** `tiny` tier generated; I1, I2 and I3 pass; one schema-conforming
manifest on disk with a non-zero `work` phase and `startup_ns` reported
separately from all three phases.
**Lesson** One path end to end before any fan-out. You cannot orchestrate a
shape you have not yet traversed — this is §8 of the Workbook applied to
ourselves.

## M3 · Determinism proven across platforms

**Entry** M2 complete on machine A; repo cloned on machine B.
**Exit** SHA-256 of the three `tiny`-tier files is identical on both machines;
the oracle passes on both; the two manifests differ only in timing and
platform fields.
**Lesson** A deterministic generator is a free cross-platform differential
test. It proves PCG32, line-ending discipline and UTF-8 handling correct on
both platforms in a single comparison.

## M4 · Contracts frozen; the boundary written

**Entry** M3.
**Deliverables** `DATASET-SPEC.md` and `MEASUREMENT-CONTRACT.md` marked
frozen; the boundary document from Workbook §9.
**Exit** Both documents carry a frozen version stamp. The boundary document
names every field crossing in both directions, the error case included, and
states how each side is verified with the other absent.
**Lesson** Freezing is an event, not a mood. A contract that drifts mid-flight
fails silently until integration.

## M5 · First fan-out — the JS row

**Entry** M4.
**Deliverables** Several JS algorithms built concurrently in isolated
worktrees against the frozen contract, each verified independently.
**Exit** Every cell has a manifest and passing invariants; the merge required
no conflict resolution that changed behavior; the run summary states what was
dropped, if anything.
**Lesson** Pipeline versus barrier; isolation under concurrent mutation; and
that a fan-out must *collapse* into a result rather than into N summaries.
One runtime only — this exercises orchestration without also exercising a new
toolchain.

## M6 · Second runtime — the Rust row

**Entry** M5.
**Exit** Rust cells produce manifests; they agree with JS output on `tiny`
under the oracle; `work` phases are compared across runtimes, with the
boundary cost stated once in `BOUNDARY-COST.md` and excluded from every
comparison.
**Lesson** If the contract was right, adding a runtime costs a row rather than
a project. That claim is only tested by doing it.

## M7 · Zip and merge

**Entry** M6.
**Exit** I4 through I7 pass; the join cardinality identities hold against
independently computed key histograms; no-match semantics are documented per
join type.
**Lesson** Cardinality identities catch the errors that produce output of the
right shape and the wrong size — the ones that survive inspection.

## M8 · Synthesis, gated

**Entry** M7.
**Exit** The tutorial is assembled; every code sample in it has been extracted
and executed; every performance claim has been regenerated from committed
manifests rather than written from an agent's recollection.
**Lesson** Prose has no oracle, so the gate must be mechanical. An ungated
synthesis stage produces a confident, plausible, wrong tutorial.

> **Correction.** M8 as originally written treats synthesis as a single final
> step. That is wrong for an ordered *set* of tutorials: it would mean
> reconstructing several tutorials' worth of reasoning from a git log months
> later, which is precisely the failure this milestone prohibits for
> performance claims. Each tutorial is written as its own material completes.
> M8 is therefore a recurring gate applied per tutorial, not a phase at the
> end. See `TUTORIAL-PLAN.md`.

---

## Milestones to modules

| Module | Milestones |
|---|---|
| 00 Fundamentals | — (published separately) |
| 01 Oracle / skeleton | M0, M1, M2, M3 |
| 02 Contract-first | M4 |
| 03 Fan-out | M5, M6 |
| 04 Verification | folded into M5–M7 exits |
| 05 Zip / merge | M7 |
| 06 Unattended, gates, isolation | E6 throughout; M8 |
