# Agent Standup — decision log, 2026-08-09

Everything settled in one long planning session with the user, with the reasoning. Written so nothing
depends on a conversation surviving.

**Companion docs:** `PLAN.md` (readable overview — accurate but stops before the heartbeat design) ·
`SCHEMA.md` (tables, config, endpoints — current) · `plan-technical.md` (**stale**, superseded by this
file and `SCHEMA.md`).

**Source material:** a planning brain-dump, including its addenda A1–A5.

---

## 0. Name

**Agent Standup.** Command `standup`. Packages published as `agent-standup`, repo `agent-standup`.
Bare `standup` is squatted on npm (dead v1.0.0 since 2022) and taken on PyPI; `agent-standup`,
`agentstandup` and `agents-standup` are free on npm, PyPI, and as GitHub orgs. The "Agent" prefix also
stops it reading as another async-standup Slack bot (Standuply/Geekbot/DailyBot).

---

## 1. What it is

One repo containing a backend, an MCP adapter, a CLI, and a web front end. Replaces
a 1,007-line PowerShell CLI, the markdown task store (186 dirs), the ping supervisor script
(~1,300 lines), two prose ledgers totalling ~50k tokens, and ~92% of the hook layer.

**The shift:** rules currently live in hooks that *ask* agents to behave. They move into a backend
that *enforces*.

**The app is fully functional without the heartbeat.** Bands, hooks and gates all apply to a session
you start yourself. The heartbeat only adds "start something unattended."

---

## 2. Data model

### One recursive item type
Project / task / subtask are **depths, not three types** — an item has a nullable `parent_id`, nests
arbitrarily, no special handling. Rationale: agents already spawn sibling tasks that are really
subtasks, because no subtask concept exists, which makes the board lie about work in flight.

### Eleven states, five derived columns
Columns are computed at read time, never stored, never transitioned. Adding `paused` forced five
columns rather than the four originally specified — it is neither in-progress nor blocked, and
folding it into either destroys the property that makes "Blocked" trustworthy.

### Any state to any state
No edge whitelist. Every currently-forbidden move is either bookkeeping strictness (deleted) or a real
precondition (becomes a required field). Audited: evidence gate, visual gate, merge auth and
claim-release all survive as required fields; the linear plan→review→approved chain and the terminal
dead-ends are deleted.

### `blocked` is narrow
Means **an outside actor must act** — you, another person, an external process (a SMART check running), or a
date. Explicitly *not* budget waits. If an agent could unstick itself, it is in progress.

### `paused` (the user's call, corrects an earlier position of mine)
Nobody is on it; resumes on a condition the system re-checks itself. Covers budget wind-down **and**
a dead owner. I initially argued the task should never move and only the assignment should change;
that was too pure — if nobody is on it, it genuinely isn't in progress, and leaving it in `executing`
recreates the rotting-in-executing problem.

**Critical detail: the attempt counter resets on durable evidence, not on claim.** Otherwise
dispatch → claim (reset) → die → repeat forever, and it never escalates. Claiming auto-unpauses (a
separate un-pause step is one an agent can forget); the counter clears only on a checkpoint, commit,
transition or artifact. Three attempts with nothing durable → `blocked`.

### Two ownership axes, never merged
`items.state` = where the work is. `assignments.status` = whether a worker is healthy. Review rounds
increment a counter and do **not** move the card.

### Ownership is a rich object
Role, session, agent type, **parent session** (the spawn tree — answers "the orchestrator died, what's
still running?"), machine, PID, branch, worktree. Superseded assignments are retained, not
overwritten, so an old session gets *told* who took over rather than failing blankly.

### Closing summaries (addendum A5)
Required to reach any completed state. Typed fields with hard caps, `not_done` mandatory even when
empty, `user_facing` forcing a where/what-to-test or how-verified branch, `final_state` derived.
Static validators: caps reject rather than truncate; no near-verbatim copy of a history row; a
**jargon denylist** on human-facing fields; `how_verified` may not be only a CI reference.

Origin: the since-your-last-visit card for `T-20260723-fm-flow-align` rendered five bullets that were
raw `loop-add`/`loop-close` rows, two pairs saying the same thing twice, with the one load-bearing
item (the user reversing the one-task-per-PR rule) ranked last — and an OUTCOME line reading *"no merge
note recorded."* The field that should carry the summary was empty, so the renderer improvised.

### Fields, not plugins
`first_mate_id`, `crew_id`, `playwright_session_id`, `standing_auth` are **generic fields holding
user-specific values** — assignee-with-role, an approval reference, a browser session on a visual
review. The vocabulary is the user's; the fields are generic. No custom-field machinery needed for v1.

### `area` replaces `repos`
`repos` presumes git and code. Split: **`area`** (required, generic, works for research or an HA
change) and **`repo` + `branch`** (optional, concrete, only when code exists — the merge gate needs
exact repo identity, which a loose category can't give). Worktree lives on the **assignment** with its
**machine**, because a path without a machine is meaningless across two PCs.

### Profiles, not accounts (added 2026-08-10)
Netflix-style profile picker on the front end; choice stored in the browser, changed from a top-bar
icon. Two profiles to start. **A claim, not a credential** — no password, anyone reaching the app can
pick any profile. It answers *who did this*, never *who may*.

Four consequences in the data model, all cheap now and painful later:
1. A `people` table, with attribution split into `actor_type` (person/agent/system) + `actor_id`.
2. **Seen state becomes per person** (`event_seen`) — one person marking something read must not clear it
   for another. This cannot be a column on `events`.
3. `run_scores.user_scored_by` — Two people may judge the same work differently, and collapsing them
   loses exactly the signal the two-scale design exists to capture.
4. **`blocked_on` stops hardcoding names.** It becomes `blocked_on_type` (person/external-process/time)
   plus a person reference — removing a user-specific leak that had got into core vocabulary.

### Monthly archiving deleted
A workaround for rendering a board from 186 folders. In a database, filtering is a query.

---

## 3. Architecture

### The service layer is the substrate — not HTTP, not MCP
Corrects an earlier framing of mine. The front end needing HTTP settles the *front end's* transport
and nothing else. Validation lives once in a service layer; **HTTP and MCP are peers**, neither
primary. Judged on merits, MCP is right for agents (discoverable, typed, structured errors); HTTP is
right for the UI and anything that isn't an MCP client — which is what keeps this unlocked from Claude.

### The backend contains no LLM
Every judgement in the system happens inside a session; the server only stores and checks. Walked
every candidate — launch prompts (retrieval), dispatch selection (sort + bin-pack), batching (same
parent), grading (objective signals + a session posting a score), summaries (agent writes, code
validates), model recommendation (lookup), nudges (rule evaluation). None needs a brain.

Buys: no credential on the NAS, deterministic so CI can gate it, no outage that costs money, and
vendor-neutrality for free.

**Costs flexibility, honestly.** Changing the planner is a deploy, not a prompt edit. Accepted because
"an agent might read my prompt differently today" is the problem this app exists to kill — but it
means the config surface must be good.

### MCP Tasks (SEP-2663) does not fit
Investigated properly against the spec. Four blockers: only the **server** creates a task (wrong
direction — we need the agent reporting on its own work); the client can only answer questions the
server asked, never append; terminal is permanently terminal (we need reopening); and tasks expire via
TTL while work items live for weeks. It also wouldn't save what was hoped — session cost is schema
residency and results landing in context, neither of which a handle changes.

**Where it does fit:** genuinely long server-side operations — importing 179 task folders, a heavy
report. Use it there.

### No plugin system
One app, strict vocabulary boundary. Core may know items, parents, state, events, checkpoints, claims,
comments, agents, evidence. Core may **never** know First Mate, crew, ping, budget points, pace line,
Playwright, Claude, Codex.

**The user-specific parts are a separate program that talks to the API, exactly like the front end
does** — not add-ons inside the app. The heartbeat asks for state, applies the user's budget rules and
priorities, and says what to do. The core never knows it exists.

The pattern that emerged from the generic/user-specific audit: **everything generic is storing and checking;
everything user-specific is deciding what to do next and what it costs.**

### Capability-by-reference — the load-bearing pattern (the user's)
**Core decides *when* something must happen; you supply a document saying *how*; core hands over the
pointer at the right moment and never reads it.** Notify and visual review both work this way, and any
future capability costs one config entry plus a doc.

This is what makes the core genuinely generic — it never learns that any chat app or browser tool exists —
and it works from any agent, because "read this file" is not a Claude concept. Four rules: validate
the path at **config** time not transition time; return the path not the contents; be honest it's a
nudge (the core can require confirmation, not verify); make it a registry, not two special cases.

### First-class, not add-ons
**Visual review** and **budget tracking** are core features, because the niche isn't "task tracker" —
it's "task tracker for AI coding agents," where both are central. Cost is recorded vendor-neutrally
(tokens, money, normalised quota %) with the vendor behind an adapter.

---

## 4. The hook layer

**One script, wired to both `PostToolUse` and `Stop`**, branching on the event type from stdin. Two
lists: patterns it always allows (log silently) and patterns where it **waits for a server verdict**.
Fails **closed** — no answer means denied.

The ask-list is **patterns, not tool names.** Matching on `Bash` would send every command your agents
run off-box and add a round trip to everything. The server supplies a cached pattern list; no match →
allow locally, zero network.

**The machine-wide-kill guard moves server-side too** (the user's call, overriding my suggestion of a local
floor — two implementations of one safety rule can disagree, and other installs wouldn't have the
floor). This is an upgrade: the server can do an **ownership check** — is that PID yours? — where the
local rule could only pattern-match. Requires agents to register processes they start.

**From 17 wired hooks (~3,900 lines excluding Playwright) to essentially one.** Deleted outright:
task-doc-guard (no files to guard), standing-auth-track (the table answers the real question),
fm-tick, dispatch-report-guard, verify-guard-coverage. Absorbed: escalation gate, staging nudge, HA
SSH nudge, delegate nudge, session-start, relay gate. The merge gate keeps its local
command-*parsing* but its *judgement* becomes one query.

**This deletes a live bug class:** `fm-tick.ps1` and `fm-tick-inline.ps1` currently share an interval
constant, and one publishes it to a runtime file so they can't silently diverge. One script removes
the whole mechanism.

### Origin of the kill guard, for the record
LEARNINGS #46 — a crew agent ran `taskkill /F /IM node.exe`, killing four sibling agents' dev servers.
Deliberately not marker-scoped: the damage comes from workers, not the orchestrator.

### Guards and manual sessions
Guards apply to **autonomous** sessions only; user-driven sessions are logging-only. **One exception**
— actions whose blast radius reaches past your own session (killing processes while agents run,
closing a shared browser). Those become **warnings that name the consequence**, never blocks.

---

## 5. The heartbeat

### Shape
Each machine runs a scheduled task that polls (`POST /poll`, default 300s) and launches whatever comes
back. ~30 lines, no decisions. The server-side planner is **pure code**.

**This deletes the single most expensive thing in the system** — today the ping is itself a Claude
session reading the board, averaging ~2M input-equivalents a tick. A tick that finds nothing now costs
one HTTP request, which is *why* polling can be frequent: today's 100-minute interval was chosen
against the prompt cache, and fresh sessions plus a code planner remove that constraint.

### Allocation (the user's design)
Budget headroom as **points = percentage points of the window** — no new unit, estimates and budget
are automatically in the same currency. Estimates from cost history, or from `difficulty` facets for
unseen work. In-flight work subtracts. Sort by priority, fill until exhausted, return the list.

**The allocator doesn't need to be accurate** — wind-down is the backstop for an overrun, so it only
has to be roughly right.

### The two-machine race — the user was right, I was wrong
I argued a reservation table was needed. Traced properly: the **list is the allocation**, and both
machines fulfilling the same list fulfils it once (whoever wins each atomic claim, wins; the other
fails). Partly-staggered polls also work, because the server subtracts already-claimed work and hands
the second machine a correspondingly shorter list.

Two conditions, both just "write it correctly": **deterministic ordering** (stable tiebreak on item ID)
and **the server subtracts in-flight work**. **No reservation table.**

Kept instead: a `dispatches` **log**, so a launcher that silently fails is detectable — otherwise
"never launched" and "never dispatched" are indistinguishable.

### Credentials stay on the PC
Not security-first: Claude Code **refreshes** that OAuth token locally, so a copy on the NAS goes stale
and silently loses its usage picture. The **hook carries a usage reading** on every tool call, which is
far fresher than any poll and free.

### Launch prompts are server-composed (the user's preference, conceded)
The user's own design already returns "an array of prompts," so composition is server-side and rich
templating is free — no template on disk to go stale, and it can be **shaped to the situation** (fresh
start vs rework vs stalled pickup want different briefings). Line held: **stable instructions in, live
state fetched** — checkpoints, open loops and crew state stay behind `orientation` because they change
between composition and use.

### Minting
Server detects the need (on-deck below threshold, or the poll reports pending source items); the poll
returns a "go mint" prompt; a dedicated agent reads the configured sources and mints.

**The file is the atom, not the section** — the user's objection killed the per-section `source_ref` design,
and the deeper problem is that two agents can split one document differently, so per-section identity
can't be made deterministic *at all*. The agent claims `path + content_hash`; a second agent finding it
processed skips. Appending to a processed file changes the hash and makes it eligible again, and the
agent is told which items already came from it. `source_ref` survives on the item for traceability only.

The server can't see the files, so **the poll carries a local scan** — paths and hashes from configured
globs. Hashing a handful of files every five minutes is free.

### Open on the heartbeat
Windows launch is a **port, not a spike** — `PatrickPing` already launches Claude Code sessions
unattended and has for weeks. Verified its registration: runs as the desktop user, **LogonType: Interactive** →
fires when locked, does **not** fire when logged out. The user: acceptable, their PC is always logged in.

Auth deferred: reachable from his PC without a token, like fynance. Not designing around Docker
networking for v0.

---

## 6. Orchestrator supervision — the missing feature

**Nothing reliably checks on crew today.** `fm-tick.ps1` is a Stop hook (fires when a turn *ends*);
`fm-tick-inline.ps1` is PostToolUse (fires when a tool *returns*). **Neither is a timer**, and neither
can fire while an orchestrator is blocked inside a subagent call. `fm-tick-inline.ps1`'s own header
records observed gaps of **294 / 264 / 253 / 249 / 198 / 195 minutes — up to 4.9 hours.**

### `wait_for_crew` — long-poll
Server holds the request open and returns on a crew event **or** timeout, whichever first. Solves
supervision, cadence, and cache warmth at once, with no timers.

**Backgrounded, not blocking** (the user's improvement). Claude Code re-invokes an agent when a
backgrounded command exits — even after the turn ends — so the orchestrator stays free for the user's input,
can do other work, and can end its turn entirely and still be woken. Blocking would queue the user's typed
input behind it for up to the timeout.

**Which is why it's the CLI, not an MCP tool** — MCP calls can't be backgrounded; Bash calls can. The
plugin ships the `standup` binary in `bin/` alongside the MCP config and the hook, so it's still one
install. The CLI stays tiny: only what must be backgrounded.

**Portability:** Codex has no equivalent — searched, and what it has runs the other way (`notify` fires
`agent-turn-complete` outward to a human/webhook; cloud tasks are fire-and-forget). So the blocking MCP
variant is a genuine fallback, not defensive. Same endpoint, two doors.

### The digest is computed, not investigated
The server composes the briefing so the orchestrator reads instead of hunting: per-crewmate tool
counts, path spread, read:write ratio and how it's changed, durable artifacts, latest checkpoint line,
budget position. Repeat-command detection is a `GROUP BY` on command text.

**Computable anomalies:** repeated identical commands · working **outside the task's declared area or
repo** (exact, strong) · the same file edited repeatedly · call rate climbing while durable output
stays flat · cost outpacing estimate · no checkpoint in N minutes.

**Honest limit:** *"pursuing a plausible but wrong approach"* is not computable — an agent can be
productive, varied, on-path and completely wrong. That's why the call returns a **briefing, not an
alert**: server surfaces anomalies, orchestrator judges direction. The crewmate's own checkpoints carry
the semantic layer, written by the agent, and cost nothing extra.

### Acting on it
A nudge left for a crewmate is delivered on that crewmate's next tool call, through the hook. **Free
inter-agent messaging** with no new mechanism.

### Stop-hook catch
When an orchestrator tries to end its turn with **live crew and no pending wake**, the Stop wiring
nudges it to start `wait-for-crew` first. Condition is *"crew running AND nothing scheduled to wake
you"* — silent if a wait is already backgrounded, or you'd nag every turn. **Nudge, not block**: a
refused stop can trap an agent in a loop, and the server's staleness ladder is already the backstop.

### The backgrounding nudge
Long-running tools should be backgrounded rather than blocking a session. **Learnable from data
already collected** — the gap between consecutive tool calls *is* the duration of the call between
them, so the server learns "this command takes ~18 min in this repo" for free and can nudge **before**
the call via the ask-list. Retrospective flagging is the fallback for unseen commands. A nudge, not
enforcement — some calls genuinely can't be backgrounded.

---

## 7. Budget

**Four bands, not two ceilings:** free · selective (high-value only) · **wind down** · stop.

Band three is the new and most valuable one: start nothing, get in-flight work to a *good stopping
point* (not necessarily finished), take shortcuts to a clean pause, write the handoff. Today the system
hits a wall mid-thought and strands work — which is exactly why resumes were so expensive.

- **Stricter of the two windows wins.**
- **Autonomous only** — never blocks the user.
- **Boundaries move with time** (a pace line). Weekly wind-down `15 × days − 5`; 5-hour `80` rising to
  ~`92` in the final hour.
- **No formula language.** Every boundary is a constant or `slope × elapsed + offset`, optionally
  switching on a time condition — an ordered list of *(when, value)* pairs. Declarative, testable, no
  parser.
- Wind-down reaches in-flight agents through the per-tool-call nudge, which costs nothing extra.

**Concurrency ceiling deferred** (the user: the browser app fixes the freeze). Worth recording that the
freeze was **not a budget event** — 11 MCP servers × 6 sessions ≈ 69 processes, ~6GB; every session
could have been inside budget. If it recurs, a per-machine session cap is config plus a count, no
migration.

### Ghost tasks (the user's design)
Unminted user sessions still send tool calls, so a session ID the server has never seen and that holds
no claim **is** a ghost. Counted toward capacity with a deliberately high baseline (an unknown session
is unbounded; guessing low risks the freeze, guessing high costs a delayed dispatch). Staleness reuses
the same ladder. Later refinement: the ghost's own **tool-call rate** is a better estimator than a
constant, and it's free. Nudge the *agent* to mint, triggered on the first **write-shaped** action —
nudging on a read trains people to ignore nudges. Ghosts must never gate the user's own session.

---

## 8. Telemetry and scoring

**Cost logging is a byproduct, not a task.** Today an orchestrator self-reports quality 1–10 and **94%
of 678 runs came back a 9 or a 10** — a number that cannot discriminate. Every tool call reporting its
own cost is objective and complete with nobody remembering anything.

**One field that can't be backfilled: the item's state at the time of each call.** Without it you can't
answer "how much does review cost versus building," which is the question worth asking.

### Facet scoring
Multi-facet difficulty and competence rather than one number. Objective signals are the spine
(review rounds, finding categories, rework, bugs surviving to merge, turns, time, cost); a rubric makes
judgement comparable; **never the same agent grading itself**.

**Judging reviewers by what round two catches is sharp** — but round two legitimately finds things the
round-one *fix* introduced, so "missed" and "newly created" must be told apart, partly by whether the
finding touches changed code.

### Two score scales, never merged
Agent score and user score are **different scales measuring different things** — an agent grades
against what it understands review to mean; the user grades against whether the thing works. A 4 from each
isn't the same 4. So:

- **Agent score is immutable once written.** Correcting it toward the user's destroys the delta, which is
  the actual signal.
- **The gap between them is the most valuable data in the system** — not just how the agent did, but
  how wrong the automatic grader was.
- **"Seen without touching the sliders" is a data point**, and the important one: the user only reaches for
  the sliders when something is notably good or bad, so the user score alone is a sample biased toward
  failures. Treating an untouched Seen as a weak endorsement fixes it for free.
- **Timestamp the correction** — a downgrade three weeks later (it broke in production) is far
  stronger evidence than one at merge time.

Scoring lives on the since-your-last-visit screen, pre-filled from the automatic grade, never blocking
Seen, showing only facets that were in play, and folding in the other branch of the user's flow: knocking a
score down offers to create a linked follow-up.

### Model picker
Soft-deny at spawn against a stored recommendation — the gate fires, the agent can override, the
override is recorded. Same shape as the merge judgement.

**Recommendation strength solves explore/exploit** (the user's design, better than my "occasionally try
cheaper"): strength is low if the tier below was never tested, high only when the tier below scored
badly and this is the lowest that scored well. Low strength → explore more often. The sharp bit: when
one facet demands the expensive model but *that facet's* recommendation is weak, that's precisely the
licence to try cheaper. Addition: bias exploration toward low-risk tasks.

**Sequencing:** build the mechanism in v1, ship it **disabled**, let logs accumulate, enable when
there's something to learn from. The code is bounded; the open-ended part is data, not code.

---

## 9. Merge authority

Three values: pre-approved · needs-approval · **agent-judgement** (the default, configurable). Under
judgement the agent decides at the gate and **must record a one-line rationale** — otherwise "the agent
thought it was fine" is unauditable, and an agent that can't articulate why it's safe can't merge.

The user declined a forced never-auto-merge path list as scope creep; parked as a future request. The
residual risk is that per-task marking depends on remembering at mint time.

The validation gate is being retired under its own task (its own task, cross-referenced
today). Agent Standup is built without it; whether it should be added back is that task's decision, and
only if it adds something the review pipeline doesn't.

---

## 10. Hosting and packaging

App and database on the NAS; agents on the PC; **the server never reaches into the PC.** Pull-only —
the PC asks, the server answers. The server can *want* things to happen; only the PC makes them happen.

**Ships as a Claude Code plugin** — one install carries the MCP config, the hook, and the `standup`
binary. This corrects an earlier position of mine: I'd designed a handshake-based self-installing hook
before checking whether the platform already solved it. It does, and the plugin route is also safer
(no server sending executable code to the PC).

**Still needs one per-machine step**: the OS scheduler entry for the poller, which no plugin can
install. A `/setup-agent-standup` skill does it — and must **verify, not just install**: register →
trigger one poll → confirm the server saw it. Re-running it doubles as the health check.

**Version drift** handled by the handshake: the hook reports its version, the server tells the session
to update. Warn, never self-modify.

---

## 11. Migration

Migrate everything, hard cutover, closed tasks included. 186 dirs / 144 merged. Status remap per §2.
`parent_id` null for all imports — no historical hierarchy to recover. **Open:** whether closed tasks
import full history or a collapsed summary (they're the bulk of the volume and the least useful).
The PowerShell CLI becomes a thin shim over the API for one release, then is deleted.

---

## 12. Facts verified today

| | |
|---|---|
| Existing MCPs | The two Python ones are **stateful** (FastMCP default; confirmed `Mcp-Session-Id` on initialize); the TypeScript one is **stateless** by design. Neither Python server has any per-session state — no `Context`, no progress, no resources, no prompts — so `stateless_http=True` is a one-line flip. One of them exposes **62 tools**, resident in context every turn. |
| MCP SDK | Python `mcp 1.28.1` in both containers. |
| Cache TTL | This session runs a **1-hour** prompt-cache TTL, **dropping to 5 minutes under usage overage** — i.e. exactly when running hot. Nothing signals the transition. Hence `WAIT_FOR_CREW_TIMEOUT = 240`, not 300. |
| Cache pricing | Write **1.25×** base (5-min TTL) or **2×** (1-hour); read **0.1×**. Marginal cost of a wait: do nothing 1.25N · 1-hour TTL 0.85N · pinging 0.025N/min. **The 1-hour TTL is cheaper than doing nothing, always.** |
| PatrickPing | Runs as the desktop user, **LogonType: Interactive**, RunLevel Limited, `powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden -File ping-launcher.ps1`. Currently Disabled. |
| Hooks | 23 files, 17 wired. Kill guard is the only non-marker-scoped FM guard. |
| Codex | No background-completion re-invocation found. `notify` fires `agent-turn-complete` **outward**; cloud tasks are fire-and-forget. |
| Ledgers | `WHILE-YOU-WERE-OUT.md` 130,011 chars (~32k tokens); `standing-authorizations.md` 73,310 (~18k). Untouched, ~45% of the boot corpus. |
| Claude Code plugins | Bundle `hooks/hooks.json`, `.mcp.json`, `skills/`, `agents/`, `bin/`, `monitors/`, `settings.json` in one installable unit; marketplace can be a private repo. |

---

## 13. Where I was wrong, and where the user was

Recorded because the reasoning matters more than the conclusion.

**Mine, corrected:** framing HTTP as the substrate (it's the service layer; the front end's transport
doesn't decide the agent's) · designing a self-installing hook handshake before checking that plugins
already bundle hooks · arguing a reservation table was needed for the two-machine race · insisting the
task never moves when its owner dies · labelling session markers and batching as user-specific when
only the *policy* was · suggesting a local kill-guard floor alongside a server rule · calling unattended
Windows launch a risk that could sink the design when `PatrickPing` already does it · treating the
model picker as too open-ended to build, when shipping it disabled defuses that entirely.

**The user's, that changed the design:** flat states with derived columns instead of two real levels ·
`paused` as a state · capability-by-reference · the file as the minting atom · recommendation strength
as the explore/exploit mechanism · backgrounding `wait_for_crew` rather than blocking · ghost tasks ·
separate user and agent score scales · the whole heartbeat being optional.

---

## 13a. Schema review round (2026-08-10)

The user read `SCHEMA.md` line by line. What follows is the reasoning, not the field list — `SCHEMA.md` has
the fields. These are the decisions most likely to be re-litigated by whoever builds this.

### The two rules that did most of the work

**Store facts, derive volatiles.** A fact was true at a moment and can't be recomputed — token counts,
timestamps, `tool_calls.state_at`. Everything else is a view. Caught five violations: `checkpoints.
is_latest` (needed writing the *previous* row on every insert), `tool_calls.duration_ms` (derived from
the *next* call, so unknowable at write time), `items.review_round`, `agents.in_use`,
`assignments.worktree_dirty`. Two denormalisations survived **with the reason written down**:
`items.updated_at` (a subquery per row on every board render is the wrong trade) and `runs.cost`
(recomputable from counts + model).

I also had `state_at` justified as "impossible to backfill" — **false**, since `state-change` events
carry `{from,to}`. Dropped from `events`; kept on `tool_calls` for the real reason, which is *query cost
at that table's volume*.

**Does this earn a table?** A satellite table needs a structural reason: editable, referenced by a
guard, or cardinality-constrained. Five failed and were cut:

| Cut | Why |
|---|---|
| `checkpoints` | An append. Now `events` with `type='checkpoint'` + `assignment_id`. |
| `comments` | A Jira convention imported reflexively. `note` events cover remarks; `items.body` covers durable instruction; neither design had threading, so "discussion" was never on offer. |
| `run_reviews` | A *value*, not a thing. Writing `user_score = agent_score` on accept distinguishes "nobody looked" from "looked, agreed". |
| `sources` | the user's fix: **always mint something, even a `wont-do`** — so `items.source_ref` answers the processed check, and the minting lease lives in the dispatch record. |
| `dispatches` | Looked mutable (`session_id` filled later) — but as **two appends** (`dispatch`, `dispatch-claimed`) it's pure ledger. |

**The counterexample that proves the rule:** `accounts` and `event_seen` were *added*, because a lease
and per-person read state are facts nothing else could hold. And `event_seen` stayed a join table
rather than an array on `events` for the mirror reason: **fold in things that append, keep separate
things that would mutate.** An array would make `events` update-heavy on its hottest read path.

### The user-specific leak sweep

Anywhere the schema named a person, it was wrong. Fixed in four places — `origin`, `blocked_on`,
`events.actor`, `artifacts.created_by` — all now type+id references to `people`. `authorizations` had
**no grantor at all**, which the markdown file got away with and a queryable table can't. `items.id`
stopped mandating `T-YYYYMMDD-slug`; legacy IDs live in `custom_fields.legacy_id`.

### Enum vs text

Same test as facets: you want the same value every time, or counts silently undercount. `events.type`,
`state_at`, `run_scores.facet` and `agents.role_hint` became enums. `assignments.role` is an enum with a
`custom` escape hatch — **and if a custom value recurs, promote it**, or the fragmentation just moves
down a level. Correctly text: `tool_calls.tool`, `model`, `effort` (you can't enumerate models that
don't exist yet).

### `not_done` — deferral must be proved, not explained (the user)

The strongest idea of the round. *"The explanation must meet a standard"* can't be graded as prose
without a model in the server — but it becomes exact if inverted: **if you're deferring work, prove
it's blocked.** Entries are typed; a `follow-up` needs a minted item that is `blocked` or `paused`, and
completion is **rejected** if that item is actionable. There is no reason code for *ran out of time* or
*too hard*, so they can't be expressed. The same test extends up the tree: an item can't complete while
a child is actionable.

**The rejection wording is the mechanism, not decoration** — a bare error teaches an agent to satisfy
the check. And the obvious cheat self-surfaces: falsely marking a follow-up `blocked` puts it on
someone's needs-you list, so gaming it makes the work *more* visible.

### Accounts, not machines (the user)

Usage belongs to the **account**; machines are compute. Budget state on `machines` was a modelling error
that reads fine with one account and stops making sense at two. Bands and the pace line now key off
`account_id`, and *"dispatch against whichever account has headroom"* becomes a query rather than a
redesign.

### Assignment uniqueness — narrower than either of us first had it

The user proposed `(item_id)`; I had `(item_id, role)`. **Both wrong**: an orchestrator works alongside a
builder and two reviewers. The only exclusive thing is **one active `orchestrator` per item** (a partial
unique index), plus an application check that a claim with a *different* `root_session_id` means a
second crew appeared. `root_session_id` was added **alongside** `parent_session_id`, not instead of it —
renaming would have flattened the spawn tree and lost *"the builder died, what did it leave running?"*

**Supersession stays one axis** (the user), on two invariants: you can't supersede a `running` assignment,
and **a rejected call is not activity** — otherwise a woken old session stamps `last_active` and flips
itself back to `running`.

### Smaller calls worth keeping

- **Facets** rebuilt from "where do models measurably diverge" rather than "kinds of work":
  `reasoning`/`breadth`/`precision`/`autonomy`/`visual`/`writing`. `coding` excluded (everything is
  coding, so it doesn't discriminate) and `refactor` excluded (a task *type*, decomposing into breadth +
  precision). Fixed union in code. **Facet data can't be retrofitted** — err toward more at the start.
- **Notification rules**: `{notify, when_all?, when_any?}` per rule, OR across rules. the user's flat
  two-bucket shape beat my nested one — no polymorphic arrays, three-line evaluator. Bounded to a field
  whitelist and four operators so it can't become a query language.
- **Profiles, not accounts** (the user): Netflix-style picker, stored in the browser. **A claim, not a
  credential.** Forced three schema changes: `people`, per-person `event_seen`, and `user_scored_by`.
- **`evidence` → `artifacts`** (the user): a plan document is a *thing produced*, not proof. "Evidence" is a
  **role an artifact plays** when a guard points at it; naming the table for the role broke the moment a
  plan doc needed a home.
- **`runs` are bounded by `(assignment, model, effort)`** (the user) — a mid-session model change cuts a new
  run, or the score is attributed to a blend.
- **`selection_reason`** (`recommended`/`exploration`/`override`/`pinned`) so the UI can flag runs where
  a human score is worth most (the user). Without it, an exploration that went badly gets a passive accept
  and you conclude the cheap model was fine having never looked. `override` is the picker's own report
  card.
- **Naming**: `where` → `verify_at` → merged into `what_to_test` (a URL isn't the only way to verify —
  *"turn on the lights and check the TV comes on"*); `text` → `grant_text`; `drive` → `drive_mode`;
  `pause_attempts` → `resume_attempts`; `DELEGATE_MODE` → `SUBAGENT_DELEGATION` with values
  `never`/`allowed`/`required`; capabilities split into `NOTIFY_DOC` and `VISUAL_REVIEW_DOC` because a
  capability is a path *plus a moment in code*, so a generic map buys nothing.
- **`tool_calls` sizing**: ~37k rows/month, **under 0.5 GB/year**. Not a scale problem. The risks are
  outlier rows — cap `command` at ~4KB and store a count plus the first ~50 `paths`.

## 13b. Public repository, and what that costs the docs (2026-08-10)

The repo is **public from the first commit**. That was the owner's call, and it has a consequence the
docs have to carry: these plans were written from one person's real setup, so publishing them meant
taking that setup out of them first.

**What was removed, and what replaced it:** real names → roles (*the user*, *a second user*, and
`user-a`/`user-b` as example identifiers) · the owner's OS username → *the desktop user* · the name
of the orchestration system these plans replace → *the user's setup*, and *user-specific* wherever it
was contrasted against *generic* · other private projects and self-hosted services → what they are
(*the NAS*, *the chat channel*, *the media MCP*) · real area, repo and machine names → invented ones
(`web`, `infra`, `desktop`, `laptop`) · absolute paths and private dashboard URLs → removed outright.

**This is not tidying — leave it alone.** The generic phrasing is load-bearing, and re-personalising
it would republish exactly what was taken out. Verified by a scan that fails on any surviving
instance; the rules are in `CLAUDE.md` at the repo root.

**Two things worth recording honestly.** First, the names went in with the initial commit and came out
by rewriting it, so the published history is clean — but a force-push only makes the old commit
*unreachable*, not deleted, and it stays fetchable by its SHA until GitHub garbage-collects. Deleting
and recreating the repo is the only guaranteed purge. Second, the plans were never written with an
audience in mind; they read as a private design conversation, and no attempt has been made to make
them read otherwise.

**Backstops, not judgement alone:** secret scanning and push protection are on, so a recognised
credential is refused at push time. They catch credentials — not names, not paths, not private
project names. Those still depend on reading the diff.

## 13c. Two v0 blockers settled (2026-08-10)

### Finished tasks import as a collapsed summary, not full history

The 144 already-finished tasks are most of the volume and the least useful part of it. Importing
their full event streams mostly imports noise nobody will query — every claim, nudge and field-change
for work that is already done. Each keeps one summary row instead.

**Reversible on purpose:** the original task folders survive as read-only archive, so if the detail
turns out to be wanted, it can be backfilled later. That asymmetry is the whole argument — starting
collapsed and expanding is easy; starting bloated and pruning means deciding what to delete.

In-flight and blocked tasks import in full. The cut applies only to terminal states.

### Projects do not carry state — it is derived from their children

A stored project state is a second source of truth, and it goes stale the moment a child moves. It
would need a rule for every way the two can disagree — all children merged but the project says
executing, a child reopened under a finished project — and each of those rules is a bug waiting to
happen. Derived state cannot disagree with itself.

**What this costs:** a project can't be parked independently of its children. That is the right
trade, because parking a project while its children stay actionable is not a real state — the work
would carry on regardless. Park the children.

**Consequence for the state machine (#15):** transitions apply to tasks and subtasks. A project's
column is computed on read, so guards never run against a project's own state.

## 14. Still open

1. **Exact band numbers** beyond the starting values above.
2. **Whether Codex needs the blocking fallback in practice**, or whether the CLI covers it.
3. **CLI surface beyond `wait-for-crew`** — currently minimal by design.
4. **Front end** — v1 is a port of the existing board; Kanban, project and progress views are backlog, same repo.
5. **Retention defaults** for `tool_calls`.
