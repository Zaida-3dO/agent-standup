<p align="right"><a href="https://github.com/Zaida-3dO/agent-standup/releases/latest"><img src="https://img.shields.io/github/v/release/Zaida-3dO/agent-standup?label=latest%20version&logo=github&logoColor=white" alt="Latest version"></a> <a href="https://github.com/Zaida-3dO/agent-standup/actions/workflows/release.yml"><img src="https://img.shields.io/github/commits-since/Zaida-3dO/agent-standup/latest?label=unreleased%20commits&logo=git&logoColor=white" alt="Unreleased commits"></a> <a href="https://github.com/Zaida-3dO/agent-standup/actions/workflows/release.yml"><img src="https://img.shields.io/github/actions/workflow/status/Zaida-3dO/agent-standup/release.yml?label=latest%20build%20status&logo=githubactions&logoColor=white" alt="Latest build status"></a></p>

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

### The liveness sweep has to be scheduled

**A deployment that never runs the sweep leaks claims that can never be handed
back.** A session takes ownership of an item by claiming it; if that session
crashes rather than releasing, the claim outlives it and every later claim on
that item is refused as already-held. The liveness sweep is what notices — it
ages quiet sessions, releases what died, and escalates what is stuck — and it
runs only when something invokes it. Measured on an installation running without
a schedule: the first manual sweep released **174** stale claims that had been
sitting for three days, every one of them blocking ownership of its item.

**The schedule is the deployment's, not the application's.** The application
deliberately ships no internal timer. It runs as a bundle that may be one
replica or several, so a timer inside it fires once _per replica_ — a multiple
of the intended rate on a scaled deployment, or not at all if the replica
holding it is the one that restarted — and neither mistake produces any output
to notice. A schedule outside the process has exactly one of it, and whoever
owns the deployment gets to decide what runs it.

`docker-compose.prod.yml` ships one: a `sweep-scheduler` service running the same
image, with `scripts/sweep-schedule.mjs` as its command. It calls
`POST /api/sweep` every **`SWEEP_INTERVAL_SECONDS`** (default **300**, five
minutes), giving up on any single attempt after `SWEEP_TIMEOUT_SECONDS`
(default 60). A failed attempt is logged and retried on the next tick — the app
restarting is both the likeliest cause and the moment claims are most likely to
be stranded — but a missing `STANDUP_URL` or a mistyped interval refuses to
start, because that is wrong on every future tick rather than this one.

**If you'd rather use a scheduler you already have**, delete that service and
run either surface on your own timer. Nothing in the application distinguishes
the callers:

```bash
# Host cron, every five minutes — over HTTP:
*/5 * * * * curl -fsS -X POST http://localhost:3000/api/sweep >/dev/null

# …or over the command line, which reports what it released:
*/5 * * * * standup sweep --json
```

The endpoint is `POST` rather than `GET` on purpose: it writes, and a `GET` that
releases other sessions' claims is one a crawler or a browser prefetch will
invoke without anyone asking it to. It takes no input, so an empty body is fine.

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

## What is built

The service layer holds **66 registered operations** (`src/lib/service/registry.ts`). Every rule
lives there, so an adapter is a thin shell over one service call and adds no rule of its own —
which is what makes a refusal the same refusal whichever way in you came.

**The four adapters do not all expose the same set, and the difference is worth knowing before you
pick one.** MCP derives its tools from the registry and so carries 64 of the 66, declining two by
written waiver (`src/lib/adapters/waivers.ts`). The command line routes 46 and the web API 45,
because each maps operations through its own table and those tables lag the registry — `service_info`
and `describe_tool`, for instance, are reachable from MCP and the command line but have no HTTP
route. Ask a running instance rather than taking any of this on trust:

```bash
standup service info --json      # the operation catalogue, and the limits a caller must respect
standup --help                   # every noun and verb, built from the command table itself
```

| Surface          | What it is                                                                                                                                                                                                                                                             |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Web API**      | 45 operations over JSON routes under `src/app/api` — items, claims, transitions, artifacts, events, settings, admin entities. Three further routes are not part of that surface: a liveness check, the MCP transport below, and one that serves the hook script itself |
| **MCP**          | The agent-facing surface, over streamable HTTP (`/api/mcp`) and over stdio. Tools are derived from the operation registry, so there is no second list to forget an operation in                                                                                        |
| **Command line** | `standup <noun> <verb>`, 46 operations, on either of two bindings — over HTTP against a server, or `--direct` against `DATABASE_URL` in-process                                                                                                                        |
| **Front end**    | The board, an item detail view, a since-your-last-visit ledger, a settings editor and an admin section                                                                                                                                                                 |

An item minted through the product walks the full state machine on service calls alone —
`plan_review → executing → in_review → merged` — because the artifacts each transition guard reads
are writable through the service. The rules are enforced in the service layer, so a refusal is the
same refusal on every surface: a missing approving review at tip, a claim already held, or a
completion with no structured summary is rejected identically whether it arrived from an agent, a
terminal or the API.

The schema ships as one baseline migration, and a one-time bulk import (`docs/plans/BACKFILL.md`)
loads a backlog held in an external file-based store.

**Where the edges are.** [`MILESTONES.md`](docs/plans/MILESTONES.md) is the honest inventory: it
carries every row with its status, and the queue is worked in dependency order rather than
front-to-back. Two limits are worth knowing before deploying: the HTTP transport carries no
authentication, so it expects a trusted network (`DECISIONS.md` records the reasoning), and the
liveness sweep needs a schedule the deployment provides — see above, because claims leak without one.
