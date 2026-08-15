# Orchestration — keeping the buffer full

Reference for anyone, human or agent, running a queue of work across several concurrent workers. It
is written down because the failures it describes are ones people repeat: they feel like diligence
at the time.

`INTERVENTIONS.md` encodes several of these rules as things the server detects. This document is the
reasoning behind them — the rule stated once, so an entry in that catalogue can point here instead of
restating it.

---

## The rule

**Never wait. When blocked, ask: "I have bandwidth — what else can I start?"**

Time spent watching something finish is time not spent making progress. The correct response to
"this will take nine minutes" is not to watch it for nine minutes; it is to spend those nine minutes
starting the next four things.

## Three concrete instructions

1. **Never sleep in the foreground.** Not to poll a build, not to wait on a worker, not for
   anything. If something must be watched, put it in the background so it reports back. Your
   foreground is for orchestrating.

2. **Being under the concurrency cap while waiting is a signal to start something, not to wait.**
   If the cap is ten and six are running, that is four idle slots, and idle slots are the resource
   being wasted.

3. **An unblocked row should never sit idle.** If the dependency graph says a row is available and
   nothing is building it, that is a failure of orchestration rather than a neutral state.
   **Recompute the frontier every time something merges** — the merge just changed it.

## Why the cap can be high, and what actually constrains it

- **Each worker gets its own worktree and its own branch**, so concurrent builders do not collide on
  a working tree. That isolation is what makes a wide fan-out safe.
- The real constraints are **the dependency graph** and **the budget**, in that order. When the graph
  opens, fill it.

Note the limits of worktree isolation: it separates _files_, not _lines_. A file every branch must
append to — a central registry, a barrel export, a manifest — serialises the fan-out anyway, because
each merge forces every other branch to re-resolve the same region. Prefer self-registration over a
central list that every change edits.

## What to do while workers run

Orchestrate. Recompute the frontier, start the next wave, read returning verdicts, merge what is
signed off, record findings, keep the queue honest. None of that requires waiting for anything.

**Do not do the workers' work yourself.** If something needs building, fixing or verifying, it goes
to a worker. Hands off the code.

## Check the shared checkout every tick

Run `git status` in the primary checkout on every pass. An unexpected untracked source file there is
a worker writing outside its worktree — probe it immediately.

_Why this is a rule and not a nicety:_ a builder once wrote several hundred lines of its assigned
work into the shared checkout instead of its worktree. With a dozen workers in the repository that
file was one broad `git add` away from being committed under another worker's name, and it was
invisible in its own branch's diff because it was never on that branch. It was found by accident.
The brief said "work in your own worktree"; nothing verified it, so verify it.

## Stage by path, never broadly

Related, and the same root cause: `git add -A`, `git add .`, `git add -u` and `git add :/` stage
every modified file in the tree, including other workers' in-flight edits. On a shared checkout that
is one index, so a broad stage is not "my changes" — it is "everything anyone has touched". Stage
and commit explicitly by path.

## The self-check

Any time you notice you are about to sleep, poll the same command twice, or say "let me wait for
this to finish" — **stop and start something instead.** If the graph genuinely is empty, say so
explicitly rather than idling quietly.
