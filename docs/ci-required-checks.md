# Required checks that pass without running

Some required checks in `ci.yml` legitimately pass without doing the work their name suggests. This
documents which ones, why that is allowed, and what was done so a reader can tell them apart from a
check that actually verified something.

## CI mutation testing was removed on 2026-09-04 — do not rebuild it

**This is a tombstone. Read it before adding a mutation-testing job to CI.**

CI mutation testing existed here, it worked, and it was **deliberately removed** — it was not lost in
a refactor, and it did not rot until it broke. It ran Stryker against the files a pull request
changed, with a required gate (`Mutation testing gate (required)`), an incremental result cache, a
control fixture proving the harness could still observe a survivor, and guards against a report that
silently mutated nothing. It was, by the end, a careful piece of machinery. It was removed anyway.

**Why.** The owner's judgement, in his words: a CI mutation step is _"really slow, not very
efficient, and it slows down production time a lot."_ The run cost 22–57 minutes on a change touching
`src/`, against a full CI pipeline that otherwise finishes in a few minutes. That tax was paid on
every source-touching pull request, and it had already forced a retreat — the job had been narrowed to
`workflow_dispatch`-only well before this, so for a long time it was a required check that mostly
skipped. The signal it produced, when it produced any, did not repay what it cost to wait for.

**What did NOT happen here is a finding that mutation testing is worthless.** That was never in
dispute and is not what this records. The practice is _kept_, in the form that actually earns its
keep:

> **Hand-mutate your own diff before you hand it off.** Change a `>` to a `>=`, flip a boolean, drop a
> `!`, empty a string — on the lines you just wrote — and confirm a test fails. If none does, the test
> is hollow and you have just learned the most valuable thing a test can tell you.

That practice is nearly free, needs no infrastructure, and has been repeatedly load-bearing in this
repo: on the day of this removal alone it caught five surviving mutants in a handler on PR #367 and a
hollow `-dirty` assertion on PR #364 — **neither of which the CI job would have caught**, since it
was not running on those changes. The cheap in-place version has a better hit rate than the expensive
automated one did, because it is aimed at the few lines that just changed and is done by someone who
knows what those lines were supposed to do.

**If you think the CI job should come back**, the burden is _not_ to re-derive that mutation testing
is useful in principle — everyone already agrees, and that argument will not move anyone. The burden
is to show **the cost has changed**: that a run now fits in the time budget of an ordinary pull
request, or that it can be scoped so it does. Absent that, this stays removed.

What was deleted, should you need the history: `scripts/run-mutation-tests.mjs`,
`scripts/lib/mutation-scope.mjs`, `scripts/lib/mutation-report-guards.mjs`,
`scripts/check-operation-metadata-mutants.mjs`, `src/lib/mutation-control.ts`, `stryker.config.json`,
the `mutation-testing` and `mutation-testing-gate` jobs, and their tests. `git log -- stryker.config.json`
finds it all.

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

**1. `Docker build (required)` was deliberately NOT renamed.** It passes in ~4s on a pull request
touching no Docker files, so it has the defect described above. But its name _is_ a required context
in branch protection on `main`, and protection matches on the context name. Renaming it in the
workflow alone would leave protection waiting forever on a context that no run ever posts again —
every pull request would block, repo-wide, until an admin edited the rule.

Renaming it is therefore a **two-part change**: edit the workflow _and_ the branch-protection rule,
by someone with admin rights, in that order. The workflow half alone is strictly worse than doing
nothing. This is left undone on purpose rather than half-done.

_(The removed mutation gate was the counter-example: it could be, and was, named accurately, because
branch protection did not match on its name. See the tombstone above.)_

**2. Every branch that passes without verifying anything writes a job summary** saying so, in those
words. The summary renders on the run's own page, so the statement is visible to someone who
followed the check without reading step output.

Wording is asserted by `tests/ci-docker-paths-filter.test.ts` — specifically that the phrase "no
image was built" survives, so the honesty cannot be softened into something that reads as a pass.

## What this does and does not achieve

**It does not make the check list self-explanatory.** A green tick is still a green tick. Someone
scanning only the list of names, without opening the run, still sees green for a check that ran
nothing. That is a limit of what a workflow can express, not an oversight.

What it does achieve: one click reaches a statement of what was and was not verified.

## Mutation testing is a manual tool in this repo

There is no automated mutation testing here, by choice. For load-bearing logic, **run the mutants by
hand and say in the pull request which ones were run and killed.** Nothing in CI produces evidence
about whether your tests can fail — that evidence comes from you, and a reviewer is entitled to ask
for it.
