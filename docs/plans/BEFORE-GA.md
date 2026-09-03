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

## G1 — Mutation testing is off — **closed 2026-09-03**

**State:** closed. Mutation testing runs on every pull request whose diff touches `src/**/*.ts(x)`,
and `Mutation testing gate (required)` now reports that job's real result.

**How it got here.** Held open on two recorded reasons, both of which turned out to be spent, plus a
third that nobody had written down and which was the one that actually mattered.

**Why it is closed:**

1. **Cost — measured, not estimated.** The 22–57 minute figure is a whole-tree run. The CI job is
   `--changed-only` and always was. Against a real 5-file / 1004-line diff it took **1m43s** wall
   clock, against 3m24s for static checks and 3m11s for the database suites on the same pull
   request. It is not the slowest job in the pipeline at the scope it runs in.
2. **Unkillable operation metadata.** Closed by issue #166 across all 60 operation modules, with
   `scripts/check-operation-metadata-mutants.mjs` holding the annotations in place.
3. **The unrecorded blocker: the verdict punished inherited code.** `thresholds.break: 60` was
   compared against a single pooled score over every mutated file. On the measured run the two
   newly written files scored 91.30 and 90.91 and the run failed anyway, dragged under by a
   pre-existing container that a node-environment harness does not test by design. Switching the
   gate on in that shape would have failed honest work for code the author inherited, taught people
   to avoid touching weak files, and created exactly the pressure to lower `thresholds.break` that
   the list below forbids.

**What replaced it.** A `--changed-only` run is judged per hunk: a survivor fails the run only when
it sits on a line the diff added or modified, and a survivor on an inherited line is printed as
context and never gates. `NoCoverage` on a changed line fails too, so "add code no test calls" is not
a way through. A full-scope run keeps the pooled `thresholds.break` comparison, which is a reasonable
thing for a whole-tree audit to use.

This answers the open condition below — *agreement on what a survivor obliges* — in the only way that
is fair on a mixed diff: **a survivor on a line you wrote obliges you to kill it, or to say at a
scoped disable why it cannot be killed; a survivor on a line you inherited obliges nothing.** It
needs none of the three forbidden moves: no threshold lowered, no config narrowed, no live mutant
annotated away.

Reasoning and the rejected alternatives — an absolute per-file threshold, and a recorded baseline
judged on score delta — are in `scripts/lib/mutation-diff-scope.mjs`.

**Demonstrated failing before being switched on.** Against a deliberately hollow test (asserting only
`typeof x === "number"` and `not.toThrow()`) the run exits 1 and names 11 survivors by file, line and
mutator, while the 7 inherited mutants in the same run scored 60% and did not contribute to the
verdict. Against an honest test of the same source it exits 0. A gate nobody has watched fail is not
evidence of anything.

**Known limit, accepted.** A diff confined to `tests/**` mutates nothing, because
`filterChangedSourceFiles` scopes to `src/`. A test weakened without touching source is therefore not
caught. The honest fix — mutating the source that the changed tests cover — is a larger design
question than this gate, and a narrow check that is on beats a broad one that is off.

**What must not happen** (unchanged, and none of it was done here): lowering `thresholds.break`,
narrowing `stryker.config.json` to dodge a file, or annotating live mutants away to force a green.
Any of those turns the check into something that reports success without providing it. A `Stryker
disable` scoped to provably unkillable mutants, with the reason stated at the disable, is a different
thing and is allowed.

---

## How to add an entry

One heading per gate, numbered `G<n>`, never renumbered — an entry that turns out to be unnecessary
is marked `closed` with the reason, not deleted, so a reference to it keeps resolving.

State four things: **what is switched off or accepted**, **how it got that way** (with the date and
whose call it was), **why**, and **what has to be true to close it**. That last part is what makes
this a list of gates rather than a list of regrets — an entry nobody can tell how to close is a
worry, and worries belong in a different document.
