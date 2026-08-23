# Delegation Rules — v1.1

How a brief is written when work is handed to an agent that cannot see this
conversation. Companion to `BOUNDARY.md`: that document governs what crosses a
process boundary, this one governs what crosses a *context* boundary.

---

## 1. Every loop is bounded, and the bound is stated in the brief

**"Iterate until it passes" is not an instruction. It is an unbounded loop
with no exit condition.**

An agent given that phrasing and an impossible task will keep going, because
nothing in the brief tells it that stopping is allowed. Cost is unbounded and,
worse, the failure never gets reported — it is still "in progress" when
something else kills it.

Every brief that contains a retry cycle states:

- **A hard attempt budget.** "At most 5 attempts at the definition-of-done
  cycle." Not a suggestion — a count the agent tracks and obeys.
- **What to do on exhaustion.** Report the failure with what was tried and
  what the last output was. Do not continue.
- **A tool-call ceiling** as a backstop, since an agent cannot always tell it
  is looping.

## 2. `blocked` is a legitimate outcome, and the brief must say so

An agent that believes only success is acceptable will manufacture success:
weaken the check, claim a partial result as complete, or grind past the point
of usefulness.

So every brief carries an explicit escape: *"If you conclude this cannot be
done within the constraints, say so and explain precisely what blocks it. A
clear negative result is worth more than a cell that claims a property it does
not have."*

This is not softness. **A well-explained impossibility is often the most
valuable thing a delegated agent returns** — it is a finding about the design,
delivered before the design was built on.

## 3. Verification never iterates

A verify agent runs its checks once and reports. It does not fix, retry, or
re-run until something passes.

The reason is not cost. A verifier that retries is negotiating with the
result, and a check that is repeated until it passes has stopped being a
check.

## 4. No implement ↔ verify retry loop

Feeding a rejected verdict back for another attempt feels like diligence. It
is how a two-stage pipeline becomes an unbounded loop, and the bound is
invisible because neither stage contains one.

**A rejected cell is a result.** It gets reported as rejected, with the
problems the verifier found. A human decides whether to re-run it, and that
decision is the bound.

If a retry loop is genuinely wanted, it is written explicitly in the
orchestration script with a fixed maximum round count — never left implicit in
the agents' briefs.

## 5. The agent count is known before the run starts

An orchestration whose agent count depends on what the agents find is an
orchestration whose cost cannot be predicted. State the arithmetic up front:
*3 implement + 3 verify + 1 synthesis = 7*.

Where a loop-until-dry pattern is genuinely needed, it carries a round cap and
logs what it dropped when the cap binds. Coverage that was silently bounded
reads as coverage that was complete.

## 6. Independence is enforced by the brief, not requested

Agents working concurrently in one tree are told which single file they own
and which files they must not touch. Not because they are untrustworthy, but
because a brief that leaves it ambiguous invites two agents to fix the same
thing differently.

The corollary: **the verifier checks scope**, not just correctness. "Did this
agent modify something it did not own" is a check, and it is one of the ones
most likely to fire.

**v1.1 — the scope check must not mutate.** v1 told verifiers to run
`git status`. On a mount where git cannot unlink (E3), every verify agent left
a `.git/index.lock` behind, and those locks collided with the operator's own
commits — one commit failed silently and was caught only because HEAD was
checked against expectation. Use `git --no-optional-locks status`, which does
not take the index lock. The rule was written for a normal filesystem; the
precondition was not carried into it.

**Attribution is a judgement, and the brief should say so.** In a tree where
several agents work concurrently, git state alone cannot prove who changed
what. Verifiers were told to diff the shared files and judge whether a change
plausibly belongs to the cell under review. All three did, and all three said
explicitly that it was a judgement rather than proof — which is the right
answer and only happened because the brief framed it that way.

## 9. Scratch files go outside the repo, and an agent that cannot clean up must say so

One verifier, setting up a negative control, copied a cell to
`packages/js-sorts/cells/.__nc_radix.js` inside the repo and then could not
delete it — the mount refuses `unlink` (E3). It reported this in its own
findings, which is the only reason it was cleaned up rather than committed.

Two rules:

- **Scratch goes to a temporary directory outside the tree.** A working file
  inside the repo becomes someone's commit.
- **An agent that creates something it cannot remove says so, by name, in its
  report.** This is not an admission of failure; it is the only mechanism by
  which the residue is ever found. The fallback where deletion is impossible is
  to move it to `_to_delete/` and name it.

## 7. A brief stands alone

The agent cannot see the conversation, the earlier decisions, or the
constraint mentioned in passing. Anything not in the brief does not exist.

Most disappointing delegated output is an underspecified brief rather than a
weak agent — and the way to find out is to ask every agent what was ambiguous.
The first cell delegated in this project returned four defects in the harness
when asked that question, including one that defeated the conformance suite's
entire purpose.

## 8. Ask for the defects explicitly

Add to every brief: *"Anything in the contracts that was ambiguous, wrong, or
that you had to guess at — this is genuinely valuable, do not omit it to look
competent."*

Without that sentence, an agent optimises for appearing successful and the
ambiguities never surface. With it, they arrive as a list.

---

## Change control

| Version | Date | Change |
|---|---|---|
| v1 | 2026-08-22 | Initial. Written after an unbounded "iterate until it passes" was caught in a brief before the fan-out ran. |
| v1.1 | 2026-08-22 | §6: the scope check must not mutate — `git status` left index locks on a mount that forbids unlink, and those collided with the operator's commits. Added §9 after a verifier left undeleteable residue in the repo. Both found by running the fan-out. |
