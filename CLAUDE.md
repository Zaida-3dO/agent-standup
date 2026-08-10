# CLAUDE.md — Agent Standup

A task tracker for AI coding agents. Next.js (front end and API in one bundle) · Prisma · Postgres.
Image built in CI → pushed to GHCR → **pulled** on the server. Never built on the server, no bind
mounts.

Plans live in [`docs/plans/`](docs/plans/): `PLAN.md` (how it works), `SCHEMA.md` (tables, config,
endpoints), `DECISIONS.md` (why), `MILESTONES.md` (the work, as PR-sized pieces with prerequisites).

---

## ⚠️ This repository is PUBLIC

Anything committed here is world-readable **the moment it is pushed, and permanently** — deleting it
in a later commit does not remove it, because the old commit is still in the history. Assume anything
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
