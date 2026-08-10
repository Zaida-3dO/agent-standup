# Agent Standup

A task tracker for AI coding agents. Replaces folders-of-markdown plus a 1,000-line
PowerShell script with a real app: a database, a rules engine every change goes
through, an MCP so agents can talk to it, a CLI for the parts MCP can't do, and a
web front end.

**The shift:** today the rules live in hooks that *ask* agents to behave. Here they
live in the backend and are *enforced* — the server refuses the change.

## Docs

Everything is in [`docs/plans/`](docs/plans/):

| Doc | What it is |
|---|---|
| [PLAN.md](docs/plans/PLAN.md) | The readable plan — how it works, in plain terms |
| [SCHEMA.md](docs/plans/SCHEMA.md) | Tables, config, MCP tools, HTTP endpoints |
| [DECISIONS.md](docs/plans/DECISIONS.md) | Every decision with its reasoning |
| [MILESTONES.md](docs/plans/MILESTONES.md) | The work, broken into pull requests, in order |

## Stack

Next.js (front end and API in one bundle) · Prisma · Postgres. Same shape as Joda
Creative Studio: image built in CI, pushed to GHCR, **pulled** on the NAS — never
built there, no bind mounts.

## Status

Planning is done; the code isn't written yet. This commit is the plans only.

The build order is in [MILESTONES.md](docs/plans/MILESTONES.md) — ten milestones,
each broken into pull-request-sized pieces with their prerequisites, so the set of
work available right now is something you can work out rather than guess. Setup and
local-development instructions arrive with the scaffold in PR #3.
