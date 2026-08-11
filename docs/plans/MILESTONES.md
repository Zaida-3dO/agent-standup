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

---

## M2 — Data layer

*Feature: the database exists, and a backlog held in an external file-based store can be imported
into it.*

| PR | Delivers | Needs | Status |
|---|---|---|---|
| **7** | Initial migration — the **whole schema** in one baseline | 3 | `done` |
| **8** | DB client, connection pooling, migrate-on-boot wiring | 7 | |
| **9** | Seed: `people` (two user profiles), `agents` name roster, `accounts` | 8 | |
| **10** | Importer — items: a directory-per-task store → `items`, status remap, the source identifier into `custom_fields` | 8 | |
| **11** | Importer — events: the source store's history log → `events`, actor mapping | 10 | |
| **12** | Importer — assignments and artifacts: claims, roles, review files | 10 | |
| **13** | Import verification: row counts, spot-check report, idempotent re-run | 11, 12 | |

**Settled:** finished items import as a **collapsed summary**, one row each; in-flight and blocked
items import in full. The import reads its source and never writes to it, so the detail can be
backfilled if it turns out to be wanted. See `DECISIONS.md` §13c.

---

## M3 — Rules engine

*Feature: the server enforces the rules. No surface yet — this is the core everything else calls.*

| PR | Delivers | Needs | Status |
|---|---|---|---|
| **14** | Service-layer skeleton, transaction handling, typed errors | 8 | |
| **15** | State machine: all-to-all transitions, guard framework, rehearsal mode. Projects have **no stored state** — theirs is derived from their children, so guards never run against one | 14 | |
| **16** | Guards — blocked and paused: required fields, clearing on exit | 15 | |
| **17** | Guards — artifacts: review requested, plan approval, evidence at the tip commit | 15 | |
| **18** | Guards — merge: commit, approving review, visual gate, who may authorise | 17 | |
| **19** | Guards — hierarchy: cannot finish while a child is still actionable | 15 | |
| **20** | Events: append on every mutation, field-change rows, timestamps in the same transaction | 14 | |
| **21** | Summaries: shape, caps, reject-don't-truncate, similarity check, jargon denylist | 15 | |
| **22** | Deferral proof for anything left undone — typed reasons, follow-up must be blocked | 19, 21 | |
| **23** | Claims: atomic, one orchestrator per item, root-session check — **also carries the two partial unique indexes deferred from the initial migration** (`SCHEMA.md` §2; `DECISIONS.md` §13d) | 14 | |
| **24** | Liveness ladder: quiet → stalled → dead, resume attempts, escalation to blocked | 23 | |
| **25** | Notification rules: all-of / any-of, fires on the edge only, whitelisted fields | 20 | |

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
| **26** | Web API: items — create, read, update, list with filters | 14 | |
| **27** | Web API: transition and complete, with rehearsal mode | 15, 21 | |
| **28** | Web API: orientation — checkpoint, state, what changed, open loops, crew | 20, 23 | |
| **29** | Web API: claim, release, heartbeat | 23 | |
| **30** | MCP adapter skeleton — **stateless**, streamable-HTTP | 26 | |
| **31** | MCP read tools: get item, list items, my work, orientation | 28, 30 | |
| **32** | MCP write tools: create, update, transition, complete | 27, 30 | |
| **33** | MCP session tools: claim, release, heartbeat, checkpoint, note | 29, 30 | |
| **34** | Crew naming: hand out a name, assign it, retire it | 9, 14 | |

**Milestone done when:** an agent can be handed an item and work it to merged using only MCP.

---

## M5 — The board, and going live

*Feature: you can see the work, and orchestrators run on this for real.*

| PR | Delivers | Needs | Status |
|---|---|---|---|
| **35** | Profile picker — choose a user profile, remembered in the browser, switchable from the top bar | 9, 26 | |
| **36** | Board API: items grouped into columns, filters | 26 | |
| **37** | Board UI: the four columns, amber/red split in Waiting, needs-you badge | 35, 36 | |
| **38** | Since your last visit — per person, and a "seen" action | 20, 35 | |
| **39** | Compatibility shim — a command-line surface routed at the API unchanged, kept for one release | 26, 27 | |
| **40** | Go live: rehearse against imported data, switch the source of truth over, retire the shim | 13, 37, 39 | |

**Milestone done when:** the board is the live view, and every orchestrator reads and writes through
the API rather than against anything it imported from.

---

## M6 — The hook

*Feature: the rules reach into sessions, through a single hook script.*

| PR | Delivers | Needs | Status |
|---|---|---|---|
| **41** | The hook endpoint: allow-list silent, ask-list answered, **denies when unsure** | 14 | |
| **42** | The hook script: one file, fires after each tool call and at stop, cached rules | 41 | |
| **43** | Session registration handshake, hook version check | 42 | |
| **44** | Merge gate: the judgement server-side, only command parsing local | 18, 42 | |
| **45** | Process registry, and the kill guard as an **ownership check** | 42 | |
| **46** | Nudges: delegate mode, staging, escalation, wind-down | 25, 42 | |
| **47** | Stop-hook catch: live crew and nothing scheduled to wake you | 42 | |
| **48** | Plugin package — MCP config, hook config, and the command-line binary in one install | 30, 42 | |
| **49** | `/setup-agent-standup` — registers the scheduled task, then **proves it works** with a live call | 48 | |

**Milestone done when:** one hook script covers every guarded event, and the only judgement left on
the client is the handful of checks that cannot run anywhere else.

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
| **55** | **Spike:** launching a session unattended on Windows, locked and logged in | — | |
| **56** | Accounts and usage readings, from the hook and from polling; handling stale readings | 9, 50 | |
| **57** | Budget bands: four of them, boundaries that move with the clock, strictest window wins | 56 | |
| **58** | The poll: a machine reports its sessions, usage, and anything waiting to be minted | 56 | |
| **59** | The planner: sort by priority, pack against headroom, deterministic ordering | 57, 58 | |
| **60** | Launch prompts composed server-side; dispatch and dispatch-claimed recorded | 59 | |
| **61** | The launcher script and its scheduled task, per machine | 55, 60 | |
| **62** | Failed-launch detection: dispatched, never claimed, past the threshold | 60 | |
| **63** | Minting: triggered by demand, scans your sources, never mints the same thing twice | 26, 58 | |
| **64** | Wait-for-crew and the crew digest; the command-line tool, run in the background | 24, 48, 54 | |
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
| **75** | Filters and search: area, repo, state, who's on it, priority | 36 | |
| **76** | **Mobile** — P3. A different flow, not a squeezed desktop: a list with a status picker instead of drag, filters in a sheet, thumb-sized sliders, and you can still mint work | 68, 73, 75 | |

---

## Critical path

**1 → 2 → 3 → 7 → 8 → 14 → 15 → 27 → 30 → 32 → 40.** Everything else hangs off that spine. Two
things get sequenced wrong more often than anything else:

- **M7 before M8.** Telemetry has no consumer until M9, so it reads as deferrable. It isn't — the data
  can't be backfilled.
- **#55 before the rest of M8.** It has no prerequisites and can start any time, but the whole
  milestone assumes it works. Unattended launch is well-trodden ground rather than a gamble —
  confirm it early anyway.

## Decisions blocking specific PRs

| Question | Blocks |
|---|---|
| The band numbers, beyond the starting values | 57 |
| Does Codex need the blocking wait-for-crew fallback? | 64 |
| What else the command-line tool should do beyond wait-for-crew | 64 |
| Front-end framework beyond the first board view | 73 |

## Not scheduled, deliberately

A per-machine limit on how many sessions run at once (a resource concern, and whatever pools browser
sessions is the natural owner of it) · a client-side validation gate before review (review is the
gate; a second one earns its place only if it catches something review doesn't) · a hard list of
paths that can never auto-merge (dropped) · a real custom-field system (the escape-hatch field will
do; keys that keep recurring get promoted to columns) · threaded discussion (cut, and only comes
back designed properly with replies).
