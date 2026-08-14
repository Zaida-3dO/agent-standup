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
| **106** | **Switch mutation testing back on.** The job is paused in `ci.yml` behind a `false &&`, not deleted — re-enabling is removing two characters, and the required gate follows automatically because it reads that job's result. Paused deliberately during a period of heavy parallel work, because at 22–57 minutes it is by a wide margin the slowest job in the pipeline and it runs on any source change. **Restore it once that push settles.** Whatever survived while it was off is found on the first run after, so budget for a batch of failures rather than a green run — and prefer one sweep to fix them together over discovering them one pull request at a time. If it stays off, it needs a scheduled run and somewhere the last result is visible: a check nobody runs and nobody misses is off, whatever the configuration says | 95 | |
| **97** | **Application logging.** One JSON object per line on stderr, the conventional five levels (`debug` `info` `warn` `error` `fatal`) with a `LOG_LEVEL` threshold defaulting to `info`. Carries the operator-facing detail the error taxonomy deliberately withholds from clients — above all the `cause` an `InternalError` preserves — plus the request context needed to follow a single request through the layers it touched. Wired at the boundaries a failure actually crosses: the API error responder, the rules engine's refusals, and the adapters | 3 | `done` |

**Milestone done when:** a merge to `main` produces an image the NAS can pull and run, and nothing
reaches `main` without passing checks.

> **#1 and #2 are not really PRs** — they're the two setup steps that make PRs possible. They keep
> numbers because everything downstream needs to point at them.
>
> **#3 is the fan-out point.** Almost nothing else can start until it merges, because everything
> downstream needs the package manifest, the Prisma tooling and the test harness to exist. The
> release workflow ships inside it rather than in #5 so that one infrastructure change lands whole;
> #5 is then just proving the pipeline end to end. The only work with no prerequisites at all is
> **#55**, the unattended-launch spike.
>
> **#97 is not `events`, and it is not M7.** All three write a record of something happening, which
> makes them easy to conflate, and they answer different questions. `events` is domain history — what
> happened to an item, durable, queryable, and part of the product. M7 is measurement — what a run
> cost, structured for aggregation. Logging is for the operator reading a failure: the flow of control
> through a request, at a level of detail nobody wants persisted in a table, thrown away on the
> retention the log shipper decides. Its motivating failure is concrete — a 500 reaching a client as
> `{"code":"internal"}` with an empty server log, because the taxonomy correctly refuses to leak the
> `cause` to the client and nothing was writing it anywhere else. The detail existed and was
> unreadable. That it sits in M1 rather than alongside telemetry is deliberate: every milestone after
> this one is easier to debug with it and harder without, so it earns its place early, and unlike
> facet history it has no backfill problem — only the failures that happen before it lands are lost.
>
> **How the request context works, since it is the part with real design in it.** The id lives on
> `ServiceContext.caller.requestId` and is minted at the boundary a call arrives through; the runtime
> mints one when the adapter did not, so an in-process caller still produces correlated lines, and an
> adapter's own id wins because the adapter has lines of its own already stamped with it. It is
> threaded as a value on a type the layers already pass to each other rather than held in ambient
> storage — `AsyncLocalStorage` would work and would be a second channel a guard could read without
> any signature saying so, which is the coupling `ServiceContext` exists to make visible.
>
> **The levels are a decision, not a default.** An `internal` is `error`, with the `cause`; every
> other refusal is `debug`, because a code the caller earned is the system working and thousands of
> them at `error` would bury the one that means something is wrong. A guard's refusal is the
> exception at `info` — it is the line an operator chasing a stuck item actually wants, and `info` is
> on at the default threshold. The whole thing writes to **stderr at every level**, which for
> `mcp-stdio` is a correctness requirement rather than a preference: stdout carries the JSON-RPC
> framing.
>
> **What is deliberately not here, as follow-ups.** The CLI's `http` binding mints an id for its own
> lines and does **not** send it to the server, because no route reads a caller header — end-to-end
> correlation across the two processes needs a server that reads one, not a client that sends one.
> And no route echoes a request id back to a client (`X-Request-Id`), which would be the thing that
> lets a bug report name the call it came from.

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

> **#91 before #10.** The importer is the first thing to write these columns in volume, and an import
> set contains aliases of one repository — importing them as free text bakes the fragmentation in
> permanently under identifiers preserved verbatim. Retrofitting means a second data migration over
> rows just imported, and the alias mapping has to be decided either way. See `DECISIONS.md` §13g.

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

> **#77 comes before #14 on purpose.** The service layer resolves one settings snapshot per call and
> threads it through, so every guard in one transaction sees one configuration. Retrofitting that
> into a built service layer does not touch one skeleton — it touches every service written after it.
>
> **#85 lands as early as it possibly can, and that is the point of splitting it out of the
> conformance work.** It needs nothing but a service layer to exist, it constrains every adapter that
> has not been built yet, and it is the only mechanism here that catches a rule written inside an
> adapter. The harness (#94) can only land once there are adapters to compare.

**Milestone done when:** every guard in `SCHEMA.md` has a passing test, including the rejections.

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
| **98** | **Artifact writes.** One `record_artifact` service call and its routes/tools/verb — `{itemId, kind, verdict?, reviewRound?, commitSha?, body?, ref?}` — plus an emitter for the `review_requested` event. **The importer is the only writer of the artifacts table**, so #17's three guards refuse every item minted through the product: `→ in_review` wants a `review_requested` event, `plan_review → executing` wants an approved plan artifact, `→ merged` wants a commit artifact and an approving code review at round+tip. One operation clears all three | 17, 20, 26 | |
| **99** | **Run the liveness ladder.** #24 built `sweepLiveness` and nothing calls it. Give it a trigger — a `standup sweep` verb and a scheduled or hook-driven invocation — so a dead session's claims are actually reclaimed. Until then a crashed session's claim is permanent: the claim insert is `ON CONFLICT DO NOTHING`, so every later claim on that item is refused as already-held with no path to release it | 24 | |
| **100** | **Open-loop writes.** `loop_add` / `loop_close` over the `open_loop` / `open_loop_closed` events, with their routes, tools and verbs. The payload validators, the pairing logic and #28's read path all exist; only the write is missing, so `orientation` can display a loop nobody can record. Also add the `SCHEMA.md` section both modules cite as `§3a`, which does not exist | 20, 28 | |
| **101** | **Wire the notification evaluator.** #25 built `evaluateRules` and named the service layer as its caller "once #27 lands transitions"; #27 landed without it, so nothing evaluates a rule and `people.notify_rules` is never read. Thread the before/after field snapshot from transition and update into it — the evaluator's own header documents the field-name casing the caller has to handle | 25, 27 | |
| **102** | **Route the four raw event writes through the one writer.** `create_item`, `update_item`, `transition_item` and `complete_item` insert into `events` directly rather than through `appendEvent`, contradicting that module's stated invariant. Their column list omits `session_id`, `assignment_id` and `body`, so every state change and field change lands with a null session — making "who moved this" unanswerable in #28's `whatChanged` for exactly the mutations most worth attributing. Also gives `recordFieldChanges` its first caller | 20 | |
| **103** | **Terminal items out of the default read.** `get_board` and `list_items` return finished work on every call — it is the majority of the payload and the share only grows, because nothing prunes terminal state. Exclude terminal states by default, with an explicit opt-in (`--all` / `includeTerminal`) for the cases that want them, and apply the same default to the board's completed column. A filter and a default, not new machinery | 26, 36 | |
| **104** | **An event type cannot be added without an emitter.** A gating script, with the self-test every gate here ships: enumerate the event-type enum, enumerate what the service layer actually emits, and fail on a value nothing writes. `SCHEMA.md` §3 already states the rule — *add an event type only when the code that emits it exists* — and #98–#102 are what it costs when nothing checks it: a capability declared, validated, guarded and displayed, with no writer. Per-row status cannot show a gap between rows; this can | 20 | |
| **105** | **Search over items** — `search` as a service call and its routes/tools/verb, indexing title and body and returning ranked matches. Answers "there is a task about this somewhere", which is otherwise unanswerable without pulling every item; the need is sharpest for a session reading a corpus it did not create. **Title and body first, deliberately** — checkpoints, events and artifacts are a substantially larger corpus and a substantially larger piece of work, and are worth attempting only once the cheap index is shown to be insufficient | 26 | |
| **94** | **Adapter conformance harness.** Drivers behind a map typed from the adapter registry; cases authored once per operation, run against every driver; four assertions — identical outcomes by `code`, `guard` and fields · accept-and-reject per operation · **every registered guard covered by an observed rejection** · adapter completeness with bounded waivers — plus a negative control per assertion and a non-empty-guard-registry assertion | 26, 27, 29, 81, 82, 85 | |

**Milestone done when:** an agent can be handed an item and work it to merged using only MCP, **and
every adapter passes the conformance harness.**

> **#98–#102 are one finding, not five.** They came out of a single audit that asked one question of
> the whole codebase: *what can be read but not written?* Each answer has the same shape — a
> capability declared in the schema, validated, guarded and displayed, with nothing anywhere that
> produces it. Every one of them sits under a row already marked `done`, and correctly so: each of
> those rows delivered exactly what it promised. The gap is between rows, which is the one place a
> per-row status cannot show it.
>
> **#98 is the one that blocks the milestone.** The done-when above says an agent can work an item to
> merged using only MCP. It cannot: three of the transitions on that path require an artifact, and no
> surface creates one. An item minted through the product reaches `executing` and stops — it can be
> cancelled or marked research-done, never merged. Everything else in this group degrades the product;
> this one prevents its core loop from closing, so it should land first.
>
> **Why it stayed hidden is worth recording.** The importer *can* write artifacts, so items loaded
> from an external store carry them and merge normally. Only freshly-minted items hit the wall — which
> means rehearsing against imported data (#40) exercises the path that works and misses the one that
> does not. A guard whose demand is unsatisfiable is also indistinguishable, at the point of use, from
> one you have simply not satisfied yet: the refusal reads as the system working. It was noticed by
> tracing every writer of a table, not by using the product.
>
> **The general lesson, for whoever adds the next enum value:** `SCHEMA.md` §3 already states the rule
> this group broke — *add an event type only when the code that emits it exists*. `open_loop` and
> `open_loop_closed` were added with a read path, no spec section and no milestone row, which is
> precisely why #100 exists to finish them. The rule is right; it needs a check, not a restatement.
> **#104 is that check**, and it is the row that stops this group having a sequel.

> **#103–#105 come from using the product, not from auditing it.** They were written down during the
> first sessions to work through the agent surface, and they share a shape worth naming: none is a
> missing capability. The operations exist and return correct results. What is missing is the product
> telling a caller what it wants and returning an amount it can actually receive.
>
> **#103 is the cheapest row in this file and fixes the most common read.** A default filter. The
> reasoning generalises past the one endpoint: *the default should answer the question people actually
> ask*, and nobody opens a tracker to see what is finished. It is also not merely wasteful — a read
> whose response cannot fit in the caller's context is not a slow read, it is a failed one, and it is
> the first call a new session makes.
>
> **The same failure has a documentation half that is not a row here**, because it is not code: the
> tool descriptions are one-liners, and the schema is not visible through the agent surface at all. So
> a required field is discovered by being refused, and a response size is discovered by exceeding a
> limit. Putting required fields, conditional requirements and response-shape warnings into the
> descriptions an agent already reads before calling would remove most of both — it is editing strings,
> and it compounds across every session that ever starts here.

---

## M5 — The board, and going live

*Feature: you can see the work, and orchestrators run on this for real.*

| PR | Delivers | Needs | Status |
|---|---|---|---|
| **35** | Profile picker — choose a user profile, remembered in the browser, switchable from the top bar | 9, 26 | `done` |
| **36** | Board API: items grouped into columns, filters | 26 | `done` |
| **37** | Board UI: the four columns, amber/red split in Waiting, needs-you badge | 35, 36 | |
| **38** | Since your last visit — per person, and a "seen" action | 20, 35 | |
| **39** | Compatibility shim — a command-line surface routed at the API unchanged, kept for one release | 26, 27 | `done` |
| **40** | Go live: rehearse against imported data, switch the source of truth over, retire the shim. **Performed on a day when nothing is executing** — duplicate, verify against the duplicate, then switch; never a wholesale swap with items in flight (`DECISIONS.md` §11, §13h) | 13, 37, 39 | |
| **86** | `/settings` — categories, widgets, per-field help and validation all rendered from the registry; value-source badges; reset-to-default; the `sensitive` section with typed confirmation; unrecognised and invalid override sections; the read-only build-constants and bootstrap panels; first-run entry when no profiles exist | 35, 78 | |
| **87** | Budget-window editor — per-window cards, the three boundary kinds in plain words, the band chart, drawn validation errors, the time scrubber, and presets. Plots an account's position **once usage readings exist**; before that the chart is the boundaries alone | 86 | |
| **93** | Administration UI — one page pattern per entity kind, over the API from #92, linked from `/settings` | 35, 92 | |

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
| **42** | The hook script: one file, fires after each tool call and at stop, cached rules | 41 | |
| **43** | Session registration handshake: the `sessions` table (additive migration), the registration transport recorded as the capability signal in five values matching the adapter names, `standup session register` and its route, a transport-specific reply naming the matching hook variant, and per-variant protocol version comparison — advisory when stale, refusing a claim when incompatible or absent. Plus a CI assertion that the shipped hook's declared version equals the build constant, so nobody has to remember to bump the right one | 42, 79 | |
| **44** | Merge gate: the judgement server-side, only command parsing local | 18, 42 | |
| **45** | Process registry, and the kill guard as an **ownership check** | 42 | |
| **46** | Nudges: delegate mode, staging, escalation, wind-down | 25, 42 | |
| **47** | Stop-hook catch: live crew and nothing scheduled to wake you | 42 | |
| **48** | Plugin package — MCP config, hook config, and the command line in one install. **Consumes the published package rather than carrying a copy of the binary** | 30, 42, 89 | |
| **49** | `/setup-agent-standup` — registers the scheduled task, then **proves it works** with a live call | 48 | |
| **88** | `standup hook` — the hook payload on stdin, the local telemetry spool and its batched flush | 42, 79 | |
| **89** | Publish the package with the `standup` binary on the same version tag that publishes the image | 79 | `done` |

**Milestone done when:** one hook script covers every guarded event, and the only judgement left on
the client is the handful of checks that cannot run anywhere else.

> **⚠️ The ask path is inert until #43, and every row below #42 builds on it.** Found in review of
> #42, and recorded here so five downstream rows do not each rediscover it. Two individually correct
> contracts compose into a dead path:
>
> - `hook_decision` returns `ask` for an ask-list match — that is its whole contract.
> - The hook reads `ask` as a **deny**, because it has nothing further to consult.
>
> So **every ask-list match is denied, even against a healthy, reachable, correctly-configured
> server.** Relatedly, the hook refreshes its cache only from the rule lists in the response, and the
> response carries none — so `writeCache` is never called in production, and a machine with no cache
> file round-trips on every tool call forever.
>
> **It fails closed, which is why this is a note rather than a defect.** Nothing is unsafe; the
> capability is simply absent. #43 is the row that adds the registration and response fields that make
> it real, which is why it should land before #44, #45, #46 and #88 — those are precisely the rows
> whose behaviour is supposed to live on the ask list, and each would otherwise be built against a
> path that cannot fire.
>
> The general shape is worth naming, because it is the same one #98–#102 came from: **a composition
> gap between two rows that are each individually complete.** Neither row's own tests can see it,
> because neither row is wrong.

---

## M7 — Telemetry

*Feature: everything measures itself. Nothing reads it yet — see the warning.*

| PR | Delivers | Needs | Status |
|---|---|---|---|
| **50** | Tool-call ingest from the hook, with the item's state at the time, caps on the big fields | 42 | |
| **51** | Runs: a new run whenever the model or effort changes; the hook reports the model per call | 50 | |
| **52** | Price table and cost, always recomputable from the token counts | 51 | |
| **53** | Aggregation: cost per item, per session, **per stage** | 52 | |
| **54** | Repeat-command detection, how wide the file spread is, read-to-write ratio | 50 | |

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
| **72** | Item detail: subtask tree, artifacts, history, summary | 37 | |
| **73** | Drag between columns, with the move showing immediately | 37 | |
| **74** | Project view and progress view | 72 | |
| **75** | Filters and search: area, repo, state, who's on it, priority | 36 | `done` |
| **76** | **Mobile** — P3. A different flow, not a squeezed desktop: a list with a status picker instead of drag, filters in a sheet, thumb-sized sliders, and you can still mint work | 68, 73, 75 | |
| **96** | **Retiring a reference row** — P3, optional. Surfaces the `archived_at` the schema already carries: `PATCH /repos/{id}`, `/areas/{id}`, `/people/{id}` sets it, archived rows drop out of pickers and default `GET` lists but still resolve everywhere they are already referenced. Plus the inverse — `DELETE` with an explicit hard-delete flag, allowed **only** when a reference count across every referring table is zero, refused with the counts otherwise | 91, 92 | |

---

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
