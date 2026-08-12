# Agent Standup

A task tracker for AI coding agents: a database, a rules engine every change goes
through, an MCP so agents can talk to it, a CLI for the parts MCP can't do, and a
web front end.

**The point:** the rules live in the backend and are _enforced_ rather than
requested. An agent can't skip a step, because the server refuses the change.

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
npx prisma migrate deploy     # apply the committed migrations
npx prisma generate
npm run dev                   # http://localhost:3000
```

### Configuration

Only what must be known before the process can reach a database is an
environment variable — `DATABASE_URL`, plus `HOSTNAME` and `PORT` for what
interface and port the server listens on. `.env.example` lists these and the
handful of others that are genuinely bootstrap (the local Postgres readiness
wait, the disposable shadow database the migration drift check uses).

Everything else is a setting: typed, defaulted in code, and readable and
writable once the app is running, from `/settings` in the front end or
`standup config set` on the command line. A fresh database boots fully
working with no settings configured at all — each one has a default. Setting
an old environment variable that has moved into settings does nothing; a
startup check catches this — it fails immediately in development, and logs
loudly (without stopping the process) in production.

Useful scripts:

| Command                           | What it does                                                                                                                    |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `npm run dev`                     | Next.js dev server                                                                                                              |
| `npm run build` / `npm start`     | Production build / run it                                                                                                       |
| `npm run typecheck`               | `tsc --noEmit`                                                                                                                  |
| `npm run lint` / `npm run format` | ESLint / Prettier (`:check` variants exist for CI)                                                                              |
| `npm test`                        | Vitest                                                                                                                          |
| `npm run db:migrate`              | Create/apply a dev migration (`prisma migrate dev`)                                                                             |
| `npm run db:deploy`               | Apply committed migrations without prompting (`prisma migrate deploy`)                                                          |
| `npm run db:check-drift`          | Fail if `schema.prisma` and `prisma/migrations` disagree — needs `SHADOW_DATABASE_URL` pointed at an empty, disposable Postgres |
| `npm run db:studio`               | Prisma Studio                                                                                                                   |

The initial baseline migration (the whole schema in one shot — see
[`SCHEMA.md`](docs/plans/SCHEMA.md)) lives in `prisma/migrations/`. CI applies it to a
throwaway Postgres on every run and fails if `schema.prisma` and the migration history
have drifted apart.

## Deployment

The image is built by [`.github/workflows/release.yml`](.github/workflows/release.yml)
on a version tag or manual dispatch, and pushed to `ghcr.io/<owner>/agent-standup`
tagged `latest` and the version. The package is public, so pulling it needs no
registry credential. Wherever it runs, pull and run it with
[`docker-compose.prod.yml`](docker-compose.prod.yml):

```bash
GHCR_IMAGE=ghcr.io/<owner>/agent-standup:latest
DATABASE_URL=postgres://user:password@host:5432/agent_standup
docker compose --env-file .env.production -f docker-compose.prod.yml pull
docker compose --env-file .env.production -f docker-compose.prod.yml up -d
```

`docker-compose.prod.yml` has no `build:` block and no bind mounts by design — it
only ever pulls. It ships a health check on `GET /api/health` (liveness only —
deliberately doesn't touch the database, so a slow DB doesn't make the process
report unhealthy).

### Postgres

This app needs its own Postgres reachable via `DATABASE_URL`. Prefer a
**dedicated Postgres instance** over adding a database to one that already
serves another app — it keeps credentials, backups, and version upgrades
independent, and the cost of one more small container is low. Only share an
existing instance if there's a specific reason to (e.g. a hosting limit on
how many database services are allowed).

If Postgres runs as its own container next to this one, order startup with
`depends_on: condition: service_healthy` — the entrypoint runs
`prisma migrate deploy` at boot, which opens a real database connection even
when there are zero pending migrations (expect and ignore
`No migration found in prisma/migrations` until the baseline migration
ships — see `MILESTONES.md`). Give Postgres's own health check a generous
`start_period`: a cold first boot (`initdb` plus the official image's own
internal restart) can take noticeably longer than a short window allows,
which can make `depends_on` give up right before Postgres would have come up
healthy on its own.

### Deploying alongside other services

Some hosts run several unrelated apps under one shared Docker Compose
project rather than one compose file per app — a shared `.env` holding
per-service location/config variables, one compose file defining every
service, sub-folders per service holding data only. If that's the target,
fold this app's service block (and a Postgres block per the section above)
into the shared file instead of running `docker-compose.prod.yml` standalone
— the service definitions are the same either way, only which file they live
in changes. In that setup:

- **Back up the shared compose file first**, before editing it.
- **Never run a bare `up`, `down`, or `restart` with no service names** in a
  directory that already has other services running from that file — always
  name the services you mean to affect explicitly, e.g.
  `docker compose up -d agent-standup agent-standup-db`. An unscoped command
  recreates (or stops) everything the file defines, not just what you're
  deploying.
- **Pick a host port that isn't already in use** — check what the shared
  compose file and the host's listening ports already claim before adding
  `APP_PORT`.
- Keep real secrets (the generated `DATABASE_URL` password, etc.) only in
  that host's own `.env` — never copied into this repo.

## Status

The boilerplate is in place: app skeleton, CI, Dockerfile, and compose files. The
database schema has its initial migration, but nothing queries it yet — the API
surface described in `SCHEMA.md` isn't built. See
[`MILESTONES.md`](docs/plans/MILESTONES.md) for the build order.
