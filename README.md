# Agent Orchestration — First Pass

A working tutorial in agent orchestration, built by doing rather than by
reading. Module 00, the fundamentals, is published separately as the **Agent
Orchestration Workbook**. This repo is the execution half.

## The problem

Three hierarchical datasets, three levels deep, unordered. Two key on integers
at level 1; the third keys on strings at level 1 and carries the integers at
level 2. Sort them, then zip them. The join key type differs by dataset on
purpose — that is where the interesting failures live.

The question is **not** whether JavaScript should call Rust. It is what each
language and runtime costs and buys for this shape of work. JavaScript is the
harness.

## Why this problem

Every leaf record is self-describing: its datastring encodes its dataset, its
parent, and its grandparent. That redundancy is deliberate. It is a free,
exact, mechanical oracle — after any sort or join, structural correctness is
checkable in one linear pass with no reference implementation and no golden
file. It is the property that makes it safe to fan work out across many
agents, and it is the reason this problem was chosen over any other.

## Read in this order

| Document | What it settles |
|---|---|
| `docs/MILESTONES.md` | The environment preconditions this was built inside, and every checkpoint with a mechanically checkable exit criterion. **Start here.** |
| `docs/DATASET-SPEC.md` | The data: shape, key overlaps, PCG32 determinism, tiers, collation, and the seven invariants. |
| `docs/MEASUREMENT-CONTRACT.md` | How anything is allowed to be measured: phases, clocks, cold/warm, peak RSS, job spec and manifest schemas, the work matrix. |
| `docs/LOG.md` | Dated decisions, discoveries, corrections and failures, written the day they happened. The raw material the finished tutorial is assembled from — see M8. |

Both contracts are drafts and freeze at milestone M4. Argue with them now.

## Layout

    docs/                 contracts, milestones, working log
    packages/generator/   deterministic seeded dataset generator (JS)
    packages/oracle/      invariant checks — the verification gate
    packages/js-sorts/    JS implementations, the reference tier
    packages/harness/     rss-probe, differential runner, benchmark driver
    crates/               Rust implementations (from M6)
    results/              committed evidence: probe output, determinism refs
    data/                 generated, gitignored, reproducible from a seed

## Working constraints

Both are environment facts rather than preferences, and both are documented
with their design consequences in `docs/MILESTONES.md`, Part 1.

- **`cargo build --release` is run by a human.** The agent's sandbox has no
  Rust toolchain, which is survivable only because the boundary is a child
  process invoked by path.
- **Every git command is run by a human.** The device bridge forbids `unlink`
  in mounted folders, so git cannot operate there at all. The agent writes
  files; the operator commits and pushes.

Neither is purely a tax. Together they are two of the three approval gates the
tutorial is about, enforced by the environment rather than by discipline.

## Two machines

Windows / x86-64 / 64 GB for development and the `large` tier.
macOS / arm64 / 24 GB for the demo, which runs `mid`.

Benchmark manifests are committed results, so expensive figures produced on
one machine are displayed on the other without being re-run.
