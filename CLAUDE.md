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
