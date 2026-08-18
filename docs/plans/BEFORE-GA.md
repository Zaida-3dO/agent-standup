# Before GA

Gates to close before this ships to anyone outside the people building it.

**This is not the milestone queue.** `MILESTONES.md` answers *what to build next*; a row there is a
unit of work with dependencies, and the queue is read to pick up the next available one. The entries
here are a different question — things deliberately switched off, deferred, or accepted as
provisional while the product is still being built, each of which has to be revisited before
strangers depend on it. Filing them as milestone rows made the queue answer two questions at once
and made "what should I build next" harder to read.

**An entry here is not work in flight.** It is a decision with an expiry date attached. Nobody picks
one up because it is available; they are closed deliberately, together, as part of deciding the
product is ready.

Status: blank = still open · `closed` = decided and done.

---

## G1 — Mutation testing is off

**State:** off on every branch, `main` included. `workflow_dispatch` runs it on demand.

**How it got here.** The job was paused behind `false &&` long before today, so it was configured but
never ran. Milestone row #106 removed the pause on 2026-08-18, which turned it on for every push, and
the owner's call the same day was to switch it back off. **So this is the status quo restored, not a
new restriction** — the only thing that changed is that the reason is now written down and the job is
still reachable by hand.

**Why off.** Two reasons, and the second decided it:

1. **It costs 22-57 minutes per run** — far and away the slowest job in the pipeline, against
   single-digit minutes for everything else. On a pull request that lands directly on merge latency,
   which is what decides how fast work moves through the queue. On `main` nobody waits on it, but
   that is also why it gates nothing there: the merge has already happened, so a survivor is a
   notification rather than a refusal.
2. **Its first real run against a service operation produced findings no test could act on.**
   `sweep.ts` scored 33-38 with four survivors, all in the `defineOperation({…})` metadata. That
   object is a module-level literal evaluated once at import, while Stryker activates a mutant at
   *runtime* — so no test written any way can kill those mutants. It is a property of every operation
   module rather than of `sweep.ts`, so each new operation entering scope would re-report the same
   tool limitation at the cost of the slowest job in the pipeline. Tracked as issue **#166**.

**What has to be true to turn it back on:**

- Issue #166 resolved, or a documented convention for what mutation testing is expected to reach in
  an operation module — so a run produces findings someone can act on rather than a known residue.
- A decision on scope and trigger: pull request, `main`-only, or nightly. The changed-files scope
  already exists and keeps cost proportional to the diff; the open question is which event pays it.
- Agreement on what a survivor obliges. On a pull request it can block; on `main` it can only be
  filed, and filing findings nobody is committed to reading is how a check becomes decoration.

**What must not happen:** lowering `thresholds.break`, narrowing `stryker.config.json` to dodge a
file, or annotating live mutants away to force a green. Any of those turns the check into something
that reports success without providing it — which is the exact failure the job exists to catch, in
the job itself. A `Stryker disable` scoped to provably unkillable mutants, with the reason stated at
the disable and the behaviour asserted by a real test, is a different thing and is allowed.

---

## How to add an entry

One heading per gate, numbered `G<n>`, never renumbered — an entry that turns out to be unnecessary
is marked `closed` with the reason, not deleted, so a reference to it keeps resolving.

State four things: **what is switched off or accepted**, **how it got that way** (with the date and
whose call it was), **why**, and **what has to be true to close it**. That last part is what makes
this a list of gates rather than a list of regrets — an entry nobody can tell how to close is a
worry, and worries belong in a different document.
