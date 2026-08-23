# The Boundary — v1 (frozen at M4)

The deliverable from Workbook §9: **where the boundary is, everything that
crosses it in both directions including the error case, and how each side is
verified with the other absent.**

Frozen alongside `DATASET-SPEC.md` v1.2 and `MEASUREMENT-CONTRACT.md` v1.2.
Rollback baseline: git tag `pre-freeze`.

---

## 1. Where the boundary is, and why there

**A child process, invoked by path, exchanging JSON over stdio.** The harness
spawns a cell; the cell reads a job spec and writes a manifest.

Three forces put it here, and only one of them is about elegance:

- **The datasets do not cross it.** A wire format carrying 1.6 GB would make
  serialisation cost inseparable from sort cost, and the whole point is that
  each runtime reports its own timings for its own work. The job spec carries
  paths; the cell opens the files itself.
- **The agent's sandbox has no Rust toolchain** (E4). A native addon or a
  WASM module built during install would have made that precondition fatal
  instead of merely inconvenient. Loose coupling is what makes a
  heterogeneous toolchain workable at all.
- **A human runs `cargo build`** (E4 again). The harness must be able to
  invoke a binary it did not build and cannot rebuild.

### The decomposition test, applied

| Test | Verdict |
|---|---|
| **Independence** | Pass. Neither side observes the other's intermediate state. The harness waits for a manifest; the cell never calls back. |
| **Contractability** | Pass — this document. Both directions are fully specified without reference to either implementation. |
| **Verifiability** | Pass. Each side has a check that runs with the other absent; §5. |
| **Context economy** | Pass. A cell's internals — allocator behaviour, comparator, threading — never enter the harness's view. It sees a manifest. |

---

## 2. Node → cell: the job spec

Delivered as `--job <path>` to a JSON file. **Not stdin**: a cell that has to
drain stdin before it can start cannot report `startup_ns` honestly, and a
partially-written pipe is a failure mode with no diagnostic.

```json
{
  "contract": 1,
  "job_id": "sort-C-mid-merge-st-0001",
  "op": "sort",
  "tier": "mid",
  "inputs": [{ "dataset": "C", "path": "/abs/path/C.tsv" }],
  "algorithm": "merge",
  "threads": 1,
  "load_mode": "aos",
  "output": { "path": "/abs/path/out/C.sorted.tsv", "emit": true },
  "repeat": 3
}
```

| Field | Type | Required | Notes |
|---|---|---|---|
| `contract` | int | yes | `1`. A cell seeing an unknown value exits 2 rather than guessing. |
| `job_id` | string | yes | Opaque to the cell. Echoed verbatim into the manifest. |
| `op` | `"sort"` \| `"join"` | yes | `join` is unimplemented; a cell that does not support it exits 2. |
| `tier` | string | yes | Opaque to the cell; echoed. The cell never infers size from it. |
| `inputs` | array | yes | Each `{dataset, path}`. `sort` takes exactly one. Paths are absolute. |
| `algorithm` | string | yes | Cell-specific. Unknown value → exit 2. |
| `threads` | int | yes | `1` means single-threaded, and every algorithm must support it. |
| `load_mode` | string | no | Runtime-specific hint. A cell that does not offer the mode uses its own and **says so in `notes`** rather than failing. |
| `output.emit` | bool | yes | When false, `output.path` may be null and the `emit` phase reports 0. |
| `repeat` | int | no | Default 1. Memory is only valid at 1 (contract §5). |

**Absolute paths only.** The cell's working directory is not specified and
must not be assumed. A relative path is a spec error, not a lookup.

---

## 3. Cell → Node: the manifest

**stdout carries the manifest and nothing else.** Every human-readable line —
progress, warnings, the PASS summary — goes to stderr. A cell that prints one
stray line to stdout produces a manifest the harness cannot parse, and the
failure looks like a crash.

Shape is `MEASUREMENT-CONTRACT.md` §7. Obligations restated as boundary
requirements:

- Every field present. A value the cell cannot produce is `null` **with a
  line in `notes`** — never omitted, never guessed, never zero.
- Durations are integer nanoseconds from a monotonic clock (§3).
- `peak_rss_bytes` is sampled after the last run's phases and **before any
  verification**, with `peak_rss_includes` stating the scope.
- `memory_measurement_valid` is false whenever `repeat > 1`.
- `invariants` reports what the cell checked. A cell that checks nothing
  reports `{}` and is not believed.
- `job_id` is echoed exactly.

---

## 4. The error case

The half that gets skipped, and the half that decides whether a fan-out can
run unattended.

### Exit codes

| Code | Meaning | stdout | Harness action |
|---|---|---|---|
| `0` | Ran; all invariants passed | manifest | record the result |
| `1` | **Ran; output is wrong.** Invariant failure | manifest, with failures | record it — this is a *result*, not a crash |
| `2` | Job spec rejected before work began | *empty* | fix the spec; do not retry |
| `3` | Runtime failure — I/O, allocation, unsupported platform | *empty* | may retry once; record and continue |
| signal | Killed — OOM, timeout | *empty* | record as killed; **never retry at the same tier** |

**1 and 3 are the distinction that matters.** Exit 1 means the cell worked
correctly and its output is wrong — a finding worth keeping, and a cell that
crashed instead would have destroyed it. Exit 3 means the cell never got far
enough to have an opinion. Collapsing them loses the difference between "this
algorithm is broken" and "this disk was full".

### Error object

On exit 2 or 3, to **stderr**:

```json
{
  "contract": 1,
  "kind": "error",
  "job_id": "sort-C-mid-merge-st-0001",
  "stage": "spec" | "startup" | "load" | "work" | "emit",
  "code": "ENOENT",
  "message": "input not found: /abs/path/C.tsv",
  "retryable": false
}
```

`job_id` may be `null` if the spec was unreadable. `stage` is what makes a
fan-out summary useful: twenty cells failing at `load` is one problem, twenty
failing at `work` is twenty.

### What the harness must not do

- **Not treat a missing manifest as a zero.** A cell that produced no
  manifest produced no measurement. It is absent from the results, not slow.
- **Not retry an exit 1.** The output was wrong; it will be wrong again.
- **Not retry a signal kill at the same tier.** An OOM at `large` is a
  result — the memory wall, exactly located (§ tiers).
- **Not silently drop failures from the summary.** A run that bounds coverage
  says what it dropped. An unqualified summary over partial coverage is worse
  than no summary.

---

## 5. Verifying each side with the other absent

The decomposition test's third condition, made concrete. If a side cannot be
checked alone, a failure cannot be localised — and the boundary is not real.

### The Node side, with no cell

Already true today, and it is why M2 came before M4.

```
[BOTH]  node packages/oracle/oracle.selftest.js data/tiny
[BOTH]  node packages/generator/verify-determinism.js
```

The oracle is adversarially self-tested; the generator is checked against
committed reference hashes. Neither touches a cell.

### A cell, with no harness

Any cell is runnable directly from a job spec. For a non-JS runtime, three
checks must pass **before its numbers are believed**, and all three exist
because of things already found the hard way:

1. **Its own `rss-probe`.** Native code reads `getrusage`, which returns
   bytes on Darwin and kilobytes on Linux, while Node normalises to kilobytes
   everywhere (contract §5). This is the single most likely place for a
   1024× error that nothing else catches.
2. **PCG32 known-answer vectors.** `packages/generator/lib/pcg32.vectors.json`
   — required only if the runtime generates data, but cheap and decisive.
3. **Byte-identical output.** Sort `tiny` and compare against the JS cell's
   output. Both implement the same declared total order, so the files must
   match exactly. `aos` and `soa` already demonstrate this working across two
   representations in one runtime.

### The boundary itself: a conformance suite

**Neither side's own tests exercise the contract.** So a fixture-driven
conformance suite that any cell must pass to enter the matrix:

| Case | Expect |
|---|---|
| valid spec, tiny input | exit 0, parseable manifest, all fields present |
| `contract: 99` | exit 2, error object, empty stdout |
| unknown `algorithm` | exit 2 |
| missing input file | exit 3, `stage: "load"`, `code: "ENOENT"` |
| relative input path | exit 2 |
| `output.emit: false` | exit 0, `emit` phase 0, no file written |
| `threads: 1` | exit 0 — mandatory for every algorithm |
| deliberately corrupted input | exit 1 with a failing invariant, **not** a crash |
| `repeat: 2` | `memory_measurement_valid: false` |
| output vs the JS cell | byte-identical |

That last case is the one that makes M6's claim testable. "Adding a runtime
costs a row, not a project" is only true if a new runtime can be dropped in
and verified without touching the harness — and this suite is what decides it.

**Status: specified, not built.** It is a deliverable of M5, before the first
fan-out, not of M6.

---

## 6. What deliberately does not cross

| Stays inside | Why |
|---|---|
| the datasets | serialisation would contaminate every timing |
| the oracle's comparators | a cell sorting with the checker's comparator makes I3 confirm only that a function agrees with itself |
| allocator, threading, representation | the cell's business; the harness sees a manifest |
| wall-clock time | manifests carry monotonic durations only; timestamps are stamped by the harness |

---

## 7. Change control

| Version | Date | Change |
|---|---|---|
| v1 | 2026-08-22 | Initial, frozen at M4 alongside both contracts. |
