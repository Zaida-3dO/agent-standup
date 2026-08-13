# CLAUDE.md — Agent Standup

A task tracker for AI coding agents. Next.js (front end and API in one bundle) · Prisma · Postgres.
Image built in CI → pushed to GHCR → **pulled** on the server. Never built on the server, no bind
mounts.

Plans live in [`docs/plans/`](docs/plans/): `PLAN.md` (how it works), `SCHEMA.md` (tables, config,
endpoints), `DECISIONS.md` (why), `MILESTONES.md` (the work, as PR-sized pieces with prerequisites).

---

## ⚠️ This repository is PUBLIC

Anything committed here is world-readable **the moment it is pushed, and permanently** — deleting it
in a later commit does not remove it, because that commit is still in the history. Assume anything
that lands here has already been read and indexed.

### Scan every commit before making it

Check the staged diff — not just the files you think you touched — for:

| Category | Examples of what to look for |
|---|---|
| **Credentials** | Tokens, passwords, API keys, bearer tokens, session cookies, connection strings with a password, private keys, `.docker/config.json`, any real `.env` |
| **PII** | Real people's names, emails, phone numbers, addresses, OS usernames, account handles |
| **Local paths** | Anything absolute — `C:\Users\...`, `/home/...`, mapped drive letters, network share paths |
| **Private infrastructure** | Internal hostnames, LAN IPs, private URLs and dashboards, port mappings that reveal a real deployment |
| **Private project names** | Names of the owner's other repos, self-hosted services, or automation tooling |

```bash
git diff --cached          # read it, all of it, before every commit
```

Treat a finding as a **stop**, not a note to fix later — with one narrow, named exception below. Do
not read that exception as license to grade anything else in the table more gently; it applies to one
thing only.

**Exception: agent and crew codenames.** A crew member's working codename — an internal identity
assigned to a worker instance, never a real person, host, credential, or product name — is **shorthand,
not a secret**. It identifies no one and exposes nothing; there is nothing behind it to compromise, so
it does not belong in the same severity as the rest of this table. Apply it consistently:

- **In commit messages and pull-request bodies, a codename is fine.** Narrating who reviewed, found,
  or fixed something by its working name is not a finding, and does not need rewording, amending, or
  a rebase to remove.
- **In tracked files, prefer role over name** — "the review found," "an earlier pass fixed," rather
  than a codename — because a file is read long after the codename means anything to anyone. But a
  surviving instance is a **note**, worth cleaning up the next time that file is already being
  touched, not a blocker held on its own.
- **Everything else in this table is unchanged.** Credentials, PII, paths, hosts, and every other
  private project name are still an unqualified stop. This carve-out is about codenames specifically,
  not a general softening of what counts as private.

### Writing rules that keep it clean

- **Refer to people by role, never by name.** "the user", "a second user", "another person". Example
  identifiers in docs and fixtures are placeholders (`user-a`, `user-b`), never real ones.
- **No absolute paths.** Not in code, not in docs, not in compose files. Anything machine-specific is
  an environment variable; `.env.example` carries the *key* with a placeholder value, never a real one.
- **Name no private services.** Refer to them by what they are — "the NAS", "the chat channel", "the
  media MCP" — not by the product or the deployment's own name for them.
- **Generic examples only.** Example area names, repo names, and machine names in docs must be
  invented (`web`, `infra`, `desktop`, `laptop`), not copied from the real setup.
- **Never write a denylist of the real values into this repo.** Listing the actual names, hosts, or
  usernames "so they can be grepped for" publishes exactly what the rule exists to keep out. Scan by
  category, using judgement.
<!-- external-ref-ok-next-line: this rule has to quote the phrasing it forbids in order to state it -->
- **Nothing is described by what it succeeds.** No predecessor, no prior state, no "replaces X", no
  setup the reader is assumed to already run. Everything here reads as an application built from
  scratch, because that is the only version a reader of a public repository can verify — and a
  feature that exists *because* of a migration is still describable by its capability ("a one-time
  import from an external file-based store"). Where a decision's reasoning genuinely was "because
  the other thing did X", rewrite it to the underlying principle. That is almost always the better
  sentence, and it survives the other thing changing.

### The check that enforces the last rule

```bash
npm run check:external-refs     # every tracked file; runs in CI on every PR
```

<!-- external-ref-ok-next-line: naming the shapes it matches is the documentation; they are grammar, not real values -->
It matches **pattern shapes** — `today's`, `the old …`, `replaces`, `port of` — and deliberately
**never a list of the real values**, per the rule above.

**A green run means the recurring phrasings are absent. It does not mean the prose is clean** — and
the difference is worth knowing before you trust a tick. No shape matches a private proper noun
dropped into a sentence, or a sentence that only makes sense to someone who has seen a system this
repository does not contain. That gap is a **cost decision rather than an impossibility**: an
allowlist of the proper nouns this repository *is* allowed to name would decide it while naming
nothing private, at the price of a list extended on every new dependency and heading, and of noise on
legitimate additions. The script's header records the reasoning. So the check is a backstop that
keeps the recurring phrasings from eating the attention **reading the diff** needs — not a substitute
for doing it.

**Recording a deliberate exception.** Some shapes have honest in-repo uses ("that commit is still in
the history"). Waive one line at a time, with a reason, in a comment the language already supports:

```markdown
<!-- external-ref-ok: why this one is really about this repository -->
// external-ref-ok-next-line: why this one is really about this repository
```

A waiver's own line is never scanned, so `external-ref-ok` covers the line it sits on and
`external-ref-ok-next-line` covers **that line and the one after**. A waiver covers the *whole* line,
so attach it precisely — on a long wrapped line it can silence more than you meant, and the run
summary reports how many matches the tree's waivers are silencing so that creep stays visible.

**The reason is mandatory and must read as a phrase**, not padding — a waiver that says nothing fails
the check itself, so silencing it always costs an explanation that lands in the diff beside the text
it excuses. Prefer rewording: most matches are easier to fix than to justify.

### If something sensitive is committed

1. **Do not** just delete it in a follow-up commit — the history still has it.
2. Rewrite the history and force-push (admin bypass is on for `main`).
3. **If it was a credential, rotate it.** Assume it is already compromised — rewriting history does
   not un-publish it.
4. Say so plainly to the owner rather than quietly fixing it.

---

## Testing is a core tenet

**Every feature ships with extensive tests.** Not a smoke test — tests that would actually fail if
the behaviour regressed. A PR that adds behaviour and no tests is incomplete, and saying "it's
covered by the integration tests" is not an answer when those don't exist yet.

- **Setup work is the exception, and only setup work.** Scaffolding, config, CI wiring and deployment
  plumbing don't need unit tests; they're proved by the pipeline running. Everything after that does.
- **Prefer many small PRs, each fully tested, over one large PR tested at the end.** A single
  transition guard is a perfectly good PR: the guard, and the unit tests that prove it both allows
  what it should and **rejects what it shouldn't**. The rejections are the point — a guard that never
  refuses anything passes a happy-path test suite and protects nothing.
- **Test the error paths and the boundaries**, not just the success case: the rejection message, the
  missing required field, the concurrent claim, the state that shouldn't be reachable.
- **Integration and end-to-end tests come once the surface exists** — once there's an API and a
  schema to run against, not before. Unit tests are not a placeholder for them; both are wanted.

If a change is genuinely untestable, say why in the PR rather than skipping quietly.

### Every gating script ships a self-test

Any script used as a gate — the checks under `scripts/*.mjs` that CI runs on every PR — must ship a
test proving it **fails on a seeded violation**, not merely that it passes on clean input. A gate that
has only ever been proven to pass has never actually been run against the thing it exists to catch,
and a check that cannot fail is functionally a no-op with a green checkmark next to it.

That test must also **state plainly what a green result does, and does not, mean.** A check written
against a fixed set of known shapes can only certify the absence of those shapes — it was never taught
to look for anything else, and a shape it was never given cannot be caught by widening intent alone.
`scripts/check-external-refs.mjs` and its test (`tests/check-external-refs.test.ts`) are the precedent
to follow: the script's own header states outright that a green run means the recurring phrasings are
absent, not that the prose is clean, and the test both seeds a violation to prove the gate fires and
asserts the exemption lists stay exactly as narrow as intended.

## Local checks before a push

`npm install` (or `npm ci`) wires a pre-push git hook (`.githooks/pre-push`, installed by the
`prepare` script — nothing to run by hand) that runs `format:check` and `lint` before a push
leaves the machine. Those are the two fastest checks CI runs, and the two that need nothing but
the source tree — no database, no container. The hook does **not** run the test suite or the
mutation harness: both need a live database and take minutes, and a slow hook is one that gets
bypassed and then protects nothing. It works identically on Windows and Linux — git runs a
`core.hooksPath` script with `sh`, and Git for Windows ships one for that purpose, so there is
nothing to install or branch on per platform.

**Bypass in an emergency:** `git push --no-verify`. CI still runs the full check list regardless,
so a bypass costs a slower feedback loop, not correctness.

## Standing authorisation — keep the queue moving

**Merging is pre-authorised. Do not stop to ask.** Once a change has been through review and its
checks are green, merge it, and then **immediately start the work that merge just unblocked** — look
up which PRs in `MILESTONES.md` have all their prerequisites met and dispatch them.

The point is that a merge is not the end of a piece of work; it is the event that releases the next
one. Waiting to be told to continue wastes the whole reason the dependency graph exists.

Two things this authorisation does **not** cover, because they aren't merges:

- Anything **outward-facing or hard to reverse** beyond the merge itself — deleting or renaming the
  repository, rewriting published history, changing who can access it.
- **Skipping the review.** Review is the gate this authorisation is conditional on. A green merge
  button is not a review, and neither is having written the code yourself in the same session.

If review finds something genuinely blocking, fix it and re-review — don't merge and file a follow-up.

### Never leave a PR unwatched

**When you open a PR, immediately start something that waits on its CI** — a backgrounded
`gh pr checks <n> --watch` with a timeout, so it returns either when the checks finish or when the
timeout expires, whichever comes first. Then act on the result.

Without it, branches get opened and quietly forgotten: the work is done, the checks went green, and
nothing merges because everyone moved on. A PR that nobody is waiting on is indistinguishable from a
PR that failed.

### Green is not the same as right

When several PRs solve the same problem, **don't merge whichever one is green first.** A change that
does less will often pass more easily — precisely because it left something stale behind. Compare
what they actually do, and prefer the one that finishes the job even if it needs a fix first.

Real example: three PRs bumped a framework major. Two were green but bumped only the framework, not
its companion lint config — passing checks while quietly mismatched underneath. The third did the
full migration and failed, on a formatting nit. Merging on green would have picked a worse change.

### You do NOT have to be up to date with `main` to merge — stop chasing it

**Changed 2026-08-13 — a deliberate policy decision by the repository owner. If you have read an
older copy of this file, or were briefed before that date, this section is the one that changed.**

Branch protection on `main` is **no longer strict**. A PR merges when its **required checks pass** and
**git can merge it cleanly** — being `BEHIND` `main` does not block it, and `main` moving while you
work does not invalidate your green run.

**What this means for you:**

- **Do not rebase onto `main` just to be current.** It is not required and it is not wanted. It burns
  a full CI cycle, including the ~9-minute mutation gate, for no gain.
- **Only bring `main` in if you actually need to** — a genuine textual conflict blocking the merge, or
  a fix on `main` your work truly depends on.
- **If you do have to resolve a conflict: resolve it once, push, and hand back.** Do not re-pull
  `main` repeatedly to stay level with it. One builder previously merged `main` **eight times** to
  land a single PR; that is exactly the waste this change removes.
- **Rebase, not merge**, if you do need to integrate — `main` requires linear history, so a merge
  commit still cannot land. When you do:
  - **Expect conflicts in shared files.** `package.json`, `package-lock.json` and config files are the
    usual casualties. Take `main`'s version of anything you didn't deliberately change, then re-apply
    only your own additions on top. **Never revert someone else's landed change to resolve a
    conflict** — if `main` upgraded a dependency, keep the upgrade.
  - **For a lockfile, regenerate rather than hand-merge.** `npm install` after the rebase.
  - **Re-run the full verification after rebasing, not just before.** You are now on code you have
    never tested against.

**The tradeoff you should understand, because it will occasionally land on you.** Requiring
up-to-date branches did catch a real class of bug: two PRs that are each green, each correct, and
cleanly mergeable, but that **do not work together** — one deletes a symbol the other's test imports,
or adds a guard that invalidates the other's fixtures. Git stays silent, because the changes are in
different files.

That class is now caught **after** merging, by `main`'s own CI, instead of before. **This is
deliberate.** Neither PR is wrong; a semantic conflict between two correct changes is a normal
integration event. The accepted posture is:

> `main` goes red → we notice → we put up a small follow-up PR that fixes it. That is cheap and easy.
> Paying a constant tax on **every** open PR to prevent it was not.

So: **if `main` is red and it wasn't you, don't panic and don't hunt for a culprit.** Read the first
lines of the failing CI step — this class is almost always diagnosable straight from there — and open
a fix PR. If your own PR goes red right after someone else merged, it is very likely this, and **it is
not your fault**.

**Required checks still gate everything.** `Build & test`, `Actionlint (required)` and
`Docker build (required)` must pass. Nothing about "green is not the same as right" has relaxed.

### Don't pull the ground out from under a running crew

**A worktree belongs to the agent working in it until that agent has reported.** Do not
`git worktree remove` it, push to its branch, or merge its PR while it is still live — it will keep
working against a directory that has been deleted out from under it, and it cannot tell your
interference apart from a rogue process.

Clean up worktrees only after the agent that owns one has finished. If you must take over a branch
mid-flight, expect the agent's report to be confused about what happened, and say plainly that it was
you.

## Working in this repo

- **`main` is protected.** Linear history, no force-pushes, no deletions, and every change arrives by
  pull request with conversation resolution required. Zero approvals are *required* — GitHub blocks
  self-approval and everything here is authored under one account — so **review is a process gate we
  keep ourselves, not one GitHub enforces.** Don't skip it because the merge button is green.
- **One PR is one piece of work**, from `MILESTONES.md`. Build it in a worktree on its own branch.
- **A PR is available to pick up when everything in its "Needs" column is merged.** That rule is what
  makes the milestone list a work queue instead of a wish list.
- **Migrations are additive.** The whole schema lands as one baseline; change it with an `ALTER`,
  never by editing a migration that has already been applied.
- **Branch from `main`, never from another PR's branch.** CI's `pull_request` trigger filters on
  `branches: [main]`, so a PR opened against a branch that is itself not `main` matches no event and
  runs **zero** checks — and a PR with no runs at all reads as quiet, not red, which is easy to miss
  when several agents are working in parallel here. No checks is not the same claim as checks passed.
  There is also a sharp corollary worth knowing before it happens: merging a parent PR with
  `--delete-branch` **auto-closes any PR still open against that branch**, and this cannot be undone
  by reopening or retargeting the closed PR — the only way out is a new PR opened from the same,
  unchanged branch against `main`. Never rebase onto `main` to try to recover it: an approval is
  granted against a specific set of commit shas, and a rebase mints a fresh set — so a rebase always
  needs a fresh approval to match, whatever the reason for rebasing.
- **Every adapter is a thin shell over a service call.** No adapter may reach the database or a guard
  directly — it resolves input, calls one service operation, and shapes the result for its transport.
  Only the service layer (`src/lib/service/`), the settings resolver (`src/lib/settings/`), and
  migrations/seeds (`prisma/`) may import the database client; everything else, including every
  adapter, calls the service layer instead. This is enforced two ways — an ESLint
  `no-restricted-imports` rule (`eslint.config.mjs`) and an independent import-graph check
  (`npm run check:db-imports`, `scripts/check-db-import-allowlist.mjs`) — so the rule holds even if
  one mechanism is bypassed or disabled. Read this before writing an adapter, not after a failing
  lint: a service call is the only path in.

## Commits

Conventional-commit prefixes (`feat:`, `fix:`, `docs:`, `chore:`, `test:`, `ci:`). Say what changed
and why; the diff already says how.
