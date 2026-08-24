# Required checks that pass without running

Some required checks in `ci.yml` legitimately pass without doing the work their name suggests. This
documents which ones, why that is allowed, and what was done so a reader can tell them apart from a
check that actually verified something.

## The problem

`Mutation testing (required)` passed in 3s and `Docker build (required)` in 4s. Both were correct —
neither had work to do — but in the pull request's check list they rendered as a green tick, exactly
like `Database tests` (2m38s), which really did apply migrations and run 101 test files.

A required check is the one a merge gate trusts. A green tick that asserts a guarantee nobody
verified is worse than an absent check: an absent check is visibly missing, whereas a green one
actively claims something. On PR #232 the reviewer hand-ran mutants to get the assurance the tick
claimed to provide, and the builder hand-ran nine before that — work that existed only because the
tick was not legible.

This is a **presentation** problem, not a logic one. PR #244 already fixed the gate's _reasoning_
(it once reported "the suite it follows is already red" on runs where the suite was green). What
remained is that a check which did not execute still looks identical to one that ran and passed.

## What cannot be done

**A workflow job cannot report "did not run".** GitHub Actions gives a job two conclusions,
`success` and `failure`. The `neutral` conclusion — which is what "ran, but asserts nothing" means
in GitHub's own vocabulary — can only be produced by a GitHub App writing through the Checks API,
not by a workflow job. And it would not help: branch protection does **not** count `neutral` as
passing, so a required check reporting it would block every pull request instead of informing
anyone.

So the conclusion must stay `success`. Only two things about a passing check are actually under a
workflow's control: its **name** and its **job summary**.

## What was done

**1. The mutation gate is named `Mutation testing gate (required)`.** It never mutation-tests
anything — it reads another job's `result`. A name of the form "Mutation testing (required)" asserts,
to anyone scanning the list, that the diff's tests are proven to kill mutants.

Naming it accurately is safe **for this job only**, because `Mutation testing (required)` is _not_ a
required status check context in branch protection (verified via `gh api`; `docs/merge-queue-runbook.md`
says the same). No protection rule matches on it.

**2. `Docker build (required)` was deliberately NOT renamed.** It has the same defect, but its name
_is_ a required context in branch protection on `main`, and protection matches on the context name.
Renaming it in the workflow alone would leave protection waiting forever on a context that no run
ever posts again — every pull request would block, repo-wide, until an admin edited the rule.

Renaming it is therefore a **two-part change**: edit the workflow _and_ the branch-protection rule,
by someone with admin rights, in that order. The workflow half alone is strictly worse than doing
nothing. This is left undone on purpose rather than half-done.

**3. Every branch that passes without verifying anything now writes a job summary** saying so, in
those words. The summary renders on the run's own page, so the statement is visible to someone who
followed the check without reading step output.

Wording is asserted by tests (`tests/ci-mutation-gate.test.ts`,
`tests/ci-docker-paths-filter.test.ts`) — specifically that the phrase "verified nothing" (or "no
image was built") survives, so the honesty cannot be softened into something that reads as a pass.

## What this does and does not achieve

**It does not make the check list self-explanatory.** A green tick is still a green tick, and the
renamed gate still reads as passing at a glance. Someone scanning only the list of names, without
opening the run, still sees green for a check that ran nothing. That is a limit of what a workflow
can express, not an oversight.

What it does achieve: the name describes what the job actually does rather than claiming work it
does not perform, and one click reaches a statement of what was and was not verified.

## The mutation job stays off

Mutation testing remains limited to `workflow_dispatch`, repo-wide, until pre-GA — the owner's
decision, recorded in issue #166 and `docs/plans/BEFORE-GA.md`, on the grounds of a 22–57 minute CI
tax. **Nothing here re-enables it**, and no gate was weakened: the failing branches still fail,
including the one that refuses to guess why a job was skipped.

The honest reading of the current state is that mutation testing is a **manual** tool in this repo.
For load-bearing logic, run the mutants by hand and say in the pull request which ones were run and
killed — a green tick from this gate is not evidence about the diff.
