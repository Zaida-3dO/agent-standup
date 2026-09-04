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

## G1 — Mutation testing is off — `closed`

**Closed 2026-09-04 by removal, not by satisfaction.** The gate asked "what has to be true to turn
mutation testing back on in CI?" The answer turned out to be: nothing — it is not coming back on. The
owner's call, 2026-09-04, was to **delete the CI mutation-testing job outright** rather than keep it
configured-but-off. In his words, a CI mutation step is *"really slow, not very efficient, and it
slows down production time a lot."*

Reason 1 below — the 22–57 minute cost — is what closed this, and it closed it by removing the job
rather than by being paid down. The conditions listed under "what has to be true to turn it back on"
are therefore moot: there is no switch left to flip.

**This did not conclude that mutation testing is worthless — the opposite.** The practice was kept in
the form that earns its keep: **hand-mutating your own diff before handing it off**, which is nearly
free and has been repeatedly load-bearing here (on the day of the removal it caught five survivors on
PR #367 and a hollow assertion on PR #364 — neither of which the CI job would have caught, as it was
`workflow_dispatch`-only by then). What was removed is the *automated CI step*, whose cost was not
repaid by its signal. **Do not rebuild it**; the full reasoning, and what a case for rebuilding it
would have to show, is the tombstone in `docs/ci-required-checks.md`.

Everything below is the historical record of why it was off, retained because the analysis is still
the best explanation of what mutation testing does and does not reach in this codebase.

---

**State (historical):** off on every branch, `main` included. `workflow_dispatch` ran it on demand.

**How it got here.** The owner's call, 2026-08-18: the job runs only when dispatched by hand, and the
reasoning belongs beside the switch rather than in anyone's memory. It stays configured and runnable
so that turning it on is a decision someone makes, not a job someone has to rebuild.

**Why off.** Two reasons, and the second decided it:

1. **It costs 22-57 minutes per run** — far and away the slowest job in the pipeline, against
   single-digit minutes for everything else. On a pull request that lands directly on merge latency,
   which is what decides how fast work moves through the queue. On `main` nobody waits on it, but
   that is also why it gates nothing there: the merge has already happened, so a survivor is a
   notification rather than a refusal.
2. **Its first run against a service operation produced findings no test could act on.**
   `sweep.ts` scored 33-38 with four survivors, all in the `defineOperation({…})` metadata. That
   object is a module-level literal evaluated once at import, while Stryker activates a mutant at
   *runtime*, so no test written any way can kill those mutants — a property of every operation
   module rather than of one file. Left alone, each new operation entering scope would re-report the
   same tool limitation at the cost of the slowest job in the pipeline.

   **This one was largely handled.** Issue #166 addressed it across all 60 operation modules with a
   scoped disable annotation on the metadata literal, plus a check to keep the annotations in place,
   so the four false survivors were reported as `Ignored` rather than as findings. Worth recording
   that #166's *first* diagnosis was wrong and was corrected by running the tool rather than
   reasoning about it: the survivors were attributed to coverage attribution, and the fix that
   followed from that — asserting the metadata inside a test body — left all four alive. The reports
   showed `coveredBy: 3`, not 0. The mutants are unkillable by construction, which is a different
   problem with a different answer.

   Reason 1 — the cost — is the one that kept this gate open, and ultimately the one that closed it
   by deletion.

**A leftover this removal deliberately did not chase.** The `// Stryker disable all` / `// Stryker
restore all` annotation pairs from #166 remain in the operation modules under
`src/lib/service/operations/`, though nothing reads them any more. They are inert comments carrying a
written explanation, and stripping them would have meant rewriting ~91 application files for no
behavioural change. Nothing enforces them now, so they are optional — remove them opportunistically
when a file is being edited anyway, rather than in a sweep.

---

## How to add an entry

One heading per gate, numbered `G<n>`, never renumbered — an entry that turns out to be unnecessary
is marked `closed` with the reason, not deleted, so a reference to it keeps resolving.

State four things: **what is switched off or accepted**, **how it got that way** (with the date and
whose call it was), **why**, and **what has to be true to close it**. That last part is what makes
this a list of gates rather than a list of regrets — an entry nobody can tell how to close is a
worry, and worries belong in a different document.
