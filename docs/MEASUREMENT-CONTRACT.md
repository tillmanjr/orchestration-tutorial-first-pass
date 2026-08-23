# Measurement Contract — v1.5 (frozen)

---

> ## FROZEN — v1.2, 2026-08-22, at milestone M4
>
> Frozen does not mean correct, and it does not mean unchangeable. It means
> **a change is now an event**: bump the version, stop every agent building
> against this document, and restart them against the new one.
>
> This document was corrected twice in the two hours before freezing, and
> every correction came from *using* it rather than from reviewing it. That is
> the expected failure rate for a specification nobody has built against yet,
> and it is the reason freezing happens after the walking skeleton rather than
> before it.
>
> Baseline for rollback: git tag `pre-freeze`.

---


**Frozen.** See the stamp above.

This is not a study of whether JavaScript should call Rust. It is a study of
what each language and runtime costs and buys for this shape of work.
JavaScript is the harness; it orchestrates, collects, and reports. **It does
not time anything it did not execute.**

---

## 1. Who measures what

Every implementation times **itself**, from inside its own runtime, using its
own monotonic clock, and reports those figures in its manifest. The harness
reads manifests. It never wraps a child process in a stopwatch and calls the
result a language comparison, because that figure includes process spawn,
serialization, and pipe transit — none of which is a property of the sorting
algorithm.

The boundary cost is real and gets measured, **once**, as its own artifact
(`docs/BOUNDARY-COST.md`). It is stated, it is understood, and it never enters
a comparison between implementations.

---

## 2. Phases

A total runtime hides what you actually want to know. Each implementation
reports three phases with hard boundaries:

| Phase | Starts | Ends |
|---|---|---|
| `load`  | first byte requested from the OS | in-memory representation complete and ready to operate on |
| `work`  | first comparison, partition, or probe | ordering or join result fully determined **in memory** |
| `emit`  | first output byte formatted | final write flushed and the handle closed |

`work` is the cross-language comparison. `load` and `emit` are where the
surprises live — for this workload they may well dominate, and a `work` phase
8× faster inside a total 1.2× faster is the honest and more instructive
result.

`startup_ns` is reported **separately and belongs to no phase**: process spawn
through runtime initialization, up to the point the program begins `load`. It
is excluded from every comparison and recorded anyway, because for a CLI
workload it is a genuine language difference and hiding it would be dishonest.

---

## 3. Clock discipline

| Runtime | Clock |
|---|---|
| Node | `process.hrtime.bigint()` |
| Rust | `std::time::Instant` |
| C++  | `std::chrono::steady_clock` |

Monotonic in all three. Never wall clock, never `Date.now()`, never
`system_clock`. All durations reported in **nanoseconds, as integers.**

---

## 4. Cold and warm

A cold JS run measures the interpreter tier; a warm run measures optimized
JIT output. Both are true, and which one is "JavaScript's performance"
depends on whether the workload is a long-lived process or a CLI invocation.
That *is* the tradeoff, so both are reported rather than one being chosen.

Each job runs `repeat` iterations inside a single process. Index 0 is `cold`;
all subsequent iterations are `warm`. Rust and C++ report the same structure
and will show a nearly flat profile — **that flatness is data**, and the
asymmetry between the runtimes is one of the findings.

---

## 5. Peak memory

Peak RSS is the only figure comparable across runtimes. Heap statistics are
not commensurable — Node's heap accounting and Rust's allocator behaviour do
not describe the same thing. Sampled by the process itself, reported once per
run, covering the whole process lifetime.

**The unit depends on how you ask, not only on which platform you ask.** This
is the correction the probe earned, and v1 of this document had it wrong: it
listed units per platform, which is true of the underlying OS calls and false
of what a runtime hands you on top of them.

| Access path | Windows | macOS | Linux |
|---|---|---|---|
| Node — `process.resourceUsage().maxRSS` | **kilobytes** ✓ | **kilobytes** ✓ | **kilobytes** ✓ |
| Rust / C++ — `getrusage(RUSAGE_SELF).ru_maxrss` | n/a | **bytes** | **kilobytes** |
| Rust / C++ — `GetProcessMemoryInfo` → `PeakWorkingSetSize` | **bytes** | n/a | n/a |

Node normalises through libuv and reports kilobytes on all three platforms —
now verified on both targets, not assumed. Native code
reaching the OS directly does not, and on Darwin the same call that returns
kilobytes on Linux returns bytes. **A Rust implementation and a Node
implementation on the same machine therefore read the same quantity through
sources that disagree by a factor of 1024.** Nothing in either program looks
wrong.

### Verified results

| Platform | Runtime | Unit | Accuracy | Evidence |
|---|---|---|---|---|
| linux-x64 | node 22 | kilobytes | 100.3% | sandbox, not a target platform |
| win32-x64 | node 24.6.0 | kilobytes | 100.2% | `results/instrument/rss-probe.node.win32-x64.json` |
| darwin-arm64 | node 24.15.0 | kilobytes | 101.3% | `results/instrument/rss-probe.node.darwin-arm64.json` |

### The rule

**Every runtime ships its own `rss-probe`, and it passes before that runtime's
first benchmark is believed.** Node's is done. The Rust and C++ probes are
gates on M6, not afterthoughts — and given the table above, they are the ones
most likely to find something.

Allocate a known number of bytes, touch every page to force residency, read
back what you wrote so nothing is elided, and derive the unit from the ratio.
Never assert a unit from documentation. A memory comparison built on an
assumed unit is worse than no comparison, because it looks authoritative.

## 5a. The noise floor

Measured on darwin-arm64 at the tiny tier, two cold runs of identical work
differed by **13% on `work`, 12% on `load` and 41% on `startup_ns`**.

> **v1.3 correction — the floor is a property of the host, not of the
> project.** v1.2 stated 13% as a constant every comparison was bound by. The
> first fan-out observed **16–46%** and **38–200%** on a 2-core sandbox. A
> threshold that governs every comparison cannot be one number measured once
> on one machine at one tier: it belongs to the host, the tier and the load,
> and must be measured where the comparison is made. Same argument as
> `rss-probe`, one level up. A `noise-probe` is owed and not yet built.
>
> Until it exists, **13% is the floor for darwin-arm64 at tiny and for nothing
> else.** Any comparison on another host states its own measured spread or is
> not a comparison.
>
> Also corrected: the rule "a difference must exceed the observed spread"
> compared a spread in milliseconds against a floor quoted in percent. Both
> are now expressed as a **fraction of `work_warm_min`**.

### v1.5 — there are two variances, and the project was reporting the smaller

Building `noise-probe` surfaced a distinction v1.2 through v1.4 never made:

| | What it measures | Held constant |
|---|---|---|
| **within-process** | spread across warm repeats inside ONE invocation — this is `work_warm_spread` | page cache, JIT state, allocator arena |
| **between-process** | movement of `work_warm_min` itself across SEPARATE invocations | nothing |

**Cells are compared across process invocations.** Each cell is its own
process, launched separately, possibly minutes apart. None of the things
within-process variance holds constant are constant between two cells being
compared — so **between-process variance is the floor that actually governs a
cell-vs-cell comparison**, and it is not what the project was reporting.

Measured on the agent sandbox, 8 invocations × repeat 3, dataset C at tiny:

    within-process   median 16.9%   (range 0.1% - 79.3%)
    between-process         22.3%   work_warm_min moved 45.0ms -> 55.1ms
    between (cold)          18.9%
    between (load)          40.3%

Within-process flatters the instrument. A run that happens to land on a warm
cache reports a 0.1% spread and looks like a precise measurement; the same
workload in the next process is 22% away.

**The resolution floor is the larger of the two.** A comparison has to clear
whichever noise it is actually exposed to.

### The rule, restated

    A difference between two cells is reportable only if it exceeds
    resolution_floor_frac of the smaller figure. Below that, it is not a
    difference.

`resolution_floor_frac` comes from `results/instrument/noise-probe.node.<platform>-<arch>.json`
for the host the comparison was made on. **A host with no noise-probe result
has no floor, and therefore cannot host a comparison.**

Three rules follow, and they bind every comparison in this project:

- **A single run is not a measurement.** `repeat` is mandatory for anything
  that will be compared, and `work_warm_spread` is reported so the noise is
  visible rather than averaged away.
- **A difference must exceed the observed spread before it is reported as a
  difference.** An early cross-architecture comparison showed a 14% gap on
  `work` against a 13% noise floor — it survived exactly one additional run.
- **`startup_ns` is not compared at this scale.** At 41% spread it carries no
  signal. It is recorded because it is a real language difference for CLI
  workloads, and excluded from every phase so that nothing depends on it.

Any published comparison carries its noise floor beside it. Without that, a
reader has no way to tell a result from an artefact — and neither did we.

## 5b. Benchmark admissibility

**A timing is a measurement only on a host that has declared itself a
benchmark host.** Every manifest carries `benchmark_admissible` and
`admissibility_reason`.

Opt-in is explicit. Nothing is auto-detected: *"is this a real machine"* has no
reliable test, and a wrong guess silently certifies numbers that mean nothing.

Two mechanisms, and which one to use is a property of the host:

| | Mechanism | Use when |
|---|---|---|
| **env** | `ORCH_BENCHMARK_HOST=1` | the hostname is unstable, or is identifying and the repo is public. Process-scoped and stable; costs discoverability. |
| **marker** | a `.benchmark-host` file listing hostnames, one per line, searched upward from the repo root | the hostname is a fixed machine name. Keep the file **outside** the repo, where it cannot be committed. |

Matching is case-insensitive. A line of `*` admits any host and exists only so
that the failure mode is deliberate and greppable rather than accidental.

**The marker keys on hostname, not on its own existence, and that is the whole
mechanism.** The agent's sandbox reaches the operator's disk through a mount,
so it can see the operator's marker file. A presence check would declare the
sandbox admissible. A file answers a question about a *disk*; a hostname
answers one about a *process*.

But a hostname is not stable everywhere. macOS reports a DHCP-derived suffix —
the same machine can be `host.localdomain` on one network and `host.local` on
another — and if it shifts, the machine silently becomes inadmissible while
looking exactly like the gate working correctly. Prefer the env var there.

**The repo documents the mechanism and does not enumerate the hosts.** A
hostname can be a corporate asset name, and this repo is public.

### Verify it discriminates, not that it exists

A gate that admits everything is not a gate. `node
packages/harness/benchmark-host.js` prints the hostname, every path searched,
the marker's contents, and the verdict. It must report NOT ADMISSIBLE on at
least one machine you actually use, or it has not been tested.

This exists because `MILESTONES.md` E8 — *the agent's sandbox never runs a
benchmark* — was written down, accurate, and ignored. The first fan-out
benchmarked there anyway, produced spreads of up to 200%, and both agents
concluded this document was wrong rather than that their host was
inadmissible. They had no way to know: nothing in the manifest, the runner or
their brief said so.

**A precondition that is not enforced is a comment.**

Inadmissible timings are still recorded — they are a useful smoke test. They
are simply not a measurement, and the manifest now says which it is instead of
leaving a reader to infer it from the platform block. Correctness results are
unaffected by admissibility.

## 6. Job spec — into the process

```json
{
  "contract": 1,
  "job_id": "sort-A-mid-merge-st-0001",
  "op": "sort",
  "tier": "mid",
  "inputs": [{ "dataset": "A", "path": "/abs/path/A.tsv" }],
  "key": { "level": 1, "type": "int64" },
  "algorithm": "merge",
  "threads": 1,
  "output": { "path": "/abs/path/out/A.sorted.tsv", "emit": true },
  "repeat": 3
}
```

Small, human-readable, and carrying no data. The datasets stay as files the
implementation reads directly, so serialization never distorts a benchmark.

## 7. Manifest — out of the process

```json
{
  "contract": 1,
  "job_id": "sort-A-mid-merge-st-0001",
  "impl": {
    "runtime": "rust", "runtime_version": "1.89.0",
    "name": "merge-st", "algorithm": "merge",
    "threads": 1, "parallel_strategy": null
  },
  "platform": {
    "os": "darwin", "arch": "arm64",
    "cpu": "Apple M4 Pro", "cores_physical": 12,
    "ram_bytes": 25769803776
  },
  "tier": "mid", "dataset": "A",
  "records_in": 3937500, "records_out": 3937500,
  "startup_ns": 1840000,
  "runs": [
    { "index": 0, "state": "cold",
      "phases_ns": { "load": 0, "work": 0, "emit": 0 },
      "peak_rss_bytes": 0 }
  ],
  "invariants": { "I1": "pass", "I2": "pass", "I3": "pass" },
  "notes": []
}
```

Manifests are **committed results**. They are small, diffable JSON with
history, which is what lets `large`-tier figures produced on one machine be
displayed on another without re-running them.

An implementation that cannot report a field emits `null` and a line in
`notes`. It never omits the key and never guesses.

---

## 8. The work list is a matrix

Not three implementations — a matrix of *algorithm × runtime × threading*,
where every cell has identical shape and independent verification. That is the
pipeline case, and it is why adding a runtime later costs a row rather than a
project.

| Runtime | Cells |
|---|---|
| JS | built-in `Array.prototype.sort` (control), iterative merge, iterative quicksort, radix (int keys), `worker_threads` + `SharedArrayBuffer` |
| Rust | `sort_unstable`/`sort` (control), merge, radix, pattern-defeating quicksort, rayon-parallel |
| C++ | `std::sort` (control), merge, radix, `std::thread` pool parallel |

`threads: 1` is mandatory for every algorithm before any parallel cell is
believed.

Note that the JS built-in is TimSort in C++ underneath, and will beat most
hand-written contenders on single-threaded comparison sorting. The reference
implementation is therefore both the oracle *and* a first-class competitor
with a legitimate claim to winning cells — which is itself one of the
tutorial's better lessons.

---

## 9. Platform rules

Two development targets from day one: Windows/x86-64 and macOS/arm64.
Portability validated while there is nothing to port; retrofitted later it
costs a weekend.

- **No `std::execution::par` in C++.** Apple clang ships no PSTL, so parallel
  algorithms do not exist there. Use `std::thread` with a small pool. Decided
  before any C++ is written.
- **Build output lives outside the repo.** Set `CARGO_TARGET_DIR`; put the
  CMake build directory outside the tree. ARM and x86 artifacts must never
  meet.
- **No platform-conditional paths in application code.** Platform differences
  are confined to the RSS shim and nothing else.
- **`large` tier runs on the 64 GB Windows machine only.** Its manifests are
  committed and displayed elsewhere. The demo executes `mid`.

---

## 10. Change control

| Version | Date | Change |
|---|---|---|
| v1 | 2026-08-22 | Initial draft. |
| v1.4 | 2026-08-22 | §5b: two admission mechanisms, and which to use is a property of the host. The marker keys on hostname because the agent sandbox sees the operator's disk through a mount; the env var exists because hostnames are unstable on macOS and identifying on managed machines. |
| v1.3 | 2026-08-22 | §5a: the noise floor is a per-host measured quantity, not a project constant — observed 16–200% on a 2-core host against a documented 13%. Units reconciled. Added §5b, benchmark admissibility, after a fan-out benchmarked on the machine E8 forbids. |
| v1.2 | 2026-08-22 | Added §5a, the noise floor: 13% single-run variance measured, and the rules that follow. §5 peak RSS is sampled before invariant checks, not after. |
| v1.1 | 2026-08-22 | §5 corrected: RSS units vary by access path, not by platform alone. Node reports kilobytes everywhere; native code does not. Verified on win32-x64. |
