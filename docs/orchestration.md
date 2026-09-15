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

### "High" is about independent rows, not about crew on one row

Two different numbers get confused here, and reading one as the other is how this section ends up
looking like it contradicts a workspace that sets a low ceiling.

|                                         | What bounds it                                                                                                                    |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| **Concurrent workers across the board** | The dependency graph and the budget. This is the one that can be high — every open row is its own worktree and its own branch.    |
| **Crew on a _single_ row**              | The row's file layout. Almost always **one**, and in practice a small number like four is a sane ceiling for a deployment to set. |

The second is small for a reason that has nothing to do with capacity: **a crew is only worth adding
when you can write each member's territory as a non-overlapping list of paths.** If you cannot, it is
one worker, not two, and splitting it buys you merge conflicts instead of throughput.

**Partition by file, never by phase.** "You take the backend, you take the frontend" works. "You
build, you test" does not — the second worker has nothing to do until the first finishes, and then
edits the first's files.

So: fill the graph widely, and staff each row narrowly. A deployment that pins its own crew ceiling
is applying this rule, not overriding it.

---

## Dispatching work to another agent

What follows is about handing a row to a worker that is not you. The tracker enforces some of this
and cannot enforce the rest; the parts it enforces are the parts that refuse you.

### Every brief carries these

1. **The item id.**
2. **Your own `sessionId`, as the worker's `rootSessionId`.** The most-forgotten line in a dispatch,
   and not optional — see below.
3. **The worktree path**, in a build repo.
4. **Numbered acceptance criteria.**
5. **An explicit out-of-scope list** — which is how a worker knows whose in-flight work it must not
   touch.

### `rootSessionId` is what makes a crew one crew

Claims are **role-scoped and additive**: an orchestrator, a builder and two reviewers coexist on one
item, and reviewers do not queue. Only _one live row per session per item_ and _one live
orchestrator per item_ are unique. **You do not need to release before dispatching.**

What ties those rows together is `rootSessionId`. It **defaults to the caller's own `sessionId`**,
which is always wrong for a dispatched agent: the worker becomes the root of a new crew, and the
guard refuses it as _"already held by another crew"_. `parentSessionId` records the spawn tree and
satisfies no guard.

A worker dispatched without it can recover — `orientation {itemId}` exposes `crew[].rootSessionId`
from the live rows — but the refusal costs a round trip that one line in the brief prevents.

> ⚠️ **Nothing validates that `rootSessionId` names a real session.** A mistyped character yields a
> claim that _succeeds_, attributed to a session that never existed, with crew-conflict protection
> silently absent for the whole run. Copy the value; do not retype it.

### Tell the worker which tool to record with

**`checkpoint` requires the caller's own live assignment; `note` does not.** A dispatched worker that
holds nothing cannot checkpoint, because the orchestrator holds the claim — so a brief saying
"checkpoint as you go" cannot be followed as written. Say `note`, or tell the worker to claim in its
own role first and then checkpoint.

Claiming is the better default for anything long enough to resume: a checkpoint is recorded **per
agent**, so a stalled worker has its own resume point rather than sharing yours.

Either way, ask for progress **as it happens** rather than only at the end. A worker deep in good
work is indistinguishable, from outside, from a worker that has died.

### If your worker's tools are an allowlist, a missing name fails silently

Agent harnesses commonly grant sub-agents an explicit list of tools. Where that is how yours works,
three properties bite, and none of them announces itself:

- **A tool absent from the list is not merely restricted — it is invisible.** A search for it returns
  nothing, so the worker concludes the operation does not exist rather than that it was not granted.
  Nothing errors, and the work simply never happens.
- **A brief cannot grant what the definition withholds.** Telling a worker to call something it does
  not have does not give it to them.
- **An edit to a worker definition usually takes effect only in a new session**, so you cannot test
  the change from the session that made it.

**Re-check those lists against this server's tool list after every upgrade.** A release can add,
rename or fold tools, and a name that silently stopped matching is the quietest failure in the whole
system: one deployment ran for months with hundreds of interventions firing and none scored, because
one role's list was missing two tool names.

### Reviews are artifacts, and the merge gate reads them

A review is recorded with `record_artifact`, not asserted in prose. The gate reads `commitSha` — not
`ref` — so a sha in the wrong field is evidence that does not count. Under `lgtm_with_nits`, a
medium-or-worse finding blocks the merge exactly as `changes_required` would.

**When one PR closes several rows, record the same `commit` and the same approving `code_review` on
every row it closes.** Nothing refuses a sha another item already holds, so each row then satisfies
the gate on its own evidence and no override is needed. This was twice deferred as needing a schema
change before anyone tried it — a claim about what the system refuses is worth one probe before it
is worth a design.

Full caller-facing detail for all of the above: [`using-agent-standup.md`](using-agent-standup.md).

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
