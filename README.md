# Agent Orchestration — First Pass

A working tutorial in agent orchestration, built by doing.

**Module 00 (fundamentals)** is published separately as the Agent Orchestration
Workbook artifact. Read it before Module 01. Everything in this repo is the
execution half.

## The problem

Three hierarchical datasets, three levels deep, unordered. Two of them key on
integers at level 1; the third keys on strings at level 1 and carries the
integers at level 2. Sort them, then zip them. The join key type differs by
dataset on purpose — that is where the interesting failures live.

## Why this problem

Every leaf record is self-describing: its datastring encodes its dataset, its
parent, and its grandparent. That redundancy is not sloppiness. It is a free,
exact, mechanical oracle — after any sort or join you can verify structural
correctness in one linear pass without a reference implementation. It is the
property that makes it safe to fan work out across many agents.

## Layout

    docs/                 tutorial modules and the frozen contract
    packages/generator/   deterministic, seeded dataset generator (JS)
    packages/oracle/      invariant checks — the verification gate
    packages/js-sorts/    JS implementations, the reference tier
    packages/harness/     differential runner and benchmark driver
    crates/               Rust implementations (Module 03 onward)
    data/                 generated, gitignored, reproducible from a seed

## Toolchain split

Node, npm, git and python run in the sandbox that Claude drives. `cargo` does
not — Rust builds run on Windows, by hand. That human step in the middle of the
pipeline is a constraint worth designing around, not around which to work.
