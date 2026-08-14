# Enabling the merge queue — runbook

This repo's CI is now wired to trigger on GitHub's `merge_group` event (see `.github/workflows/ci.yml`),
which is the prerequisite for turning on GitHub's native merge queue. Enabling the queue itself is a
**repository-settings change**, not a code change, and this doc does not do it — it is the exact steps
for whoever does (a repo admin), plus how to tell the queue is actually working versus just slow, and
how to back out if it isn't.

**Nothing here has been run against a live merge queue.** GitHub's merge queue can only be exercised by
actually enabling it — there is no dry-run mode — so everything below is either (a) read from GitHub's
own merge-queue docs and the exact source of the actions this workflow depends on, or (b) verified
locally (actionlint, the repo's own test/lint/format gates). Section "What is and isn't verified" at the
bottom is explicit about which is which.

---

## Current state (checked via `gh api` against this repo, 2026-08-12)

| Setting                                                             | Current value                                                      |
| ------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Branch protection on `main`, `strict` (require branches up to date) | `true`                                                             |
| Required status check contexts                                      | `Build & test`, `Actionlint (required)`, `Docker build (required)` |
| `required_linear_history`                                           | `true`                                                             |
| `allow_squash_merge`                                                | `true`                                                             |
| `allow_merge_commit`                                                | `false`                                                            |
| `allow_rebase_merge`                                                | `true`                                                             |
| `allow_auto_merge`                                                  | `false`                                                            |
| `allow_update_branch`                                               | `false`                                                            |

All three required contexts above are gate jobs in `ci.yml`: they do no work themselves, they read the
results of the jobs that do and report a single pass/fail under a stable name. `Build & test` gates
`static-checks` and `db-tests`; `Actionlint (required)` gates `actionlint`; `Docker build (required)`
gates `docker-build`.

That indirection is what lets the work be reorganised — split, renamed, added to — without touching
branch protection, which matches on the context NAME. `Build & test` is the name to keep stable, and
it belongs to the gate rather than to any one job doing the verifying.

Every other job (`changes`, `actionlint`, `static-checks`, `db-tests`, `mutation-testing*`,
`docker-build`) is either a helper, a worker behind one of those gates, or — in mutation testing's
case — not a required check at all.

---

## Settings to flip, in order

Do this in **one edit of the `main` branch protection rule** (Settings → Branches → edit the rule for
`main`), so there is never a window where neither "require branches up to date" nor "require merge
queue" is protecting the branch:

1. **Check "Require merge queue".** This reveals the queue's own settings:
   - **Merge method** — pick **squash** or **rebase**, not merge commit. `allow_merge_commit` is
     already `false` and `required_linear_history` is `true`, so a merge-commit method would fail
     both; squash is the closer match to the repo's existing squash-commit-title/message config and is
     the recommended default.
   - **Build concurrency**, **merge limits (min/max/wait time)**, **status check timeout**, **only
     merge non-failing pull requests** — these are throughput/safety knobs, not correctness ones. A
     reasonable starting point for this repo's current volume is the tool's own defaults; tighten or
     loosen once real queue behavior is observed. The one worth setting deliberately is **status check
     timeout**: pick a number comfortably above the current ~9-minute CI run (e.g. 30–45 min) — this is
     what turns "hangs forever" into "eventually gets kicked out with a reason," which matters as a
     safety net even with the `merge_group` trigger fix in this PR (see "Rollback" below for why it's
     still worth having).
2. **Uncheck "Require branches to be up to date before merging" (`strict`).** GitHub's own docs
   describe the merge queue as providing "the same benefits as the Require branches to be up to date
   before merging branch protection" — once the queue is doing that check by actually testing the
   combined batch, `strict` is redundant, and leaving it on buys nothing while keeping alive the exact
   quadratic-rebase cost this change exists to remove.
3. **Save.**

That's the change that matters. Two more repository-level settings are related but optional:

- **`allow_auto_merge`** (`false` in the table above): turning this on adds a "Merge when ready" option on a PR
  that automatically adds it to the queue the moment its required checks and reviews pass, instead of
  a human needing to notice and click "Add to merge queue" by hand. Worth turning on alongside the
  queue for the automation to actually land, but the queue functions without it — anyone with write
  access can still add a passed PR to the queue manually.
- **`allow_update_branch`** (`false` in the table above): shows a manual "Update branch" button on a stale PR.
  With the queue (and `strict` off) handling "test against current main" automatically, this stops
  being load-bearing — it's a convenience for someone who wants to rebase by hand before queuing, not a
  requirement.

---

## Rollback — if the queue stalls

**Uncheck "Require merge queue"** in the same branch protection rule editor, and re-check "Require
branches to be up to date before merging" if you want that protection back immediately. Save.

This stops new PRs from being _added_ to the queue right away. It does **not** by itself guarantee
already-queued PRs are cleared — check the queue view (`https://github.com/Zaida-3dO/agent-standup/queue/main`)
after saving, and if anything is still listed, remove it from there or from the PR's own "Remove from
queue" action. Don't assume silent auto-clearing; look.

### Telling a stalled queue from a slow one

The two look identical from "a PR has been sitting in the queue for a while" — the difference is
whether CI is running _at all_ for it.

- **Slow:** `gh run list --workflow=ci.yml --event=merge_group --limit 10` shows runs that are
  `in_progress` or `queued` (waiting for an Actions runner) and progressing — check again a few minutes
  later and status has moved. This is ordinary variance (runner availability, a heavier batch than
  usual) and resolves on its own, bounded by whatever status-check-timeout was configured above.
- **Stalled — the specific failure mode this PR exists to prevent:** `gh run list --workflow=ci.yml
--event=merge_group` shows **zero runs**, despite a PR visibly sitting in the queue for multiples of
  the normal ~9-minute CI time. That means a required check isn't wired to `merge_group` at all — the
  queue is waiting for a status that will never be posted, and it will sit there until the configured
  status-check-timeout kicks it out (or forever, if no timeout is set). If this happens after this PR
  lands, the most likely cause is a _new_ required check added later without carrying the same
  `merge_group` trigger — check `.github/workflows/*.yml` for `on: merge_group` on every workflow that
  reports a context listed as required in branch protection, not just `ci.yml`.

A secondary signal: the PR's own timeline will say why it left the queue (test failure, timeout,
"branch protection failure that could not automatically be resolved," or a manual removal) — read that
before assuming it's the trigger-wiring bug above; the "zero merge_group runs" check is what's specific
to that one cause.

---

## What is and isn't verified

**Verified by inspection, with sources checked directly, not assumed:**

- `dorny/paths-filter@v3` (the version this repo used before this PR) has **no** `merge_group` handling
  — confirmed by reading its source (`getChangedFiles` in `main.ts`) directly from the `v3` tag on
  GitHub. On a `merge_group` event it would fall through to the generic "any other event" path, using
  `git merge-base` against whatever `base` resolves to (undocumented for this event, untested by the
  action's own authors for it). `v4.0.1` added a dedicated `case 'merge_group'` branch that defaults
  `base`/`ref` to `merge_group.base_sha`/`merge_group.head_sha` from the event payload — confirmed by
  reading that diff (PR #255, "Support merge queue") directly. This PR upgrades the pin to `v4`.
- With that upgrade, `getChangedFilesFromGit` resolves a merge_group `base` (a full commit SHA) via
  `git.isGitSha(base)` → true → `git.getChanges(baseSha, head)`, which fetches each SHA individually
  (`git fetch --depth=1 --no-tags origin <sha>`) rather than needing a pre-existing shallow/full clone
  to contain it. Confirmed by reading `git.ts`'s `getChanges`/`ensureRefAvailable`. This means the
  `changes` job (which does a default shallow `actions/checkout@v6`, no `fetch-depth` override) still
  resolves correctly on `merge_group` — no separate fetch-depth fix was needed there.
  `mutation-testing`'s own `fetch-depth: 0` was already correct for the same reason for a different
  mechanism (`origin/main...HEAD` three-dot diff against a fully-fetched history) — see the comment
  added next to that step in `ci.yml`.
- `actions/checkout`'s `fetch-depth: 0` fetches full history for **all branches**, regardless of
  triggering event — confirmed from the action's own README, not assumed to also apply to
  `merge_group` by analogy.
- GitHub's own merge-queue docs explicitly describe this exact failure mode — "if your repository uses
  GitHub Actions to perform required checks ... you need to update the workflows to include the
  `merge_group` event ... Otherwise, status checks will not be triggered ... The merge will fail as the
  required status check will not be reported" — and give the same `on: pull_request: / merge_group:`
  shape used in `ci.yml` here.
- `actionlint` (downloaded and run locally, not via the CI container, since Docker wasn't available in
  this environment) reports zero findings against the modified `ci.yml` and unmodified `release.yml`.
- Current branch protection and repo merge settings (the table above) were read live via `gh api
repos/Zaida-3dO/agent-standup/branches/main/protection` and `gh api repos/Zaida-3dO/agent-standup`,
  not assumed from memory of an earlier session.

**NOT verified, and can't be without actually enabling the queue (outside this task's authority):**

- Whether GitHub's live `merge_group` webhook payload and the ephemeral `gh-readonly-queue/*` ref
  behave identically, in this specific repo, to what the docs and the actions' source describe. The
  documented behavior is consistent everywhere it was checked, but a real queued PR is the only way to
  be certain.
- Real end-to-end timing — whether the ~9-minute CI run comfortably clears whatever status-check-timeout
  ends up configured, under real queue batching (a batch of several PRs runs the _combined_ diff, which
  could scope in more mutation-testing / docker-build work than any single PR would trigger alone).
- That no _other_ required or soon-to-be-required check gets added later without its own `merge_group`
  trigger — this is a wiring convention, not something enforced by the code, hence the explicit
  reminder in the "Stalled" section above to check on any future required check, not just to trust this
  PR forever.

Claim being made: **the workflows are correctly wired for a merge queue.** Not being claimed: that the
queue works — that can only be shown by turning it on.
