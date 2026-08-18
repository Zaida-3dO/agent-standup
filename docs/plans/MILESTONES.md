# Agent Standup — milestones and PR plan

Ten milestones. Each is a **feature you can point at** ("the database is ready", "agents can talk to
it"). Each contains PRs, and **one PR is one mergeable branch** with its own review.

Every PR lists what it delivers and what it needs. **A PR is available to pick up when every PR it
needs is merged** — that rule is the whole point of the format, so an agent can compute the work
queue without asking anyone.

Status legend: `done` · `open` · blank = not started.

---

## How to find work

```
available = PRs where status is blank AND every id in "Needs" is done
```

Prefer the lowest-numbered available PR unless something else is genuinely more urgent — the
numbering is roughly the critical path. **Two PRs on the same milestone rarely conflict; two on
different milestones almost never do**, which is what makes parallel crew safe here.

**Numbers are allocated in the order work was planned, not in the order it should be done.** #77–#94
were appended rather than interleaved, because renumbering would invalidate every `Needs` reference
in this file — so **#77, #85 and #91 are all early work despite their numbers**. The `Needs` column
is what gates; the numeric heuristic is only a tiebreak among rows that are already available.

Every PR after #1 is a branch and a pull request. Build in a worktree, get it reviewed, merge.

---

## M1 — Infrastructure

*Feature: the repo builds, ships an image, and runs on the NAS.*

| PR | Delivers | Needs | Status |
|---|---|---|---|
| **1** | Public repo on GitHub, **docs only**, committed straight to `main` | — | `done` |
| **2** | Branch protection on `main` — linear history, no force-push, no deletions, PR required | 1 | `done` |
| **3** | **The boilerplate.** App skeleton, Prisma wiring, Dockerfile, compose, CI workflow, GHCR release workflow, test harness, lint/format | 2 | `done` |
| **4** | Required status checks pointed at the CI jobs from #3 | 3 | `done` |
| **5** | First published image — trigger a release, pull it, verify it runs | 3 | `done` |
| **6** | Deploy to the NAS project directory — compose, production env file, scoped credential, health check | 5 | `done` |
| **95** | **Mutation testing**, wired into CI and scoped to changed files, with a threshold that blocks the pull request below it. Reads the mutation report's own kill attribution rather than a process exit code, so a mutant only counts as killed when a named test caused it — the same shape a whole-suite collection failure would otherwise misreport as a perfect score. Every run also checks a dedicated no-op fixture and refuses to trust its own numbers if that fixture is ever reported killed | 3 | `done` |
| **97** | **Application logging.** One JSON object per line on stderr, the conventional five levels (`debug` `info` `warn` `error` `fatal`) with a `LOG_LEVEL` threshold defaulting to `info`. Carries the operator-facing detail the error taxonomy deliberately withholds from clients — above all the `cause` an `InternalError` preserves — plus the request context needed to follow a single request through the layers it touched. Wired at the boundaries a failure actually crosses: the API error responder, the rules engine's refusals, and the adapters | 3 | `done` |
| **129** | **Request ids that survive the hop, and come back to the caller.** Two follow-ups #97 deliberately left, recorded here because a note under a `done` row has no reader. **(a)** The CLI’s `http` binding mints a request id for its own lines and does **not** send it to the server, and no route reads a caller header — so the two processes log correlated lines that cannot be joined. End-to-end correlation needs a server that reads the header, not just a client that sends one. **(b)** No route echoes a request id back (`X-Request-Id`), which is the thing that lets a bug report name the exact call it came from — directly useful given how much of this product’s feedback arrives as *"I called X and got Y"* | 97 | `done` |
| **127** | **Silence that reads as "not started yet", by a second route — plus a real flake.** Two things found on the same session. **(a) A conflicting PR runs zero checks**, which is byte-identical to CI not having started. `CLAUDE.md` already warns about this failure mode and names *one* of its two causes — a PR based on a branch that is not `main` — so a reporter who had correctly ruled that cause out went looking at trigger filters and Actions rate-limiting before thinking to ask whether the PR was mergeable at all. **The documentation being right but incomplete sent them the wrong way, which is worse than not covering the case**, and the second route is the *more* likely one here: several PRs merge per hour, so a branch acquiring a conflict between opening and CI starting is routine. Fix is one line in the same paragraph — **when no checks appear, check `mergeable` first** (`gh pr view <n> --json mergeable,mergeStateStatus`). **And this is intervention-shaped, not documentation-shaped** (2026-08-15): *a PR with no checks that is also unmergeable* is a situation the server can detect, so it is filed in `INTERVENTIONS.md` as well — a doc line relies on someone remembering, which is exactly what failed here. **(b) `tests/hook-built-script.test.ts` is genuinely flaky**, with evidence rather than reputation: four CI runs of the same unchanged commit failed **a different subset each time** — a missing `dist/bin/standup-hook.js` artifact, then `exits 2 on empty stdin`, then two stderr/corrupt-cache assertions, then `exits 2 with no cache file` and `exits 2 when the server is unreachable` — against 12/12 locally on the same branch with nothing in the diff touching the hook path. The first run's missing-module failure suggests the build artifact, not the assertions, is the variable. Filed from field feedback, 2026-08-14. **(b) resolved as already-fixed, on evidence rather than assertion.** The instinct the first run pointed at was right — it was the artefact, not the assertions. `dist/` had two writers racing one spawned binary, and every cited failure is what that binary does when its chunk is deleted from under it, which is also why the failing subset varied per run. Both writers were closed on 2026-08-14, hours after this row was filed and before it was picked up: the build moved to a single pre-worker call (`8a0ae48`) and `npm pack` gained `--ignore-scripts` (`a0bd7f7`). Verified rather than assumed — 21/21 across eight consecutive local runs, ~220 spawns of the built hook across every fail-open branch serially and under concurrency with zero anomalies, and green on every CI run of the file since. **Nothing was papered over: no retry, no loosened assertion, no timeout raised.** What landed instead is the part that was missing — the `--ignore-scripts` invariant is now asserted rather than only explained in a comment, since a comment cannot fail, and the file's header records the signature (varying failures, one artefact) so a third writer is suspected before these assertions are | 42, 95 | `done` |
| **133** | **A readiness endpoint, distinct from liveness.** `GET /api/health` is deliberately liveness-only and avoids the database, which is the right design for the question *is this process alive* — and the wrong answer to the question every caller actually asks, which is *can I use this yet*. A process whose Postgres is still initialising returns `200` from it. **The two must not share a route**, because a deployment gate, a compose `depends_on` healthcheck and a load balancer all want readiness while a restart policy wants liveness, and collapsing them means one of the two consumers is silently wrong. Add a readiness route that does the cheapest real query — the same connection the service layer would use — and report the migration state with it, since *migrated and ready* and *connected but two migrations behind* are different answers and only one of them is safe to send traffic to. Filed from external field feedback (`feedback/other system.md`, F14) | 8, 97 | |
| **134** | **Auth on the HTTP transport, per machine — the multi-host enabler, not a security to-do.** `DECISIONS.md` §5 defers auth as *"reachable on a trusted network without a token for v0"*, which was a reasonable call about exposure. **What it did not anticipate is what a remote client does in its absence: connect to Postgres directly.** That is not defeating a check, it is never reaching the code that checks — every guard in this product is application code in the service layer, and Postgres does not know they exist. A remote client on `DATABASE_URL` can set an item to `merged` with no commit, no review and no summary. **#85 already enforces that only the service layer may import the database client, by lint and by an import-graph test with a deliberately broken fixture** — so the invariant is taken seriously within one process and breaks silently across hosts, purely because there is no authenticated remote path for it to break in favour of. **Database-level permissions cannot substitute:** a restricted role can block a write but cannot express *allowed only with an approving review at tip*, because that is conditional on state Postgres cannot evaluate. **Per-machine bearer tokens rather than one shared secret** — `machines` is already a first-class entity with a name, so a token per row gives revocation and attribution for free, and turns an unread `X-Standup-Actor` header from advisory into trustworthy. The thin-client architecture is already built (`mcp/http.ts`, `cli/bindings/http.ts`, the transport-agnostic core); this is an auth header and a documented rule, not new architecture. **Ships with the doc half or it does not ship**: remote clients use the API, never `DATABASE_URL`, said somewhere a reader meets it before they reach for a connection string. Filed from external field feedback (`feedback/other system.md`, F15, F16, F11) | 26, 79 | |
| **135** | **The README materially understates the product, and it is the cheapest fix on the list.** It says nothing queries the database yet and that the documented API surface is unbuilt. The tree at `6a0e976` is ~42k lines of source, 83 of 129 milestone rows `done`, a working MCP adapter, a working command line, a rendering board and 217 imported items. **A first-time reader concludes “scaffolding only” and stops** — which is the highest-leverage wrong impression in the repository, because it is the only document most people will ever read and it is the one deciding whether they read a second. **Two smaller instances of the same staleness, worth sweeping in the same pass:** the README's own *known gaps* list still names open-loop writes as missing, and `loop_add`/`loop_close` have been live since 0.7.0; and `src/lib/interventions/types.ts` carries `IntervnetionContext` as a typo in the header paragraph explaining the contract a future implementer reads. Filed from external field feedback (`feedback/other system.md`, F1, F7) and `feedback/processed/ui-feedback.md` | — | |

**Milestone done when:** a merge to `main` produces an image the NAS can pull and run, and nothing
reaches `main` without passing checks.

---

## M2 — Data layer

*Feature: the database exists, and a backlog held in an external file-based store can be imported
into it.*

| PR | Delivers | Needs | Status |
|---|---|---|---|
| **7** | Initial migration — the **whole schema** in one baseline | 3 | `done` |
| **8** | DB client, connection pooling, migrate-on-boot wiring | 7 | `done` |
| **9** | Seed: `people` (two user profiles), `agents` name roster, `accounts` | 8 | `done` |
| **10** | Importer — items: a directory-per-task store → `items`, status remap, the source identifier into `custom_fields`. Resolves repositories and areas through the reference tables, mapping aliases of one repository as it goes rather than importing them as distinct values | 8, 91 | `done` |
| **11** | Importer — events: the source store's history log → `events`, actor mapping | 10 | `done` |
| **12** | Importer — assignments and artifacts: claims, roles, review files | 10 | `done` |
| **13** | Import verification: row counts, spot-check report, idempotent re-run | 11, 12 | `done` |
| **91** | **`repos` and `areas`.** Two reference tables and the two foreign keys; deliberate create for a repository, auto-create-with-normalisation for an area; the missing index on `items.repo`; near-duplicate surfacing | 8 | `done` |
| **124** | **`defaultBranch` was a guess, and it was wrong.** Every imported repository row carried the same `defaultBranch` value, across a set in which the real values demonstrably differ — several were on `main` while the record said otherwise for all of them. The uniformity across every row on a workspace where they are not uniform read as a constant written at import rather than a value read from the repository. Three parts, all shipped: **the rows were corrected** against their actual checkouts; **the importer now reads the branch** (`git symbolic-ref refs/remotes/origin/HEAD`) rather than defaulting, and the backfill runner mints an unread repository with `defaultBranch: null` rather than a guessed value; and **the column was made nullable**, because this field is consumed at PR-creation time and an absent value makes a caller ask while a wrong one makes it proceed confidently. **The failure was quiet and landed late** — `git checkout -b x master` fails immediately and loudly, but `gh pr create --base master` against a `main` repo fails after the branch is pushed and the work is done, or writes the wrong base into a PR body nobody re-reads. It also got no friction signal from its surroundings: this installation's own root `CLAUDE.md` documents `git push origin master` for another repository, and the workspace genuinely was on `master`, so the record agreed with the wrong belief. Filed from field feedback, 2026-08-14, where the cost was near zero **by luck** — the reporter happened to run `git status` in the same breath, minutes before briefing three crews on the wrong base | 91, 92 | `done` |

**Settled:** finished items import as a **collapsed summary**, one row each; in-flight and blocked
items import in full. The import reads its source and never writes to it, so the detail can be
backfilled if it turns out to be wanted. See `DECISIONS.md` §13c.

---

## M3 — Rules engine

*Feature: the server enforces the rules. No surface yet — this is the core everything else calls.*

| PR | Delivers | Needs | Status |
|---|---|---|---|
| **77** | **Settings core.** `settings` + `settings_revision` tables (additive migration), the typed registry with schema/default/label/help/category/`appliesWhen`/`sensitive`/`irreversible`/`formerEnv` per key, resolution into a frozen typed snapshot, the revision-based cache, and the registry's own test (help present, defaults valid, no credential-shaped key, no unmapped prefix). **Also the two per-entity override columns** — `machines.source_globs` (`text[]` null) and `accounts.budget_windows` (`jsonb` null), in the same additive migration and validated by the same registry validator, because they are the second half of the same mechanism and `SCHEMA.md` §17.7 has nothing to point at without them. No surface — this is what the service layer reads | 8 | `done` |
| **85** | **The import allowlist and its negative control.** Only the service layer, the settings resolver, and migrations and seeds may import the database client — enforced by lint and by an import-graph test, with a fixture that deliberately breaks it and is asserted to be caught. **Plus the rule itself stated in `CLAUDE.md` under *Working in this repo*** — every adapter is a thin shell over a service call, and no adapter may reach the database or a guard directly — because a contributor needs it before writing code rather than from a failing lint | 14 | `done` |
| **14** | Service-layer skeleton, transaction handling, typed errors. Delivers the **operation registry** — the canonical index of service operations, which the conformance harness checks adapters against — and resolves one settings snapshot per call | 8, 77 | `done` |
| **15** | State machine: all-to-all transitions, guard framework, rehearsal mode. Projects have **no stored state** — theirs is derived from their children, so guards never run against one | 14 | `done` |
| **16** | Guards — blocked and paused: required fields, clearing on exit | 15 | `done` |
| **17** | Guards — artifacts: review requested, plan approval, evidence at the tip commit | 15 | `done` |
| **18** | Guards — merge: commit, approving review, visual gate, who may authorise | 17 | `done` |
| **19** | Guards — hierarchy: cannot finish while a child is still actionable | 15 | `done` |
| **20** | Events: append on every mutation, field-change rows, timestamps in the same transaction. Rows carry `tx_id`, the identifier of the writing transaction, so a reader can bound itself to the visibility horizon (`SCHEMA.md` §3) | 14 | `done` |
| **21** | Summaries: shape, caps, reject-don't-truncate, similarity check, jargon denylist | 15 | `done` |
| **22** | Deferral proof for anything left undone — typed reasons, follow-up must be blocked | 19, 21 | `done` |
| **23** | Claims: atomic, one orchestrator per item, root-session check — **also carries the two partial unique indexes deferred from the initial migration** (`SCHEMA.md` §2; `DECISIONS.md` §13d) | 14 | `done` |
| **24** | Liveness ladder: quiet → stalled → dead, resume attempts, escalation to blocked. The same sweep re-verifies configured capability document paths and records `{ last_checked_by, last_checked_at, result }` | 23 | `done` |
| **25** | Notification rules: all-of / any-of, fires on the edge only, whitelisted fields | 20 | `done` |

**Milestone done.** Every guard in `SCHEMA.md` has a passing test, including the rejections.

**Carried in from PR #7 (initial migration):** Prisma can't express partial unique indexes, so the
one-live-orchestrator and one-row-per-session-per-item constraints on `assignments` aren't in the
baseline schema or migration. PR #23 must land them — either a documented hand-written migration with
the drift check taught to tolerate that one exception, or application-level enforcement, which is not
race-proof on its own. See `DECISIONS.md` §13d.

---

## M4 — Agent surface

*Feature: an agent can do real work through MCP.*

| PR | Delivers | Needs | Status |
|---|---|---|---|
| **26** | Items — the service calls and their routes: create, read, update, list with filters. Also delivers the **adapter registry**, the module the application mounts adapters through and from which `AdapterName` is derived | 14 | `done` |
| **27** | Transition and complete — the service calls and their routes, with rehearsal mode | 15, 21 | `done` |
| **28** | Orientation — the service call and its route: checkpoint, state, what changed, open loops, crew. **Also my-work** — what this session holds right now and in what role — which no other row owned: it is the same session-scoped read over assignments and events, not a filter on the item list, because it answers *in what role* as well as *which items* | 20, 23 | `done` |
| **29** | Claim, release and heartbeat — the service calls and their routes. **Also the checkpoint and note write path**, which no other row owns: #28 delivers orientation, which only *reads* checkpoints | 23 | `done` |
| **30** | MCP adapter — a transport-agnostic server core (tool registration and handlers calling the service layer), wired to streamable HTTP. **Stateless.** The stdio wiring is #84 | 26 | `done` |
| **31** | MCP read tools: get item, list items, my work, orientation | 28, 30 | `done` |
| **32** | MCP write tools: create, update, transition, complete | 27, 30 | `done` |
| **33** | MCP session tools: claim, release, heartbeat, checkpoint, note | 29, 30 | `done` |
| **34** | Crew naming: hand out a name, assign it, retire it | 9, 14 | `done` |
| **78** | Settings service and its routes — `GET`, `PATCH` (a map, one transaction), `PUT`/`DELETE` for the one-key case — with write-time validation including the capability documents, the `setting-change` audit event, and the revision bump in the same transaction | 20, 77 | `done` |
| **79** | **Command-line foundation.** The `standup` entry point, `<noun> <verb>` dispatch with aliases, both bindings (`direct` over the service layer, `http` over the API) behind one interface, `--json` envelope and exit codes, identity resolution, configuration precedence, preflight, and `standup doctor` — which also re-checks configured capability paths locally | 14, 26 | `done` |
| **80** | `standup init` — find, accept or provision a database; create it; migrate; seed; write local configuration; prove it with a live round trip. Asks for a provisioning connection separately from the application role, and falls back to a supplied connection string rather than abandoning | 9, 79 | `done` |
| **81** | Command line: items — list, get, create, update, transition with `--dry-run`, complete | 15, 21, 26, 27, 79 | `done` |
| **82** | Command line: ownership and orientation — claim, release, heartbeat, checkpoint, note, my-work, orientation, crew name | 23, 28, 29, 34, 79 | `done` |
| **83** | `standup config` — list, get, set, clear, describe, rendering label, help and validation from the registry; `sensitive` and `irreversible` keys require the confirmation flag | 78, 79 | `done` |
| **84** | MCP over **stdio**, wiring the same transport-agnostic server core as the HTTP transport | 30, 79 | `done` |
| **90** | **Retiring the environment variables.** A startup check, derived from the registry's `formerEnv` entries, that fails in development and logs loudly in production when a retired name is still set; plus `.env.example`, the production compose environment block, and the README's configuration and database-requirement sections | 77 | `done` |
| **92** | **Administration API and command line** for installation-owned entities — repositories, areas, machines (including `source_globs`), accounts (including `vendor`, validated against the registered adapter list, and `budget_windows`) | 79, 91 | `done` |
| **98** | **Artifact writes.** One `record_artifact` service call and its routes/tools/verb — `{itemId, kind, verdict?, reviewRound?, commitSha?, body?, ref?}` — plus an emitter for the `review_requested` event. **The importer is the only writer of the artifacts table**, so #17's three guards refuse every item minted through the product: `→ in_review` wants a `review_requested` event, `plan_review → executing` wants an approved plan artifact, `→ merged` wants a commit artifact and an approving code review at round+tip. One operation clears all three | 17, 20, 26 | `done` |
| **99** | **Run the liveness ladder.** #24 built `sweepLiveness` and nothing calls it. Give it a trigger — a `standup sweep` verb and a scheduled or hook-driven invocation — so a dead session's claims are actually reclaimed. Until then a crashed session's claim is permanent: the claim insert is `ON CONFLICT DO NOTHING`, so every later claim on that item is refused as already-held with no path to release it. **Also forced takeover** — displacing a holder the ladder is not going to release. A dead holder is taken over cleanly; a possibly-alive one requires an explicit `force` **and** a written `reason`, both recorded against the displaced assignment (`superseded_by`, `liveness = superseded`, `released_at`) and in a `takeover` event. That recorded state is what an enforcement hook reads; **the hook itself is #42 and does not exist, so a displaced live session is not yet prevented from continuing** | 24 | `done` |
| **130** | **Schedule the liveness sweep, and test who it says did it.** #99 shipped the verb, the route and the MCP tool, and a dead session’s claims can be reclaimed — but **nothing invokes it periodically**, on the argument (in `sweep.ts`’s own header) that a schedule belongs to the deployment rather than a per-replica timer. Until something does, a crashed claim is *reclaimable* but not *reclaimed*, which is the state an operator actually experiences. Confirmed live 2026-08-15: a manual `sweep` released **174** stale claims that had been sitting since 2026-08-12 — every one of them blocking ownership of its item. **Also from the same review:** the sweep’s actor attribution has no test at all — two mutants hard-coding it survived the whole suite | 99 | `done` |
| **100** | **Open-loop writes.** `loop_add` / `loop_close` over the `open_loop` / `open_loop_closed` events, with their routes, tools and verbs. The payload validators, the pairing logic and #28's read path all exist; only the write is missing, so `orientation` can display a loop nobody can record. Also add the `SCHEMA.md` section both modules cite as `§3a`, which does not exist | 20, 28 | `done` |
| **101** | **Wire the notification evaluator.** #25 built `evaluateRules` and named the service layer as its caller "once #27 lands transitions"; #27 landed without it, so nothing evaluates a rule and `people.notify_rules` is never read. Thread the before/after field snapshot from transition and update into it — the evaluator's own header documents the field-name casing the caller has to handle | 25, 27 | `done` |
| **102** | **Route the four raw event writes through the one writer.** `create_item`, `update_item`, `transition_item` and `complete_item` insert into `events` directly rather than through `appendEvent`, contradicting that module's stated invariant. Their column list omits `session_id`, `assignment_id` and `body`, so every state change and field change lands with a null session — making "who moved this" unanswerable in #28's `whatChanged` for exactly the mutations most worth attributing. Also gives `recordFieldChanges` its first caller | 20 | `done` |
| **103** | **Terminal items out of the default read.** `get_board` and `list_items` return finished work on every call — it is the majority of the payload and the share only grows, because nothing prunes terminal state. Exclude terminal states by default, with an explicit opt-in (`--all` / `includeTerminal`) for the cases that want them, and apply the same default to the board's completed column. A filter and a default, not new machinery | 26, 36 | `done` |
| **104** | **An event type cannot be added without an emitter.** A gating script, with the self-test every gate here ships: enumerate the event-type enum, enumerate what the service layer actually emits, and fail on a value nothing writes. `SCHEMA.md` §3 already states the rule — *add an event type only when the code that emits it exists* — and #98–#102 are what it costs when nothing checks it: a capability declared, validated, guarded and displayed, with no writer. Per-row status cannot show a gap between rows; this can | 20 | `done` |
| **105** | **Search over items** — `search` as a service call and its routes/tools/verb, indexing title and body and returning ranked matches. Answers "there is a task about this somewhere", which is otherwise unanswerable without pulling every item; the need is sharpest for a session reading a corpus it did not create. **Title and body first, deliberately** — checkpoints, events and artifacts are a substantially larger corpus and a substantially larger piece of work, and are worth attempting only once the cheap index is shown to be insufficient | 26 | |
| **94** | **Adapter conformance harness.** Drivers behind a map typed from the adapter registry; cases authored once per operation, run against every driver; four assertions — identical outcomes by `code`, `guard` and fields · accept-and-reject per operation · **every registered guard covered by an observed rejection** · adapter completeness with bounded waivers — plus a negative control per assertion and a non-empty-guard-registry assertion | 26, 27, 29, 81, 82, 85 | |
| **107** | **P0 — The slim read is the default, and a headline is what it returns.** Two halves of one change. **The field:** `items.headline`, a short BLUF written when the item is minted and maintained as it moves — what this work *is*, in one line, distinct from `body` (the brief) and from `Summary` (which is end-of-life and exists only once the item completes). No field answers "what is this?" without reading a 15KB brief. **The read:** every item read returns `{id, title, state, headline}` and the latest checkpoint's own headline by default; the full record is opt-in. `ITEM_COLUMNS` (`items/row.ts`) is one hardcoded 30-column `SELECT` shared by `get_board`, `list_items` and `get_item`, and `toItemRecord` maps every field unconditionally — so `body` and `customFields` come back on every call from every surface. Measured: one `get_item` at 145,317 chars of which `customFields` was 94,038 and `body` 49,538, the eight scalars actually wanted 0.2%. **Pagination cannot fix this and #103 does not touch it** — those items were `executing`, not terminal, and `limit` bounds row count while nothing bounds row size, so `limit: 1` on the largest item still overflows. Precedent is in-tree: `orientation` already selects `id, title, state` for child lists and reserves the full record for the one focal item | 26, 36, 103 | `done` |
| **108** | **P0 — Checkpoint headlines.** `events.headline` for `type = 'checkpoint'` — the one-line BLUF of what changed, beside the prose already in `body`. A checkpoint is `events WHERE type='checkpoint'` (`SCHEMA.md` §3) and its prose is free text, so "where is this up to?" cannot be answered without reading every checkpoint in full. Latest-checkpoint is already an indexed single-row read, so #107's default shape can carry it for the cost of a join. Also what the board card and the item detail view show without expanding | 20, 107 | `done` |
| **109** | **P1 — Every read is bounded, and a test proves it.** `get_board` has no `limit` and no `cursor` at all — after #103 it still returns ~542,000 characters on the current corpus. Give every list-shaped read a default bound and a cursor, and, as the row that stops this recurring, **a test that asserts every registered read operation returns a tenable payload against a realistic corpus** — the assertion being about response size, not about row count, since row count was never the thing that overflowed. `list_items` already has `limit`/`cursor`; the pattern exists in the codebase and did not reach the others. **The design the owner specified, 2026-08-15 — two parts, and they apply to the API and the tools alike.** **(1) A board is many paginated reads, not one big one.** `get_board` returning every column in a single call is the wrong shape even once it is bounded: the front end should request **one paginated page per section** — backlog, in flight, in review, done — each returning its page *and its total count*, so the count renders at the top of the column and a *show more* control pages the rest. A column that is 68 items long and a column that is 3 items long then cost the same first paint, and no caller pays for a section it is not looking at. **(2) The default slice is open work, and everything else is asked for explicitly.** Not merely non-terminal, which is what #103 delivered — **backlog is excluded by default too.** With no filters, a read answers *"what is being worked on"*: in flight, in review, blocked, and anything waiting on a person. Backlog needs an explicit ask, completed needs an explicit ask, and finding a specific item is `search` (#105). As framed: *"if I just want to ask what's the score on the board, I typically want to ask which tasks are open — that should be the default behaviour if no filters are provided."* **(3) The response says where the rest is.** A default read states what it withheld and names the call that returns it — *"showing 12 open items; backlog via …, completed via …, or search"* — which is the same self-routing principle as #111's refusals, applied to a successful read rather than a failed call. Without it, a narrower default is just a different way to hide things | 26, 107 |`done` |
| **110** | **P1 — Stop shipping every MCP payload twice.** `toolSuccess` (`mcp/result.ts`) returns each success as both a 2-space-indented `text` rendering *and* `structuredContent`, because clients are split on which they read. That doubles every response on the wire and the indentation inflates it further — the measured 1.9M-character board read may be the `text` half of a substantially larger payload. Emit compact JSON, or make the dual emission conditional on size. Independent of #107–#109 and the cheapest of the four | 30 | `done` |
| **111** | **P1 — Tool documentation on demand, and defaults that carry.** Two answers to the same problem, chosen so neither inflates the context it is trying to protect. **On demand — shipped.** The advertised `inputSchema` is already complete and correct — verified over a live `tools/list` — so what is missing is not the schema but the rules JSON Schema *cannot express*: `create_item`'s `originType: "person"` → `originPersonId` refinement, and `complete_item`'s entire conditional matrix (`shipped` 1–5, `how_verified` required only when `user_facing` is false), both enforced in runtime validators and invisible to a client. A `describe_tool` call (`src/lib/service/operations/describe-tool.ts`) returning the full contract for one named tool keeps that out of every turn's context, which is what a fatter description would cost (`PLAN.md`: every description sits in the agent's context on every turn). **Defaults that carry — NOT shipped, row stays open.** A session declares once at `POST /sessions/{id}/register` — autonomous or person-driven, and which person — and subsequent calls should inherit it rather than restating it. `driveMode` already exists as a column and the handshake already exists as a route, so this is threading a resolved default, not new machinery. Verified 2026-08-15: `register_session` stores `personId` on the `Session` row, but no creation operation reads it back — `create_item`/`create_project`/`create_task`/`create_subtask` still require `originPersonId` and `driveMode` on every call with no session-level fallback. Marking this row done would misstate it; only the documentation half landed. Also reword the summary guard's "and the branch it forces", which means a conditional branch and has been read as a git branch | 30, 43 | |
| **116** | **The `people` write path.** `people` was the only entity in the system with a reader and no writer: #35 delivered `list_people` and nothing could put a row in the table — the write path was absent at the service layer, not merely unexposed by an adapter. Three capabilities were dead as a result, and the third loses data rather than merely blocking. The profile picker (§8a) hard-gates the UI on an empty table. `merge.requires_authorisation` needs a *person* to record an approving `code_review` artifact, so no `needs_approval` item could reach `merged`. And **`create_item` accepts `originPersonId` with `originType: "person"` and verifies the person exists** — unsatisfiable with no way to mint one, so every item had to claim `source` or `auto` origin even when a human asked for it, silently mis-recording provenance for as long as the gap stood. One `update_person` upsert keyed on the caller-supplied id, spelled like `update_machine` and `update_account` (its two closest siblings, both `INSERT … ON CONFLICT DO UPDATE` on a natural id) rather than as a deliberate `POST` like `create_repo`; `displayName` required to create and optional to edit; archive and un-archive, which `list_people` already filters on. `notify_rules` is validated in the **stored** `when_all`/`when_any` spelling — storing #101's camelCase would parse to a rule with no conditions, which `parseStoredRules` then drops, so it fires **zero** times: configured, and silently notifying nobody | 35, 92, 101 | `done` |
| **138** | **Closing work that finished before this system existed.** A JCS board audit ran twice — 2026-08-15 and again 2026-08-18 — and **closed nothing both times**, by two independent mechanisms. #157's `retype_to_task` and `reparent_item` fix the first (imported parentless items typed as childless projects). **The second is still open and is the one this row is for:** completing a task needs a `commit` artifact *and* an approving `code_review` artifact at the current tip, and for work merged weeks ago under a process that predates this product, no honest reviewer exists to have written one. **The guard is right and must not be relaxed for live work** — it is the only thing stopping unreviewed code being called done, and letting agents self-approve would destroy the single guarantee it provides. **What makes this urgent is the pressure it applies.** The 2026-08-18 auditor reported that it could have recorded a `code_review` with `verdict: approved` and closed two items in one call, and *nothing in the product would have detected it*: *"the guard's entire value rests on an agent choosing not to do the thing that makes its inconvenience go away — and it applies that pressure hardest in exactly the situation where the approval would be least meaningful."* It declined and ran a real adversarial review instead, converting a 30-second bookkeeping task into a full review cycle. **A design whose failure mode is a forged approval should not depend on good manners.** The answer is a distinct artifact kind — `historical_verification` — carrying the evidence that was actually available (PR number, files checked, tip SHA, who verified and how), which satisfies completion for an item whose work predates the requirement **without ever pretending a review happened**. The audit trail then says *verified by inspection at tip X*, which is true, instead of *approved by a reviewer* who never existed. **The cost is already recursive:** two sessions have now re-derived the same conclusions about the same items because neither could write them into `state`, the second at ~76k tokens, and it will recur on every orientation until this lands. From `feedback/2026-08-15-imported-items-are-projects-and-can-never-be-closed.md` | 17, 18, 21 | |
| **139** | **Two refusals on the completion path that have no satisfiable answer between them.** Both found while closing genuinely merged PRs, both reproduced by a second session three days later, and neither is a guard protecting the wrong thing — they are a gap between two guards and a missing sentence in a third. **(a) `not_done` with `reason: "follow-up"` is refused whichever way you send it.** Without an `item_id`: *"requires a minted item_id"*. **With** a minted, open, linked `item_id`: *"You're deferring this, but nothing is blocking it. Is there a good reason you didn't just do it now? If not, go back to executing and finish it."* The field one error demands is the field the next rejects, and the remedy the second offers does not exist — the PR is merged, there is nothing to go back to. The other `reason` values are all false: `needs-approval` is not true, `descoped` would be a lie in a permanent record. **The observed workaround produces a strictly worse record** — drop `not_done` and write the deferral into `watch_for` prose, losing the machine-readable link, which is exactly what `not_done` exists to preserve. A linked open follow-up is the intended encoding of *lgtm with follow-ups*; it should be accepted rather than lectured at. **(b) A squash merge invalidates the approval that was honestly recorded.** Record the `code_review` at the branch tip the reviewer actually reviewed, then merge, and the item's tip becomes the merge commit: *"The most recent code_review approval is not for the current review round (1) and tip commit — the item has moved since it was approved."* **The guard is correct and its message is one of the best in the product**, but the resolution is a puzzle rather than a step, and the honest workaround (a second artifact re-anchoring the same verdict to a content-identical sha) has to be invented by each session that hits it. Two candidate fixes, either sufficient: **accept an approval whose sha is the squashed ancestor of the current tip**, which the server can determine; or add one line to the refusal — *a squash merge creates a new sha; re-anchor the approval to it*. **And a discoverability note that spans both:** the working sequence took nine sequential rejections to find, each revealing exactly one more requirement, and a single upfront validation listing everything missing would have made it one round trip. From `feedback/2026-08-15-complete-item-follow-up-guard-has-no-satisfiable-path.md` | 21, 22, 27 | |
| **113** | **P1 — A round trip that is not ASCII.** A test that POSTs a UTF-8 body containing an em dash through the HTTP boundary and asserts the stored value equals the input, plus a companion asserting that an undecodable byte produces U+FFFD — documenting that invalid input is silently substituted rather than refused. The server was **not** at fault here and the two field reports that assumed it was are wrong: valid UTF-8 round-trips intact, and the reported corruption came from `curl` on a Windows console encoding U+2014 as CP1252 `0x97`. But before this row there was exactly one non-ASCII literal in the whole test tree and it never crossed HTTP, so nothing would have told anyone that. Four live items carry stored U+FFFD in their titles and want repairing — and because `search` is `ILIKE` over title and body, such a title can never match a phrase spanning the dash, which fails as an empty result rather than an error | 26 | `done` |
| **115** | **P2 — A read that will not fit should say so.** Nothing anywhere measures or caps a response. The house style is already settled in the opposite direction from truncation — `summaries/validate.ts` refuses an over-cap summary rather than trimming it, *"it will not be truncated for you"* — so the idiomatic answer is a refusal naming the offending call and the narrower one that would work, not a silent partial result. Wanted even after #107 and #109, because those change the defaults and this catches whatever still exceeds them | 107, 109 | |
| **126** | **`needsVisualReview` did not inherit from the repository.** A repository carried `needsVisualReview: true`; `create_item` accepted no such field, silently defaulted every item to `false`, and reported success. Six items were minted against a repository registered `true`, and every one landed with the visual gate off. **The defect was the silence, not the default.** Nothing in the call, the response or the item afterwards indicated a repository-level setting was consulted and lost; a caller who set the repository flag deliberately had no reason to re-check, which is the entire point of putting it on the repository. **The shape the owner specified (2026-08-15), in three parts — all shipped, across all four creation paths (`create_item`, `create_project`, `create_task`, `create_subtask`).** **(1) The repo keeps the field** — `needsVisualReview` stays a repository-level setting, because that is the level at which the answer is usually the same for every task. **(2) A task inherits it unless explicitly set otherwise.** The override matters and is not an edge case: back-end-only work in a repo that generally needs visual review can say `false`, so inheritance is a *default*, never a lock. **(3) The resolved value comes back in the create response.** This is the part that fixed the actual defect, which was silence rather than the default itself: the returned blob says *"created, and by the way `needsVisualReview` is `true`"*, so the agent sees the setting it just inherited and can immediately turn it off if this particular task does not warrant it. A default the caller can see is a default the caller can correct; a default it cannot see was the bug being filed here. **Generalise the third part** — any field resolved from a parent rather than supplied by the caller should be echoed on creation, and it is worth checking which other repository-level and area-level fields have the same silent-inheritance shape. Filed from field feedback, 2026-08-14 | 26, 91 | `done` |
| **136** | **A progress report the server computes, in one shape, every time.** The owner asks for one constantly and gets a differently-shaped answer each time: *"I find myself asking for progress reports a lot and often I get a lot of varied shaped responses — this feels like something computable from the server, so it would be nice to move there, and the server can enforce a consistent shape."* **Both halves of that are the point.** Moving it server-side removes the work of composing a report from the agent, and it removes the variance — a report assembled by whichever session happens to be asked is a report whose quality tracks that session's judgement, on the one artefact whose whole value is being comparable to the last one. **The shape he specified**, and it should be honoured rather than improved on: a numbered list local to the session, each row *link to the open PR (or branch name) · a short human title · the state · what it is blocked on*, then two or three bullets of BLUF on what is done and what is left, with sub-bullets reserved for the genuinely important — *"use sparingly"*. The example he wrote out includes a row carrying *"issues were controversial, the agent decided option A to unblock but option B is still viable, worth taking a look"*, which is the kind of line the format exists to surface and the kind that vanishes from a free-form summary. **Depends on the human-readable title landing (#131)** — every row is one title and one line, so a title that is a technical fragment makes the whole report unreadable. Reads item, assignment, artifact and event state the server already holds; blocked-on comes from the dependency graph. From `feedback/feature request.md` | 26, 28, 131 | |
| **137** | **Delete an item — which is an archive, and is discouraged on purpose.** Settled by the owner over one long think in `feedback/feature request.md`, including the reversal in the middle of it, because the reasoning is the specification. **The need is real and narrow:** obvious duplicates and rows created by accident, for which the only available outcome is `cancelled` — and a cancellation is a *lie about what happened*, because it records a decision not to do the work rather than a row that should never have existed. **It is called delete and it never deletes.** Nothing leaves the database; the row simply stops being served — not shown, not counted, not returned by any ordinary read, unlike `cancelled` which correctly still appears as a real outcome. That preserves every inbound link and every attribution, which matters because *"if another task is pointing at this task that might be a problem"* — so the operation surfaces inbound references before it proceeds rather than silently orphaning them. **Break-glass, and shaped to stay that way:** a reason is required, the reason should usually name the replacement item's id (*"high chance the task has been replaced with something else"*), and the operation actively steers the caller toward `cancel` — because *"typically it's: I had this task, I wanted to do it, I decided not to — that's cancel, not archive"*. **Consider withholding it from MCP entirely** and offering it only from the UI, which is the owner's own suggestion and fits the shape: an agent tidying its own mess is precisely the caller this should not be easy for. Consistent with `SCHEMA.md`'s standing rule — *archive, never delete; attribution and history point at these rows* — and with #96, which does the same job for reference rows. From `feedback/feature request.md` | 26, 27 | |

**Milestone done when:** an agent can be handed an item and work it to merged using only MCP, **and
every adapter passes the conformance harness.**

> **#103–#105 come from using the product, not from auditing it.** They were written down during the
> first sessions to work through the agent surface, and they share a shape worth naming: none is a
> missing capability. The operations exist and return correct results. What is missing is the product
> telling a caller what it wants and returning an amount it can actually receive.
>
> **#107–#115 come from the first week of dogfooding, and they are ranked P0–P2 in the row text.**
> They were filed as field notes while the store migration settled, then checked against the code
> before being written down here — which changed several of them and reversed two. The ranking is
> the owner's, on the same scale the tracker uses for items.
>
> **#107 is the one that matters, and it is not #103 in a different hat.** #103 removed finished work
> from a list; #107 removes the *bulk of a row* from every read, which is the failure that survived it.
> The distinction is worth stating because it was missed once already: `get_item` has no state filter
> to default (it is `WHERE id = $1`), and the `list_items` call that overflowed had already asked for
> five `executing` items. No filter and no page size reaches either. The control that does is choosing
> which columns come back — and the honest version of that is a default so slim it is useful on its
> own, which is why the row carries a `headline` field rather than only a projection parameter. A
> projection nobody knows the shape of is a second discoverability problem.
>
> **#105 as written answers about two of the six things asked for.** It indexes title and body,
> lexically. Checkpoints, repository and person are explicitly deferred in its own row text, and
> semantic matching is not in it at all. Two facts worth carrying into whoever picks it up: `list_items`
> has **no `search` parameter of any kind**, leaving `get_board` as the only way to search — the one
> read with no bound — and nothing indexes the columns it matches, so a leading-wildcard `ILIKE` is a
> sequential scan of every body in the table. The deferral is defensible; the pairing is not.
>
> **#103 is the cheapest row in this file and fixes the most common read.** A default filter. The
> reasoning generalises past the one endpoint: *the default should answer the question people actually
> ask*, and nobody opens a tracker to see what is finished. It is also not merely wasteful — a read
> whose response cannot fit in the caller's context is not a slow read, it is a failed one, and it is
> the first call a new session makes.
>
> **The same failure has a documentation half**, and half of what was written here was wrong. It is
> now a row — **#111** — because the fix turned out to be code rather than strings.
>
> **Correction, from measuring it rather than assuming.** This paragraph used to say "the schema is
> not visible through the agent surface at all". That is false, and it was repeated in three field
> reports before anyone checked. A live `tools/list` over the MCP transport advertises every
> operation's real schema — `get_crew_name` returns `{"required":["sessionId"],"additionalProperties":false}`,
> `create_item` advertises its `originType` enum and `priority`'s `P0`–`P3` — and `advertisedSchema`
> (`mcp/tools.ts`) exists precisely to keep that true through a `ZodCatch` wrapper, guarded by its own
> test. Every "undocumented" field in those reports was in the `required` array the whole time.
>
> **What is genuinely invisible is narrower and more interesting**: the rules JSON Schema cannot
> express. `create_item`'s `originType: "person"` → `originPersonId` is a `.refine()`; `complete_item`'s
> cardinality and conditionals live in a runtime validator. No amount of schema advertising reaches
> either, which is why #111 adds a call that returns one tool's full contract on demand instead of
> fattening every description — `PLAN.md` is right that descriptions are charged to every turn.
>
> **The general lesson is about the diagnosis, not the defect.** Three independent sessions agreed on
> a cause, and agreement made it look settled; it took one round trip to disprove. A field report is
> evidence about what using the product felt like, which is exactly what it is good for — it is not
> evidence about why, and this file should not have promoted one to a stated cause without a check.

---

## M5 — The board, and going live

*Feature: you can see the work, and orchestrators run on this for real.*

| PR | Delivers | Needs | Status |
|---|---|---|---|
| **35** | Profile picker — choose a user profile, remembered in the browser, switchable from the top bar | 9, 26 | `done` |
| **36** | Board API: items grouped into columns, filters | 26 | `done` |
| **37** | Board UI: the four columns, amber/red split in Waiting, needs-you badge | 35, 36 | `done` |
| **38** | Since your last visit — per person, and a "seen" action | 20, 35 | `done` |
| **39** | Compatibility shim — a command-line surface routed at the API unchanged, kept for one release | 26, 27 | `done` |
| **40** | Go live: rehearse against imported data, switch the source of truth over, retire the shim. **Performed on a day when nothing is executing** — duplicate, verify against the duplicate, then switch; never a wholesale swap with items in flight (`DECISIONS.md` §11, §13h) | 13, 37, 39 | `done` |
| **86** | `/settings` — categories, widgets, per-field help and validation all rendered from the registry; value-source badges; reset-to-default; the `sensitive` section with typed confirmation; unrecognised and invalid override sections; the read-only build-constants and bootstrap panels; first-run entry when no profiles exist | 35, 78 | `done` |
| **87** | Budget-window editor — per-window cards, the three boundary kinds in plain words, the band chart, drawn validation errors, the time scrubber, and presets. Plots an account's position **once usage readings exist**; before that the chart is the boundaries alone | 86 | |
| **93** | Administration UI — one page pattern per entity kind, over the API from #92, linked from `/settings` | 35, 92 | `done` |

**Milestone done when:** the board is the live view, every orchestrator reads and writes through
the API rather than against anything it imported from, **and the system is configurable end to end —
settings from `/settings`, installation entities from the administration pages — without touching the
environment.**

---

## M6 — The hook

*Feature: the rules reach into sessions, through a single hook script.*

| PR | Delivers | Needs | Status |
|---|---|---|---|
| **41** | The hook decision as a service call, and its route: allow-list silent, ask-list answered, **denies when unsure**. The route is one caller; `standup hook` is another | 14 | `done` |
| **42** | The hook script: one file, fires after each tool call and at stop, cached rules | 41 | `done` |
| **43** | Session registration handshake: the `sessions` table (additive migration), the registration transport recorded as the capability signal in five values matching the adapter names, `standup session register` and its route, a transport-specific reply naming the matching hook variant, and per-variant protocol version comparison — advisory when stale, refusing a claim when incompatible or absent. Plus a CI assertion that the shipped hook's declared version equals the build constant, so nobody has to remember to bump the right one | 42, 79 | `done` |
| **45** | Process registry, and the kill guard as an **ownership check** | 42 | `done` |
| **46** | Nudges: delegate mode, staging, escalation, wind-down | 25, 42 | `done` |
| **47** | Stop-hook catch: live crew and nothing scheduled to wake you | 42 | `done` |
| **48** | Plugin package — MCP config, hook config, and the command line in one install. **Consumes the published package rather than carrying a copy of the binary** | 30, 42, 89 | |
| **49** | `/setup-agent-standup` — registers the scheduled task, then **proves it works** with a live call | 48 | |
| **88** | `standup hook` — the hook payload on stdin, the local telemetry spool and its batched flush | 42, 79 | `done` |
| **89** | Publish the package with the `standup` binary on the same version tag that publishes the image | 79 | `done` |
| **125** | **P0 — Delete the pattern lists, unblock the hook, and stop the hook version gating anything.** Four changes to the same wall — **all four shipped.** **(a) Removed `hook.allow_patterns` and `hook.ask_patterns` outright.** Not flipped their default — the concept was deleted. (2026-08-15: *"we have settled on the fact that tool calls are not sufficient, so let us kill the whole tool-call idea and rely exclusively on behaviours."*) Matching command strings cannot express the rules anyone actually wants, because every real one is conditional — *never merge without an approval*, *never `git add -A` on the shared checkout* — and the condition lives in server state, not in the command text. **#128 is where gating goes**; until it lands the hook simply does not block, which is correct rather than a gap. Removing both fields made allow-all the construction instead of a special case, and made the sealed state unreachable rather than merely un-defaulted. **The failure this retired, for the record:** both lists shipped empty, `ask_patterns`' own help stated *"anything matching neither list is denied"*, and `hook_decision` returned a `deny` with `matchedList: null` for `git status` and `rm -rf /` alike — a hook that denied every call including the `Edit` that would unwire it. **(b) Shipped — the handshake is a bootstrap loop, not a one-shot answer.** (2026-08-15.) A session that registers with no hook version at all now gets a route out rather than a dead end: register with no version → the reply carries `fetch` (`scriptUrl`, `install`) → the session downloads `GET /hook/script?variant=<variant>` (SCHEMA.md §21) and installs it, wired to `PreToolUse`/`PostToolUse` — `install` deliberately names only that, not a path, because the server cannot know a given machine's layout → the session registers again reporting the version it now runs → the row carrying a non-`null` `hookVersion` **is** "recorded as hooked", no separate flag needed. `fetch` is present only when `hookVersion` is `null` on that call, so an already-hooked session re-registering is not re-pointed at instructions it does not need. The script route answers a variant that either isn't a real `HookVariant` or is one with no script built for it (`cli`) the same way — `404`, `no-store` — because both mean "nothing to fetch" from the caller's side; adding a `cli` script is one entry in `scripts/build-hook-scripts.mjs`'s build map. That build is deliberately a second, non-split bundle from the one `build-cli.mjs` already made (`splitting: true`, for the published package) — a servable script has to be one self-contained file with nothing beside it, which a split entry point is not. **(c) The hook version informs; it does not gate — shipped.** (This was a live defect, not a design note.) `claim` used to refuse any session that had not registered a protocol version, and a session that honestly ran no hook could not register one, so **ownership was unreachable for it** — the single operation the task store exists for. That was too strict. The version's real job is telling the server **what signals to expect**: with no hook there are no tool-call reports, so an absence of tool calls must not be read as a dead subagent. Everything else works unchanged — mint, update, transition, artifacts, reviews, checkpoints, claims — and the only thing lost is that Agent Standup cannot block or enforce in that session, which is acceptable. Hooklessness is recorded and threaded into the claim check. Shipped as the setting **`hook.require_registration_to_claim`, defaulting to `false`** (named differently from the row's original `require_hook` proposal), for installations that genuinely want the strict posture. **(d) When gating returns, it belongs on `PreToolUse` — not yet applicable.** By `PostToolUse` the call has run, so a deny there refuses something that already happened; `PostToolUse` keeps nudges, telemetry and the spool write, and `Stop` stays advisory per `DECISIONS.md` §6. This is a placement rule for gating that does not exist yet (that is #128), so there is nothing to verify beyond the shipped hook script correctly keeping `PostToolUse`/`Stop` non-blocking, which it does. **(a) and (c) shipped first and were not gated on anything** — between them they are what makes the hook wirable and the product usable without it. Filed from field feedback, 2026-08-14. Also worth a pass: the claim refusal names the CLI spelling (`standup session register`) to callers reading it over MCP, where it is `register_session` | 41, 42, 43, 77 | done |
| **128** | **P0 — Interventions: what Agent Standup notices, and what it does about it.** the owner’s design, 2026-08-15. **The observation it rests on:** almost no First Mate guard was ever *"never run this command"* — it was *"never run this command **in this situation**"*. Never merge without an LGTM at tip. Never `git add -A` on the shared checkout. A pattern list over command strings **structurally cannot express that**, which is why #125 deletes those lists rather than fixing them. The condition needs item state, claim state, review artifacts, subagent progress and budget — **all of which the server already holds and a local matcher never will.** That is the whole case for putting this server-side, and once it exists **this is the only thing that gates anything.** **The shape.** An intervention is a *detectable situation* plus a *response*. It is a seeded registry, not user-authored content: detection is code, so you cannot invent one from the UI — but every entry can be switched off, have its response level changed, and have its message rewritten, with a reset-to-default. **The response ladder — three levels, weakest to strongest**: nothing · **nudge** · **block, overridable with a written reason** · hard block. **Prominence is a property of the message, not a level**: a nudge always carries a message, and how loud it is belongs to the text. Store **two default messages per intervention** — a plain one and a prominent one (warning icons, *do not proceed until you have read this*) — and let the front end choose. Both are still `nudge`, which keeps the enum small and stops "how alarming is it" being confused with "does it stop me". **Frame the block tier as block-and-record** — an agent asked to justify itself will always produce a justification, so its value is the recorded `reason` on a reviewable event, not the friction. **Delivery: a digest, not a drip.** (Answering nudge fatigue directly.) Findings accumulate and are delivered periodically — roughly every five minutes — as *"here is what I noticed"*: this agent has gone quiet, that one finished and nothing picked up the next step, these review follow-ups were never minted. A batch arriving at a natural juncture gets acted on; a trickle of tiny nudges gets skipped, which is exactly the failure to design against. **Timing is per-intervention configuration**: each entry declares whether it fires **immediately** or **rides the next digest**. Blocks have no choice and always fire immediately; nudges get the choice, and defaulting most of them to the digest is what keeps the channel worth reading. They ride back on the **ordinary service response** — an extra field beside the normal payload on `transition_item`, `record_artifact`, `note`, `claim` — **not only through the hook**, which decouples the whole feature from the hook being wired. Rate-limiting reuses #114’s design: `events.type = 'nudge'` with a `{kind}` payload makes last-nudged-at per session and kind a query rather than a state file. **The catalogue lives in `docs/plans/INTERVENTIONS.md`, not here** (2026-08-15) — this row is the *engine*: the registry, the levels, the digest, the settings surface. What to detect is a growing list and would swamp a milestone row, so it gets its own document, and new findings are appended there rather than minted as milestone rows. **Auditability lives on the settings page, not in the file tree.** (Revising an earlier framing on this row.) The question worth answering is *"what is switched on right now, and what will it do"* — which is a **live view of current configuration, not of defaults**, and belongs in the UI where someone can change it in the same breath. So **no generated catalogue and no CI check that docs match code**: that was a workaround for not having a front end, and the front end supersedes it. Server-side, just follow the repo’s existing file conventions. **Build it so user-supplied interventions become possible later, without building them now.** (Explicitly not v1 scope; the ask is only that v1 does not foreclose it.) The eventual shape: a script handed the current context and tool call, discovered from a folder the server is pointed at, joining the same registry. Three cheap decisions keep that possible, and all three are things the built-ins should do anyway. **(1) A intervention declares the context it needs; it does not go and get it** — the server assembles and passes it in, and that declaration is exactly what a script’s stdin payload would carry. **(2) The verdict is a returned value, never a side effect** — `{triggered, level?, message?, data?}` — and the *registry* decides what to do with it, applying the user’s configured level, message and timing. A intervention that emits its own nudge cannot be swapped for an external process; one that returns a finding can. **(3) Key the registry by id with a `source` field (`builtin` or `custom`) from day one**, even while only `builtin` exists, so settings rows attach to an id and a custom entry inherits the whole configuration surface for free. Predicates should be **pure and time-bounded** — no writes, a declared timeout — because that is the sandbox an external script needs, and enforcing it on built-ins from the start makes the boundary real instead of retrofitted. **The extensibility comes from making the built-ins obey a contract they do not strictly need yet:** if a built-in may reach into the database directly, no external script can ever be its peer. **#112 and #114 have been removed from this file** and re-filed as entries in `INTERVENTIONS.md` — post-merge cleanup and keep-the-work-moving are both exactly this shape (2026-08-15). **Naming is open** — shortlisted with the owner 2026-08-15, not yet settled. **Status note (2026-08-18): the engine is wired and gating is live — row stays open for the settings surface and digest delivery.** `hook_decision` now consults the registry: it assembles an `InterventionContext` from claim, item and artifact state, evaluates the entries for the event's phase, and maps a blocking finding onto a `block` with its reason. **This is the first thing in the system that actually refuses a tool call**, and it closes the gap #125 left open deliberately. `src/lib/interventions/` holds `types.ts`, `registry.ts`, `builtins.ts`, and two new modules: `commands.ts` (recognition only — merge attempts and broad kills; the *"server decides, client only recognises"* split I10 states) and `context.ts` (assembly). **Five of the twelve catalogued entries are live**: I10 (merge with no approval at tip), I11 (broad `git add` on a shared checkout) and I12 (broad process kill) all block-overridable on `pre`; I1 and I7 nudge on `post`. **Fail-open is revisited and deliberately unchanged**, as DECISIONS.md §16 required — the reasoning and the accepted residual risk are recorded in `hook-decision.ts`'s header, the short version being that the rules now enforced are a handful of situations out of a session's whole traffic, so an outage denying everything would still refuse thousands of calls each entry would have allowed. **The cost concern is answered rather than waived**: `assembleContext` gates every query behind a command-shape test over a string already in memory, so an ordinary `Read`/`ls`/`Edit` still touches no table and the operation stays honestly `kind: "read"`; a test asserts exactly that against a handle which throws on any query. **Still missing, and why:** the **settings surface** (no `intervention`-keyed rows in `src/lib/settings/registry.ts` — the override *plumbing* is built and tested end to end, but nothing populates it from configuration, so an entry cannot yet be switched off or re-leveled from the UI); **digest delivery** (findings carry `timing`, and a `digest` finding rides back on the response — that is the accumulation seam — but nothing batches or delivers them periodically, and the `nudge` event emitter that would record them is waived to #47, so writing one here would claim another row's territory); the **ordinary-service-response field** (`transition_item`, `record_artifact`, `note`, `claim` still carry no intervention payload — only `hook_decision` does); and **seven catalogued entries have no predicate**, each with its missing *signal* named in `UNIMPLEMENTED_CATALOGUE_ENTRIES` rather than left as folklore. Two of those are schema findings worth surfacing: I2 and I9 both need "is this row unblocked", and the dependency graph that decides it is prose in this document rather than a relation between items — so it is not a question the schema can be asked. I5 is a different case: its signal exists and the merge gate already refuses that combination outright, so an intervention would be a second voice on a decision already made | 46, 104, 125 | |

**Milestone done when:** one hook script covers every guarded event, and the only judgement left on
the client is the handful of checks that cannot run anywhere else.

> **The post-merge-cleanup and keep-the-work-moving rows live in `INTERVENTIONS.md`** as entries I6 and
> I1, rather than here. Both are
> #46's channel carrying something new — #46's four kinds are hygiene, *do not do this yourself, do
> not stage that, you are near a budget edge*, whereas these are advice about the shape of the work
> rather than about the call being made. That distinction is what #128 generalises, so they belong in
> its catalogue rather than as milestone rows here.
>
> **The ask path is being deleted, not fixed.** This milestone carried a long analysis of why an
> ask-list match was read as a deny even against a healthy server. **#125 removes the allow and ask
> lists entirely**, so that path and its cache-refresh consequence go with them; gating returns via
> #128. Kept only as a pointer so nobody re-derives the dead path.

---

## M7 — Telemetry

*Feature: everything measures itself. Nothing reads it yet — see the warning.*

| PR | Delivers | Needs | Status |
|---|---|---|---|
| **50** | Tool-call ingest from the hook, with the item's state at the time, caps on the big fields | 42 | `done` |
| **51** | Runs: a new run whenever the model or effort changes; the hook reports the model per call | 50 | |
| **52** | Price table and cost, always recomputable from the token counts | 51 | |
| **53** | Aggregation: cost per item, per session, **per stage** | 52 | |
| **54** | Repeat-command detection, how wide the file spread is, read-to-write ratio | 50 | `done` |

> ⚠️ **This milestone must not slip behind M8 or M9.** Facet and cost history **cannot be
> backfilled** — every month it isn't collecting is a month the model picker can't learn from. It is
> cheap (the hook already fires) and has no consumer until M9, which is exactly what makes it easy to
> defer and expensive to have deferred.

---

## M8 — The heartbeat

*Feature: work starts without you. Optional — everything above runs with this switched off.*

| PR | Delivers | Needs | Status |
|---|---|---|---|
| **55** | **Spike:** launching a session unattended on Windows, locked and logged in | — | `done` |
| **56** | Accounts and usage readings, from the hook and from polling; handling stale readings | 9, 50 | |
| **57** | Budget bands: four of them, boundaries that move with the clock, strictest window wins. Reads `budget.windows` as a typed setting, and `accounts.budget_windows` where an account overrides it | 56, 77 | |
| **58** | The poll: a machine reports its sessions, usage, and anything waiting to be minted. Reads `machines.source_globs`, falling back to `minting.source_globs` | 56, 77 | |
| **59** | The planner: sort by priority, pack against headroom, deterministic ordering | 57, 58 | |
| **60** | Launch prompts composed server-side; dispatch and dispatch-claimed recorded | 59 | |
| **61** | The launcher script and its scheduled task, per machine | 55, 60 | |
| **62** | Failed-launch detection: dispatched, never claimed, past the threshold | 60 | |
| **63** | Minting: triggered by demand, scans your sources, never mints the same thing twice | 26, 58 | |
| **64** | Wait-for-crew: the held-open endpoint and the polling implementation, both bounded by the visibility horizon and returning identically, plus the crew digest. **The implementation follows the binding, never the caller.** The binary itself is #79, not here | 24, 54, 79 | |
| **65** | Nudge to background a command, using how long that command has taken before | 46, 54 | |

**Milestone done when:** each machine runs nothing but a ~30-line poller on a scheduled task, and
every decision it acts on was made server-side.

---

## M9 — Scoring, and the model picker

*Feature: you can tell whether a run went well, and the system learns from it.*

| PR | Delivers | Needs | Status |
|---|---|---|---|
| **66** | Scores: two of them per facet, the agent's frozen, accepting copies it to yours | 51 | |
| **67** | Working out how it went on its own: review rounds, finding severity, rework, steering | 17, 53, 66 | |
| **68** | Review UI on the since-your-last-visit card: sliders, only the facets in play, never blocks Seen | 38, 66 | |
| **69** | Flagged runs — "we tried a cheaper model here, is this up to standard?" | 68 | |
| **70** | Picker: store recommendations, discourage overrides at spawn, record when you override anyway | 67 | |
| **71** | Picker: how strongly to recommend, how often to experiment, bias experiments to low-risk work | 70 | |

**Ships switched off.** The mechanism is bounded code; the judgement is data that has been piling up
since M7.

---

## M10 — The full front end

*Feature: somewhere you'd actually choose to work.*

| PR | Delivers | Needs | Status |
|---|---|---|---|
| **72** | Item detail: subtask tree, artifacts, history, summary | 37 | `done` |
| **73** | Drag between columns, with the move showing immediately | 37 | `done` |
| **74** | Project view and progress view | 72 | |
| **75** | Filters and search: area, repo, state, who's on it, priority | 36 | `done` |
| **76** | **Mobile** — P3. A different flow, not a squeezed desktop: a list with a status picker instead of drag, filters in a sheet, thumb-sized sliders, and you can still mint work | 68, 73, 75 | |
| **96** | **Retiring a reference row** — P3, optional. Surfaces the `archived_at` the schema already carries: `PATCH /repos/{id}`, `/areas/{id}`, `/people/{id}` sets it, archived rows drop out of pickers and default `GET` lists but still resolve everywhere they are already referenced. Plus the inverse — `DELETE` with an explicit hard-delete flag, allowed **only** when a reference count across every referring table is zero, refused with the counts otherwise | 91, 92 | |
| **117** | **A column is bounded and scrolls inside itself.** Backlog renders all 68 items in one unbroken column, so the page grows to the length of the longest column and the other three are dead space beside it. Give a column a max height that does not exceed the viewport, a min height so an empty column still reads as a column, and its own scroll region — the board's header and the other columns stay put while one column scrolls | 73 | |
| **118** | **Filter and sort the board from the board.** Filter by area, repo, agent, actor, profile and priority; sort by priority, name, created and last-updated, each ascending or descending; and a search box — per column or one for the whole board, whichever survives the design. **#75 is marked `done` and delivers the API filters, but nothing in the UI reaches them**, which is why this is a front-end row and not a re-open. Pairs with #118: a tag on the detail page is the same filter applied | 75, 73 | |
| **119** | **Tags on the detail page are links back to a filtered board.** Clicking the area, repo, priority, state or assignee chip on an item returns to the kanban with that filter already applied. The filter set is #117's; this row is only the navigation | 117, 72 | |
| **120** | **The detail page renders its markdown.** Item bodies show raw `##`, `###` and pipe tables as literal text instead of rendered headings and tables — every imported item carries a full markdown brief, so this affects the majority of the corpus. Also the page's vertical budget: subtasks, artifacts and history each render fully expanded and stack to an extremely long page. Artifacts and subtasks behind a control (collapsed, or a dialog), and **history paginated** rather than every event always present | 72 | |
| **131** | **Titles are for people; the technical detail belongs in the body.** From a first read of the board (2026-08-14): *"the title right now is too technical and not user facing — titles should be user facing, I should read it and know what it means, the technical details can be in the body."* Every imported title is a work order written by and for an agent — *"agent-standup #102 - route the four raw event writes through appendEvent"* — so a board scanned by a human reads as a wall of internal references. **This is not #107.** That row added `headline` as a one-line BLUF *returned by reads*; this is about what goes in `title` in the first place, which is a convention plus a UI question, not a field. Three parts: state the convention somewhere it is read at creation time; have the create surfaces (and the item form) reflect it; and decide what happens to the 217 imported titles — leave them, or backfill a readable title and keep the original in the body. **Interacts with #105:** search matches on title and body, so moving detail out of titles changes what is findable, and the two should be settled together. Filed from field feedback, 2026-08-14 | 72 | |
| **132** | **The plan view is a timeline, not a dump.** On the item detail page (2026-08-14): *"a plan view should be a bit more organised — start with a summary or BLUF, click here to see the snapshot history, but maybe the latest snapshot is more prominent and easy to view and you can go back to previous snapshots, and then review artifacts."* Plan, artifacts and history all render at full length stacked down one column, so the page grows without bound and the live state is no more prominent than any superseded one. Wanted: a summary at the top, the latest snapshot rendered prominently, earlier snapshots reachable but collapsed, and review artifacts as their own section. **Get a visual reviewer on it rather than designing it in a PR description** — same instruction given for #122. Overlaps #120 (which collapses artifacts and paginates history) and #74 (the progress view); this is the plan-specific half. Filed from field feedback, 2026-08-14 | 72, 120 | |
| **121** | **Subtasks are visual, and not loose on the board.** Subtasks appear on the board as their own cards, so a parent and its children compete as peers. Take them off the board and reach them from the parent — a control on the card that expands it into its children. Depends on #74 for the project/progress view it borrows from | 74, 73 | |
| **123** | **The completed column is empty when 175 items are completed, and every column count is wrong.** The database holds 161 `merged` + 14 `cancelled`; the board renders Completed as empty with a count of `0`. Backlog reads `68` against 58 `on_deck`, so the counts disagree with the data in both directions and are not simply the length of a filtered set. #103's terminal-state default is right for `get_board` and exactly wrong for the one column whose purpose is terminal work: the column opts out of that default and shows its first page like any other, and a count reports the true total rather than what the read returned. **An empty state and a hidden state must not render identically** | 103, 109 |`done` |
| **122** | **P3 — The board is worth looking at.** Near-monochrome: priority is the only colour on a card and the four columns are otherwise undifferentiated. Wants a real visual pass — colour that carries meaning (state, area, staleness), interactive states worth the name, and a drag that actually shows the card moving with the cursor rather than the card jumping on drop. **A reference implementation was named for its visual language.** Also the layout escape hatch: a switch between the kanban and a sectioned-list view, for when 68 items in a column is the wrong shape entirely. Get a visual reviewer on it rather than designing it in a PR description | 73, 117 | |

---

> **#117–#122 came from the owner's first real session in the UI (2026-08-14), filed in
> the field note it came from with screenshots.** The framing given:
> *"this isn't urgent, in fact it's probably the least urgent thing"* — so they are recorded at the
> priority he gave them, not promoted because they are the most recent thing anyone said.
>
> **The one that is not cosmetic is #118.** #75 — *"Filters and search: area, repo, state, who's on
> it, priority"* — is marked `done`, and the service-layer filters genuinely are. But there is no way
> to reach any of them from the board, so the delivered user-facing capability is zero while the row
> reads complete. That gap between a `done` row and a usable feature is worth more attention than the
> feature itself: it is the same shape as the artifact wall (#98), where 175 imported items made a
> broken write path look proven. **A row is done when someone can use it, not when the service call
> exists.**

> **#96 is two operations because "delete" means two different things, and conflating them is what
> breaks the board.** Archiving is the common case and the safe one: the row stays, every item and
> attribution row still resolves, it just stops being offered for new work. Hard delete exists only
> for the genuine mistake — a repository created with a typo, an area auto-created from a
> misspelling — where archiving leaves permanent clutter in a table meant to be small and readable.
> The guard is what makes it safe: zero referring rows, counted at the moment of the request across
> every table holding the foreign key, or the request is refused and reports what still points at it.
> That check is not advisory. Deleting a row something references either corrupts history or trips a
> foreign-key error at a random later read, and `archived_at` exists in the schema (§`repos`,
> `areas`, `people`) precisely so the destructive path is never the one taken by default. See
> `SCHEMA.md` — *"Archive, never delete — attribution and history point at these rows."*

---

## Critical path

**1 → 2 → 3 → 7 → 8 → 77 → 14 → 15 → 27 → 30 → 32 → 40.** Everything else hangs off that spine.

That line is a **narrative** of the sequence that matters, not the graph's longest chain — #40 does
not in fact depend on #32. Computed from the `Needs` column rather than recited, the chains are:

```
longest chain to #40 :  1 → 2 → 3 → 7 → 8 → 77 → 14 → 15 → 21 → 27 → 39 → 40      (11 hops)
longest chain overall:  1 → 2 → 3 → 7 → 8 → 77 → 14 → 41 → 42 → 50 → 51 → 52
                          → 53 → 67 → 70 → 71                                      (15 hops)
```

Both confirm the one thing that matters when adding a row here: **#77 sits on the true longest chain,
one hop after #8**, so the extra hop is real and is stated rather than hidden. Nothing else added
alongside it is on that chain — #91 is 5 hops in and off the binding path, #85 is 7, #94 is 11.

Three things get sequenced wrong more often than anything else:

- **M7 before M8.** Telemetry has no consumer until M9, so it reads as deferrable. It isn't — the data
  can't be backfilled.
- **#55 before the rest of M8.** It has no prerequisites and can start any time, but the whole
  milestone assumes it works. Unattended launch is well-trodden ground rather than a gamble —
  confirm it early anyway.
- **#85 before the adapters it will police, and #94 as soon as it can evaluate.** The allowlist needs
  nothing but a service layer and constrains everything built afterwards, so landing it late means
  every adapter written in the meantime was unconstrained. The harness cannot land until the
  operations its guards reject are exposed by at least two adapters — which is why they are two rows
  and not one.

## Decisions blocking specific PRs

| Question | Blocks |
|---|---|
| The band numbers, beyond the starting values | 57 |
| Does Codex need the blocking wait-for-crew fallback? | 64 |
| Front-end framework beyond the first board view | 73 |

## Not scheduled, deliberately

A per-machine limit on how many sessions run at once (a resource concern, and whatever pools browser
sessions is the natural owner of it) · a client-side validation gate before review (review is the
gate; a second one earns its place only if it catches something review doesn't) · a hard list of
paths that can never auto-merge (dropped) · a real custom-field system (the escape-hatch field will
do; keys that keep recurring get promoted to columns) · threaded discussion (cut, and only comes
back designed properly with replies).

> **The client-side validation gate's test is "catches something review doesn't" — mutation testing
> (#95) is the proof that bar is real, not rhetorical.** A test that names a behaviour it cannot
> possibly fail on reads as coverage in a diff and passes every check that runs the suite as a whole,
> because nothing about it is syntactically wrong — only its assertion is empty. That shape survived
> both a green CI run and a human read-through and was caught only once something mutated the
> behaviour under test and confirmed no test noticed. That is exactly the gap #95 exists to close:
> not "did tests run", but "would this test actually fail if the behaviour it names regressed". A
> future gate earns its place the same way — by demonstrating a failure mode review provably misses,
> not by asserting one in the abstract.

---

## M11 — Rounding up

*Feature: the deliberate temporaries are retired, and nothing is left switched off by accident.*

Work that exists because something was paused, deferred or worked around while the rest was being
built. Each row here is a promise made earlier in the file, and the milestone exists so those
promises have somewhere to live other than a comment nobody re-reads. A row belongs here when the
question is *"is this still switched off?"* rather than *"has this been built?"*.

| PR | Delivers | Needs | Status |
|---|---|---|---|
| **106** | **Moved to `BEFORE-GA.md` (G1) — not a milestone row.** Mutation testing is off on every branch, `main` included, and turning it back on is a gate to close before shipping rather than a unit of work to pick up next. Row kept as a pointer so existing references resolve; the reasoning, the conditions for re-enabling, and what must not be done to force a green all live in that file | — | `moved` |

**Milestone done when:** nothing in the tree is disabled, waived or stubbed without a row here saying
so — and every row here is `done`. The two halves are not the same claim, and only the second is
checkable from this table: this milestone is the one that goes stale silently, because the way it
fails is something being switched off *without* a row being written. A row landing here is the
milestone working, not a regression.

> **Why this is its own milestone and not part of M1.** #106 sat under *Infrastructure* because that
> is where mutation testing was built. But the row is not infrastructure work: nothing is missing, and
> the code it describes already exists and already ran. What it tracks is a **deliberate temporary** —
> a gate switched off during a period of heavy parallel work, on the explicit understanding that it
> goes back on. Filed under M1 it reads as unbuilt; filed here it reads as what it is, which is a debt
> with a due date.
>
> That distinction matters more than it sounds, because a paused gate is invisible in exactly the way
> a missing one is not. A milestone that never gets a row is obvious; a check that passes in four
> seconds without doing anything looks the same as a check that passed.
