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
| **Private project names** | Names of the owner's other repos, self-hosted services, agents, or automation tooling |

```bash
git diff --cached          # read it, all of it, before every commit
```

Treat a finding as a **stop**, not a note to fix later.

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
**never a list of the real values**, per the rule above. It is a backstop, not a proof: reading the
diff is still what catches the rest.

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

### Your PR must be mergeable into `main` as it is *now*, not as it was when you branched

Required checks on `main` are **strict**: a branch has to be up to date with `main` before it can
merge. Passing checks is not enough — a green PR that is `BEHIND` still cannot go in.

**Several agents usually work in parallel here, so `main` moves while you work.** Assume it will. Your
job is not finished when your change works; it is finished when your change works **on top of current
`main`**.

So, before you say you're done:

```bash
git fetch origin
git rebase origin/main          # force-pushing your own feature branch is fine — only main is protected
```

- **Rebase, don't merge.** `main` requires linear history, so a merge commit can't land.
- **Expect conflicts in shared files.** `package.json`, `package-lock.json` and config files are the
  usual casualties, because dependency and tooling changes touch them constantly. Take `main`'s
  version of anything you didn't deliberately change, then re-apply only your own additions on top.
  **Never revert someone else's landed change to resolve a conflict** — if `main` upgraded a
  dependency, keep the upgrade.
- **For a lockfile, regenerate rather than hand-merge.** `npm install` after the rebase. A
  hand-resolved lockfile is unreliable.
- **Re-run the full verification after rebasing, not just before.** You are now on code you have never
  tested against. A rebase that quietly breaks the build is worse than being behind, because it looks
  finished.
- **If `main` moves again while you're waiting on review, rebase again.** Being current is a state you
  hold, not a step you complete.

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

## Commits

Conventional-commit prefixes (`feat:`, `fix:`, `docs:`, `chore:`, `test:`, `ci:`). Say what changed
and why; the diff already says how.
