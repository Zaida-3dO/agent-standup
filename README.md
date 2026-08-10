# Agent Standup

A task tracker for AI coding agents. Replaces folders-of-markdown plus a 1,000-line
PowerShell script with a real app: a database, a rules engine every change goes
through, an MCP so agents can talk to it, a CLI for the parts MCP can't do, and a
web front end.

**The shift:** today the rules live in hooks that _ask_ agents to behave. Here they
live in the backend and are _enforced_ — the server refuses the change.

## Docs

Everything is in [`docs/plans/`](docs/plans/):

| Doc                                       | What it is                                       |
| ----------------------------------------- | ------------------------------------------------ |
| [PLAN.md](docs/plans/PLAN.md)             | The readable plan — how it works, in plain terms |
| [SCHEMA.md](docs/plans/SCHEMA.md)         | Tables, config, MCP tools, HTTP endpoints        |
| [DECISIONS.md](docs/plans/DECISIONS.md)   | Every decision with its reasoning                |
| [MILESTONES.md](docs/plans/MILESTONES.md) | The work, broken into pull requests, in order    |

## Stack

Next.js (front end and API in one bundle) · Prisma · Postgres. The image is built
in CI, pushed to GHCR, and **pulled** wherever it runs — never built on the deploy
host, no bind mounts.

## Local development

Requires Node 24 and Docker (for local Postgres).

```bash
cp .env.example .env          # fill in DATABASE_URL etc.
npm install
npm run db:up                 # starts local Postgres on a non-default port
npx prisma generate
npm run dev                   # http://localhost:3000
```

Useful scripts:

| Command                           | What it does                                        |
| --------------------------------- | --------------------------------------------------- |
| `npm run dev`                     | Next.js dev server                                  |
| `npm run build` / `npm start`     | Production build / run it                           |
| `npm run typecheck`               | `tsc --noEmit`                                      |
| `npm run lint` / `npm run format` | ESLint / Prettier (`:check` variants exist for CI)  |
| `npm test`                        | Vitest                                              |
| `npm run db:migrate`              | Create/apply a dev migration (`prisma migrate dev`) |
| `npm run db:studio`               | Prisma Studio                                       |

There's no database migration yet — the initial baseline schema lands in a later
PR (see [`MILESTONES.md`](docs/plans/MILESTONES.md)). `prisma generate` works today;
`prisma migrate` has nothing to apply until then.

## Deployment

The image is built by [`.github/workflows/release.yml`](.github/workflows/release.yml)
on a version tag or manual dispatch, and pushed to `ghcr.io/<owner>/agent-standup`
tagged `latest` and the version. Wherever it runs, pull and run it with
[`docker-compose.prod.yml`](docker-compose.prod.yml):

```bash
GHCR_IMAGE=ghcr.io/<owner>/agent-standup:latest
DATABASE_URL=postgres://user:password@host:5432/agent_standup
docker compose --env-file .env.production -f docker-compose.prod.yml pull
docker compose --env-file .env.production -f docker-compose.prod.yml up -d
```

`docker-compose.prod.yml` has no `build:` block and no bind mounts by design — it
only ever pulls. The full deploy setup (host directory, scoped registry
credential, health check) is its own PR; see `MILESTONES.md`.

## Status

The boilerplate is in place: app skeleton, CI, Dockerfile, and compose files. No
database migration yet, and the API surface described in `SCHEMA.md` isn't built —
see [`MILESTONES.md`](docs/plans/MILESTONES.md) for the build order.
