# Agent Standup — decision log, 2026-08-09

Everything settled in one long planning session with the user, with the reasoning. Written so nothing
depends on a conversation surviving.

**Companion docs:** `PLAN.md` (readable overview — accurate but stops before the heartbeat design) ·
`SCHEMA.md` (tables, config, endpoints).

---

## 0. Name

**Agent Standup.** Command `standup`. Packages published as `agent-standup`, repo `agent-standup`.
Bare `standup` is squatted on npm (dead v1.0.0 since 2022) and taken on PyPI; `agent-standup`,
`agentstandup` and `agents-standup` are free on npm, PyPI, and as GitHub orgs. The "Agent" prefix also
stops it reading as another async-standup Slack bot (Standuply/Geekbot/DailyBot).

---

## 1. What it is

One repo containing a backend, an MCP adapter, a CLI, and a web front end. One place the state
lives, one place the rules are checked, and every surface a thin adapter over that one place.

**The point:** a rule a client is asked to honour is a rule that drifts, because each client honours
it slightly differently and nothing notices. These rules live in the backend and are *enforced* —
the server refuses the change.

**The app is fully functional without the heartbeat.** Bands, hooks and gates all apply to a session
you start yourself. The heartbeat only adds "start something unattended."

---

## 2. Data model

### One recursive item type
Project / task / subtask are **depths, not three types** — an item has a nullable `parent_id`, nests
arbitrarily, no special handling. Rationale: an agent that discovers work inside work has to put it
somewhere. Without a parent pointer it mints a sibling task and manages the pair itself, which makes
any board overstate how much is independently in flight. A parent pointer fixes that at the root
rather than in the renderer.

### Eleven states, five derived columns
Columns are computed at read time, never stored, never transitioned. Adding `paused` forced five
columns rather than the four originally specified — it is neither in-progress nor blocked, and
folding it into either destroys the property that makes "Blocked" trustworthy.

### Any state to any state
No edge whitelist. Any move a tracker might forbid is either bookkeeping strictness — in which case
forbidding it only manufactures dead ends and teaches people to fake their way through the
intermediate state — or a real precondition, in which case it becomes a required field. Audited on
that test: the evidence gate, the visual gate, merge authority and claim-release are all real
preconditions and survive as required fields; a linear plan→review→approved chain and terminal
dead-ends are neither, and have no equivalent here.

### `blocked` is narrow
Means **an outside actor must act** — you, another person, an external process (a SMART check running), or a
date. Explicitly *not* budget waits. If an agent could unstick itself, it is in progress.

### `paused` (the user's call, corrects an earlier position of mine)
Nobody is on it; resumes on a condition the system re-checks itself. Covers budget wind-down **and**
a dead owner. I initially argued the task should never move and only the assignment should change;
that was too pure — if nobody is on it, it genuinely isn't in progress, and leaving it in `executing`
leaves you with the rotting-in-executing problem, where the busiest-looking column is the one nobody
can trust.

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

### Closing summaries
Required to reach any completed state. Typed fields with hard caps, `not_done` mandatory even when
empty, `user_facing` forcing a where/what-to-test or how-verified branch, `final_state` derived.
Static validators: caps reject rather than truncate; no near-verbatim copy of a history row; a
**jargon denylist** on human-facing fields; `how_verified` may not be only a CI reference.

Why required rather than encouraged: with no summary field to read, a "since you last looked" card
has nothing to render but the raw event log — internal command names, the same thing said twice, the
one load-bearing decision ranked last, and a closing line admitting it found nothing to report. A
renderer given no summary improvises, and what it improvises is unreadable. So the field has to
exist, and something has to refuse to complete without it.

### Fields, not plugins
Vocabulary specific to one operator — what they call an orchestrating agent, which browser session a
visual review ran in, which standing grant authorised a merge — belongs in **values held by generic
fields**, never in the field names themselves. An assignee has a role; an artifact records a browser
session; a merge cites an authorisation. The vocabulary is the operator's; the fields are generic,
and that is the whole reason no custom-field machinery is needed for v1.

### `area`, not `repos`
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
4. **`blocked_on` never holds a name.** It is `blocked_on_type` (person/external-process/time) plus a
   person reference — a name in core vocabulary is exactly the leak that stops a product being generic.

### No monthly archiving
Archiving by month is a workaround for rendering a board out of a directory tree that has grown too
large to read. In a database, filtering is a query.

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
"the same prompt might be read differently on a different day" is the problem this app exists to
kill — but it means the config surface must be good.

### MCP Tasks (SEP-2663) does not fit
Investigated properly against the spec. Four blockers: only the **server** creates a task (wrong
direction — we need the agent reporting on its own work); the client can only answer questions the
server asked, never append; terminal is permanently terminal (we need reopening); and tasks expire via
TTL while work items live for weeks. It also wouldn't save what was hoped — session cost is schema
residency and results landing in context, neither of which a handle changes.

**Where it does fit:** genuinely long server-side operations — a bulk import, a heavy report. Use it
there.

### No plugin system
One app, strict vocabulary boundary. Core may know items, parents, state, events, checkpoints, claims,
comments, agents, evidence. Core may **never** know an orchestration role's local name, a scheduler's
own vocabulary, budget points, a pace line, a browser-automation tool, or any AI vendor.

**The operator-specific parts are a separate program that talks to the API, exactly like the front end
does** — not add-ons inside the app. The heartbeat asks for state, applies whatever budget rules and
priorities that operator has, and says what to do. The core never knows it exists.

The pattern that emerged from the generic/operator-specific audit: **everything generic is storing and
checking; everything operator-specific is deciding what to do next and what it costs.**

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

**One script, wired to `PreToolUse`, `PostToolUse` and `Stop`**, branching on the event type from
stdin.

> **⚠️ Superseded in part by §16 and by row #125.** The pattern lists this section describes are
> deleted, and the fail-closed posture is reversed. What survives is everything below about *one
> script rather than a folder of them*, and the reasoning for keeping judgement server-side — which
> #125 extends rather than contradicts. §16 carries the current posture.

**The machine-wide-kill guard is server-side too** (the user's call, overriding my suggestion of a
local floor — two implementations of one safety rule can disagree, and an installation that skipped
the local half would silently have no floor at all). It is also the better place for it: the server
can do an **ownership check** — is that PID yours? — where a local rule could only pattern-match.
Requires agents to register processes they start.

**One script, not a folder of them.** A guard per rule means a client-side implementation per rule,
and the number of them only grows: a check with nothing left to guard, a check whose question a
table now answers directly, half a dozen nudges, a session handshake. Each is a file that can drift
from the others and from the server. **A rule enforced in one server-side place cannot drift the way
per-client scripts can** — so everything of that shape is either an ordinary query or a line in the
ask-list. The merge gate is the one partial exception: command *parsing* stays local, its *judgement*
is one query.

**And it deletes a bug class outright.** Two scripts that must agree on a shared constant need a
mechanism to keep them agreeing — a generated file, a build step, a convention — and that mechanism
is itself something that can fail quietly. One script has nothing to agree with.

### Why the kill guard exists
A machine-wide kill — `taskkill /F /IM node.exe` and its equivalents — takes out every sibling
agent's processes, not just the caller's, and the caller has no way to tell. The damage comes from
workers rather than from an orchestrator, so the guard applies to every session rather than only
supervised ones.

### Guards and manual sessions
Guards apply to **autonomous** sessions only; user-driven sessions are logging-only. **One exception**
— actions whose blast radius reaches past your own session (killing processes while agents run,
closing a shared browser). Those become **warnings that name the consequence**, never blocks.

---

## 5. The heartbeat

### Shape
Each machine runs a scheduled task that polls (`POST /poll`, default 300s) and launches whatever comes
back. ~30 lines, no decisions. The server-side planner is **pure code**.

**This is what makes frequent polling affordable, and it is the single biggest cost decision here.**
A scheduler that has to *reason* — an LLM session reading the board every tick — costs millions of
input-equivalents per tick, so its interval gets stretched to an hour or more just to stay cheap, and
then gets tuned against the prompt cache rather than against how quickly work should start. A tick
that finds nothing costs one HTTP request here, so the interval can be chosen for responsiveness.

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
A scheduled task registered against the desktop user with **LogonType: Interactive** and
**RunLevel: Limited** fires while the machine is locked, and does **not** fire when nobody is logged
on. That is the constraint to design around: a machine that stays logged in works, one that logs out
does not. Acceptable, because the machines this dispatches to stay logged in — an installation where
they don't loses unattended launch on those machines, which is survivable since the heartbeat is
optional by design.

**Status: the scheduling mechanism is well-founded by production precedent, not verified against
this repository.** What is genuinely open is whether a *headed* browser session survives a real
lock-and-display-sleep cycle on the target hardware — display sleep is a separate power event from
lock, and GPU-driver/swapchain recovery on wake is a documented rough edge, not a guarantee. A pure
console process sidesteps this entirely, which is why headless is the recommendation for anything
that must be reliable unattended. The full mechanism comparison, the "run whether logged on or not"
trap, and the test protocol that would settle the headed-browser question live in
`docs/spikes/unattended-windows-launch/` (row #55).

Auth deferred: reachable on a trusted network without a token for v0. Not designing around container
networking yet.

---

## 6. Orchestrator supervision — the missing feature

**Client-side hooks cannot supervise a crew, and this is why.** A `Stop` hook fires when a turn
*ends*; a `PostToolUse` hook fires when a tool *returns*. **Neither is a timer**, and neither can
fire at all while an orchestrator sits blocked inside a subagent call — which is precisely the
window supervision is wanted in. The gap between consecutive firings is therefore unbounded in
exactly the case where it needs to be short.

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

Band three is the valuable one: start nothing, get in-flight work to a *good stopping point* (not
necessarily finished), take shortcuts to a clean pause, write the handoff. Without it, a budget limit
is a wall hit mid-thought, and the work is stranded wherever it happened to be — which is what makes
resuming expensive, because the next session pays to rebuild context a clean pause would have written
down for free.

- **Stricter of the two windows wins.**
- **Autonomous only** — never blocks the user.
- **Boundaries move with time** (a pace line). Configured, not baked in — for example, weekly
  wind-down `15 × days − 5`; 5-hour `80` rising to ~`92` in the final hour.
- **No formula language.** Every boundary is a constant or `slope × elapsed + offset`, optionally
  switching on a time condition — an ordered list of *(when, value)* pairs. Declarative, testable, no
  parser.
- Wind-down reaches in-flight agents through the per-tool-call nudge, which costs nothing extra.

**Concurrency ceiling deferred**, but worth recording why it isn't a budget feature. A machine
freezing under many concurrent sessions is **not a budget event** — a dozen MCP servers times half a
dozen sessions is dozens of processes and several gigabytes of memory, with every session inside
budget the whole time. It is a resource problem and wants a resource fix, so putting
it in the budget bands would be solving it in the wrong place. If it comes up, a per-machine session
cap is config plus a count, no migration.

### Ghost tasks (the user's design)
Unminted user sessions still send tool calls, so a session ID the server has never seen and that holds
no claim **is** a ghost. Counted toward capacity with a deliberately high baseline (an unknown session
is unbounded; guessing low risks the freeze, guessing high costs a delayed dispatch). Staleness reuses
the same ladder. Later refinement: the ghost's own **tool-call rate** is a better estimator than a
constant, and it's free. Nudge the *agent* to mint, triggered on the first **write-shaped** action —
nudging on a read trains people to ignore nudges. Ghosts must never gate the user's own session.

---

## 8. Telemetry and scoring

**Cost logging is a byproduct, not a task.** Ask an orchestrator to self-report quality on a 1–10
scale and almost everything comes back a 9 or a 10 — a distribution that cannot discriminate, bought
at the price of somebody remembering to ask. Every tool call reporting its own cost is objective and
complete with nobody remembering anything.

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

Three values: pre-approved · needs-approval · agent-judgement. **The registry default is
`needs-approval`, and an installation may override it to `agent-judgement`** (§13e). This entry used
to read "agent-judgement, the default, configurable" while the configuration section recorded the
product default as `needs-approval` — the two readings could coexist only because there was nowhere
to record an installation's own answer separately from the one the product ships with, which is
exactly what a registry default plus a stored override adds. Note that `items.default_merge_authority`
is marked `sensitive`: overriding it removes the approval gate from **every item created afterwards**,
so it is confirmed by typing the key and audited as its own kind of event.

Under judgement the agent decides at the gate and **must record a one-line rationale** — otherwise "the
agent thought it was fine" is unauditable, and an agent that can't articulate why it's safe can't merge.

The user declined a forced never-auto-merge path list as scope creep; parked as a future request. The
residual risk is that per-task marking depends on remembering at mint time.

**No client-side validation gate.** Agent Standup is built without one: review is the gate, and a
second gate in front of it earns its place only if it catches something review doesn't. Adding one
later is a decision on its own merits rather than a default to inherit.

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

## 11. Import, and going live

**A one-time import from an external file-based store, then a single switch** — not a phased
dual-write. Everything comes across, finished items included, with states remapped per §2. Two calls
worth stating:

- **`parent_id` is null for every imported row.** A flat store has no hierarchy to recover, and
  inferring one from titles would produce a tree that looks authoritative and isn't.
- **Whether finished items arrive in full or collapsed** is settled in §13c.

**A compatibility shim exposes the same command-line surface against the API for a single release**,
and is then deleted. It exists so the switch doesn't have to happen everywhere simultaneously;
keeping it beyond that would make it a second surface to maintain and a second place for behaviour
to diverge.

**And the switch happens on a day when nothing is in flight.** Duplicate first, verify against the
duplicate, then switch — never a wholesale swap with items still `executing`. Switching over is
itself a piece of work, and a system in the middle of being switched cannot reliably track the item
that represents switching it. See §13h.

---

## 12. Facts the design rests on

Each of these was checked rather than assumed, and each one a decision above leans on.

| | |
|---|---|
| MCP statefulness | Statefulness is a property of how a server is built, not of what it does: common frameworks default to stateful and return an `Mcp-Session-Id` on initialize whether or not anything needs it. A server that holds no per-session state — no context object, no progress, no resources, no prompts — can be flipped stateless in one line. Which is why the MCP adapter can be specified stateless up front rather than discovering it later. |
| Tool-list cost | Every tool description is resident in the agent's context on every turn, used or not. A server exposing sixty-odd tools is therefore a permanent tax on every session that connects to it. |
| Cache TTL | A **1-hour** prompt-cache TTL **drops to 5 minutes under usage overage** — i.e. exactly when running hot — and nothing signals the transition. Hence `crew.wait_timeout_seconds = 240`, not 300. |
| Cache pricing | Write **1.25×** base (5-min TTL) or **2×** (1-hour); read **0.1×**. Marginal cost of a wait: do nothing 1.25N · 1-hour TTL 0.85N · pinging 0.025N/min. **The 1-hour TTL is cheaper than doing nothing, always.** |
| Unattended Windows launch | A scheduled task registered against the desktop user with **LogonType: Interactive** and **RunLevel: Limited** fires while the machine is locked and does **not** fire when nobody is logged on — well-founded by production precedent, **not independently verified against this repository**. Genuinely untested: whether a headed browser survives lock plus display sleep. See `docs/spikes/unattended-windows-launch/` for the mechanism table and the test protocol that would close that gap. |
| Prose ledgers | A ledger kept as prose is read whole or not at all — a hundred thousand characters is tens of thousands of tokens resident in every session that loads it, whether or not one line of it is relevant. The same content as rows is a query with a `WHERE` clause. |
| Codex | No background-completion re-invocation found. `notify` fires `agent-turn-complete` **outward**; cloud tasks are fire-and-forget. |
| Claude Code plugins | Bundle `hooks/hooks.json`, `.mcp.json`, `skills/`, `agents/`, `bin/`, `monitors/`, `settings.json` in one installable unit; marketplace can be a private repo. |

---

## 13. Where I was wrong, and where the user was

Recorded because the reasoning matters more than the conclusion.

**Mine, corrected:** framing HTTP as the substrate (it's the service layer; the front end's transport
doesn't decide the agent's) · designing a self-installing hook handshake before checking that plugins
already bundle hooks · arguing a reservation table was needed for the two-machine race · insisting the
task never moves when its owner dies · labelling session markers and batching as operator-specific when
only the *policy* was · suggesting a local kill-guard floor alongside a server rule · calling unattended
Windows launch a risk that could sink the design when the platform supports it directly · treating the
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

### The operator-specific leak sweep

Anywhere the schema named a person, it was wrong. Fixed in four places — `origin`, `blocked_on`,
`events.actor`, `artifacts.created_by` — all now type+id references to `people`. `authorizations` had
**no grantor at all**: prose gets away with an unattributed grant because a reader supplies the
missing context, and a queryable table can't. `items.id` mandates no particular format; an imported
identifier lives in `custom_fields.legacy_id`.

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

## 13b. Public repository, and the writing rules that keep it publishable (2026-08-10)

The repo is **public from the first commit**, deliberately. That has a consequence these docs have to
carry: they are design documents for a tool that runs against real infrastructure, and documents
written that way fill up with the specifics of one installation unless something stops them. The
rules below are that something. They are not style preferences — they are the reason this is safe to
publish, and the reason it reads as a product rather than as one person's configuration.

**How each category is written:** people by role (*the user*, *a second user*), with `user-a` /
`user-b` as example identifiers · an operating-system account as *the desktop user* · self-hosted
services and other projects by what they are (*the NAS*, *the chat channel*, *the media MCP*), never
by their own name · area, repo and machine names invented (`web`, `infra`, `desktop`, `laptop`) ·
*operator-specific* wherever a capability is contrasted against *generic* · absolute paths and
private dashboard URLs not written at all ·
<!-- external-ref-ok-next-line: this rule has to quote the phrasing it forbids in order to state it -->
**nothing described by what it succeeds** — no predecessor, no prior state, no setup the reader is
assumed to already run, because a reader of a public repository can verify none of it and it leaks
the shape of a private system for no benefit.

**This is not tidying — leave it alone.** The generic phrasing is load-bearing. Making it concrete
again, to be helpful or to make an example more vivid, republishes exactly what the phrasing exists
to keep out. Enforced rather than remembered: `npm run check:external-refs` fails the build on the
shapes these rules exclude, and the rules themselves are in `CLAUDE.md` at the repo root.

**Two things worth recording honestly.** First, a force-push only makes a commit *unreachable*, not
deleted — it stays fetchable by its SHA until GitHub garbage-collects, so rewriting history is a
mitigation and not a purge. Deleting and recreating the repository is the only guaranteed one.
Second, these are working design documents rather than a product manual: they read as one side of an
argument, and no attempt has been made to make them read otherwise.

**Backstops, not judgement alone:** secret scanning and push protection are on, so a recognised
credential is refused at push time. They catch credentials — not names, not paths, not private
project names. Those still depend on reading the diff.

## 13c. Two v0 blockers settled (2026-08-10)

### Finished items import as a collapsed summary, not full history

Finished work is most of the volume of any established backlog and the least useful part of it.
Importing full event streams for it mostly imports noise nobody will query — every claim, nudge and
field-change for work that is already done. Each finished item keeps one summary row instead.

**Reversible on purpose:** the import reads its source and never writes to it, so if the detail turns
out to be wanted it can be backfilled later. That asymmetry is the whole argument — starting
collapsed and expanding is easy; starting bloated and pruning means deciding what to delete.

In-flight and blocked items import in full. The cut applies only to terminal states.

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

## 13d. Partial unique indexes on `assignments` — deferred, not solved (2026-08-10)

`SCHEMA.md` §2 specifies two **partial unique indexes** on `assignments`: one live orchestrator per
item (`WHERE role = 'orchestrator' AND released_at IS NULL`), and one row per session per item
(`WHERE released_at IS NULL`). **Prisma's schema language cannot express partial indexes** — `@@unique`
has no `WHERE` clause — so neither constraint appears in `schema.prisma`, and consequently neither
appears in the baseline migration this PR adds either.

Hand-writing them straight into the migration SQL was considered and rejected: the drift check this
same PR introduces (`db:check-drift`, PR #7) diffs `schema.prisma` against replayed migration history,
and a constraint present in the SQL but absent from the schema would show up as permanent drift on
every run from day one — defeating the tool before it does any work.

**This is a known gap, not a solved problem, deferred to PR #23 (claims).** That PR must do one of:

- Add the two indexes as a **documented hand-written migration**, and teach the drift check to
  tolerate that one specific, named exception rather than ignoring drift generally.
- **Enforce the constraint in application code** instead — the atomic compare-and-set claim logic
  §2 already calls for.

**Application-level enforcement alone is not race-proof.** Two concurrent claims can both pass a
"no live orchestrator" check before either writes its row — that race is exactly why the index was
specified as a database constraint in the first place, not left to a check-then-write in the service
layer. If PR #23 goes the application-code route, it is accepting that residual race, not closing it,
and should say so rather than presenting a check as equivalent to a constraint.

## 13e. Configuration lives in the database (2026-08-11)

Most of what was environment configuration becomes a **setting**: a typed value in a `settings`
table, edited at `/settings` or with `standup config`, over a registry of defaults declared in code.

**The dividing line is not "does a human set it" — it is what must be known before the process can
reach the database.** Anything needed to connect and listen has to be an environment variable,
because it is read before there is anywhere else to read from. Everything read after that point is
read from a database that is by definition already reachable, so keeping it in the environment buys
nothing and costs validation, explanation, auditability and a redeploy per change.

That leaves three tiers: **bootstrap** (`DATABASE_URL`, `HOSTNAME`, `PORT`, plus `SHADOW_DATABASE_URL`
in development), **settings** (everything else), and **build constants**.

**A registry, not a key-value bag.** Every setting is declared in code with its key, schema, default,
label, help text, category and when a change takes effect; **the database stores overrides only**.
Three things follow: a fresh database boots fully working with no configuration at all, because the
defaults are code; the editing surfaces are *generated* from the registry, so explaining a field as
it is set is a property of the declaration rather than a document somebody maintains; and a value has
one type in one place, so a guard reading a setting gets a number.

**This is consistent with the decision that capabilities are named values rather than a generic map,
not a reversal of it.** That argument was for named-and-typed over an untyped map, and a registry is
named-and-typed. What changes is where the value is *stored*, never whether it is typed.

**`BUDGET_WINDOWS` is the case that proves it.** It is nested, per window, per band, and a boundary
may be a constant, or a slope against elapsed time, or an ordered list of switch points. As a string
in the environment that is an unvalidated blob with no editor and no explanation. As a typed value it
gets all three — including the check that matters most and that no format-in-a-string could ever
support: boundaries with different slopes cross somewhere, and the crossing point is where the system
would be told to wind down harder than it stops. The validator samples the window and rejects the
value naming the moment it happens.

**Two things that were configuration are not.** Which usage adapter reads an account is already
`accounts.vendor` — a global answer cannot describe two accounts, the same modelling error as putting
usage on machines. Which paths minting scans belongs on `machines`, because the values are filesystem
globs and machines have different filesystems. **Settings are otherwise global**; the one value that
needed a scope got a column on the table that already represents that scope, which is cheaper than a
resolution order at every read and a form that becomes a matrix.

**The hook protocol version is compiled in**, and it is four constants rather than one: per variant
(HTTP and command line, which evolve independently) and per role — the version this build speaks, and
the oldest it still accepts. Making it configurable only allows setting it to a version the build
does not implement. Two numbers rather than one because "you should update" and "I cannot talk
to you" are different statements, and collapsing them makes every fix a breaking change.

**The capability documents move, and their validation gets stronger rather than weaker.** They were
checked once, at startup, so a missing document failed immediately rather than stranding an item at a
gate days later. The intent to preserve is that a missing document surfaces *before* an item reaches
the gate — and the check now happens in four places instead of one: refused on write when the value
is provably wrong, marked unverified when the server cannot see that filesystem (it hands the path to
an agent and never reads it, so its own view is not authoritative), re-checked on the sweep that
already runs for liveness, and **named in the rejection at the gate**. The last is the real fix: the
failure to avoid was never that a check ran late, it was that the message did not say what to do.
**What this costs:** a misconfigured installation now starts. That is the right trade for a running
service — a service that refuses to start is down for everyone, including whoever is trying to fix
the configuration through the interface built for it.

**Caching is explicit and small.** A one-row revision counter is bumped in the same transaction as
every settings write, including a delete — a counter and not a maximum timestamp, because clearing an
override deletes a row and a delete can move a maximum backwards. Long-lived processes re-read the
counter every few seconds and rebuild the snapshot when it moves; short-lived ones build it once. So
the guarantee is stated rather than assumed: **immediate in the process that made the change, within
the revalidation interval everywhere else.** Each service call resolves one snapshot and threads it
through, so two guards in one transaction can never disagree.

**Every change writes an `events` row** — who, which key, from what, to what, with "was at the
default" distinguished from "was set to nothing", because null is a legal value and those are
different acts. No settings history table: the ledger is the history, and a second copy earns nothing.

**And it is never a secret store.** Every value is served to the front end and printed by the command
line; there is no redaction path and none will be added, because a value that cannot be displayed
cannot be edited in the surface the table exists to feed. Credentials stay in the bootstrap tier.
Enforced rather than remembered: the registry's own test fails the build on a credential-shaped key,
matched by shape rather than by any list of real values.

**Settings are global, with one exception shape used exactly twice.** A value varies per entity only
through an override column on that entity's own table — `accounts.budget_windows` over
`budget.windows`, because bands key off the account and a metered account has no window to have
boundaries in; and `machines.source_globs` over `minting.source_globs`, because filesystem globs are a
property of a machine. Two uses, both named, and a third needs an argument rather than a precedent.
This is deliberately not a scope axis on every setting, which would cost a resolution order at every
read and a form that becomes a matrix. **The override is validated by the same registry validator**, so
the typed editor and the cross-boundary check apply identically — it changes the place, never the type.

**And one class of value is not configuration at all.** Repositories, areas, machines, accounts and
people are owned by the *installation*, not the build: there is no default repository, and a fresh
database is not fully working with none of them. They are entities with their own surface
(`SCHEMA.md` §23), and keeping them out of the registry is what stops it becoming the generic map
this decision rejects twice.

**Who may change a setting is a question this creates and has to answer out loud.** Identity here is a
claim rather than a credential, and access control is deferred — a reasonable deferral, made
elsewhere. But five settings do not tune the system, they switch off its enforcement: the default
merge authority, the budget master switch, the notification document (which silences every escalation
path), the liveness thresholds, and retention. **Moving them into the database makes them easier to
change, which is the whole point and is also the risk**, and the previous arrangement — a variable on
the deployment host, changed by redeploy — was inadvertently a control. So the registry marks the
first four `sensitive`: rendered apart, confirmed by typing the key, audited distinctly. **Retention is
its own class, `irreversible`**, because it deletes measured history that cannot be recreated: the
wrong value there is not a state you can leave, it is an event that has already happened. It gets a
floor in its own schema and a refusal in the job that does the deleting, and *irreversible plus
unauthenticated* is the combination worth breaking first.

**Capability verification is recorded, not asserted.** *"Checked"* is a fact about the machine that
processed the write, which with a command-line adapter may be anyone's laptop — so the stored state is
who checked it, when, and what they found, and *unverified* and *verified elsewhere* stay different
answers. The periodic re-check is a hosted-tier loop; the local equivalent is `standup doctor`.

**When code and data disagree, the registry wins and says so.** An override that fails its schema
falls back to the default, loudly and visibly, rather than failing the boot or being silently
coerced. An override for a key the registry does not declare is inert and listed, not deleted —
deleting data on deploy loses the record of what someone configured. A rename is expressed by a
deprecated entry naming its replacement plus a one-shot copy, never inferred. And a changed default
is a behaviour change for every installation that never overrode it, which belongs in release notes.

## 13f. The command line is a first-class adapter (2026-08-11)

`standup` becomes a full adapter over the service layer, alongside the web API and MCP, rather than a
single-purpose binary. It exists so the app can be used where a server cannot be hosted — and it is
worth more as a forcing function than as a convenience.

**The reason it can work is not that the app is stateless.** Statelessness is a property of the HTTP
server and says nothing about whether a second way in enforces the same rules; a stateless server
with a rule written inside a route handler is exactly as bypassable as a stateful one. It works
because **all state is in Postgres and every rule lives in a callable service layer that every way in
is a thin adapter over.**

**Which names the failure mode exactly: the day a rule is implemented in a route handler instead of
the service layer, the command line silently stops enforcing it and nothing says so.** So this ships
with a conformance suite, and the suite is the load-bearing part.

**The suite is a standing property, not a comparison, and the properties have to be structural or
they are wishes.** Drivers sit behind one interface in a map typed from the **adapter registry** — the
module the application mounts its adapters through, so the names are load-bearing at runtime and
adding an adapter without adding its driver does not compile. Cases are written once per operation and
run against every driver, so a case costs nothing per adapter. Four assertions: same acceptance, or
the same rejection *code, rule identifier and offending fields*, from every driver — not message text,
which a terminal and an API should word differently; an accepting and a rejecting case per operation;
**every registered rule covered by an observed rejection**, computed from what the service returned
rather than from what a case claimed, since a case can name one rule while the service refuses on
another; and every exposed operation mapping to a registered service operation, with waivers bounded
by construction — **no operation any rule can reject may be waived by an adapter that exposes any
write.**

**That the error envelope names the rule that refused is not test scaffolding.** A category code
shared by several rules cannot say which one fired, so coverage could not be computed from it — and a
rejection that names the rule is a better rejection for an agent as well, because it is an identifier
to look up rather than a sentence to parse.

**And one structural rule, because comparing behaviour cannot catch an adapter that satisfies every
case and then adds a check of its own: only the service layer, the settings resolver, and migrations
and seeds may import the database client — an allowlist, not a list of forbidden directories.** A
denylist would leave out pages, layouts and server actions, which sit in the same bundle and also
mutate; an allowlist needs no maintenance as directories are added and covers code nobody has written
yet. **It ships before the adapters it constrains**, because it needs nothing to exist first and
because every adapter written before it arrives was unconstrained. A negative control accompanies each
assertion, plus a direct check that the rule registry is not empty — an assertion evaluated over an
empty set passes forever, silently.

The payoff is that the central claim becomes provable rather than intended: if a command line running
against the same database cannot bypass a single rule, the rules genuinely are in the core.

**Two transports, one set of commands.** With a server reachable, the command line calls the API —
which keeps the database credential off every machine running an agent, and keeps the long-poll.
Without one, it runs the service layer in-process. The commands themselves have one implementation
and take a binding; only the two bindings could diverge, and the suite pins them.

**Registration transport decides which hook a session gets.** Registering over the command line
proves the command line is installed and the database is reachable; registering over MCP or HTTP
proves a server is reachable. That is evidence, not preference, so the handshake reply is driven off
it — the command-line hook or the HTTP hook, each with its own version to compare. With both
available the registration transport wins, with an explicit override recorded as an override.
Registration earns a `sessions` table: it is mutable, one row per session, read on the hook path, and
a session registers before it holds anything. No foreign key to it from anywhere — a session that
never registered still produces tool calls, which is what makes it a ghost.

**In a no-server installation one class of version skew disappears.** There the command line *is* the
app — hook, rules and migrations are one installed package — so the hook cannot be a different version
from the rules it enforces, and the only remaining question is whether that package is current with
the database's migration state. **This collapse does not generalise:** a hosted installation whose
hook shells out to the command line has a package and an image versioned independently, and still
needs the comparison.

**A stale hook is advisory; an incompatible or absent one may not claim — where
`hook.require_registration_to_claim` is on.** Refusing everything on a version bump would make every
fix a breaking change, and the minimum-supported version is the escape valve for anything that
genuinely must be enforced. Refusing the *claim* is the honest maximum: a hook can always be not
installed, so what is enforceable server-side is that **no unguarded session holds work.** Such a
session can still read, orient and update itself; it cannot take ownership of an item under rules it
is unable to enforce. That is a rule that is enforced rather than one that asks — but only once an
installation has opted into it. The setting defaults to off, because enforcing it unconditionally left
an honest caller with no route to compliance: claiming required a registered version, registering one
truthfully required running the hook, and a session with no hook had no way to obtain one — so the
only way through the gate was to assert a version it never ran, which is the exact false claim this
check exists to catch. Off, the rule doesn't fire and nothing is lost that wasn't already lost; on, it
is the enforced rule described above, for an installation that has finished rolling the hook out.

**Wait-for-crew is one command whose implementation follows the binding, never the caller** — a caller
that must know its own transport is exactly what goes stale when an installation changes shape. Over
HTTP it calls the endpoint that holds the request open; running against the database directly it polls
the ledger. **Both bound themselves to the transaction-visibility horizon**, and that, rather than a
cursor alone, is what makes them return the same events: a sequence identifier is allocated before
commit, so ordering by it alone can step permanently over an event that commits late — worst under
exactly the concurrent-writer load that makes a wait worth having. Timeout and poll interval are both
settings, and the interval affects latency only, never which events come back. The cursor is required
rather than defaulted, and every entry point hands one back, because an unspecified first call either
misses everything before it or returns the whole ledger and those are opposite behaviours.

**What a no-server installation does not have, stated rather than discovered:** the board and the
rest of the front end, because those are pages served by a server — an acceptable trade. Everything
else is substituted rather than lost: MCP moves to stdio, which is the standard local transport
anyway; the long-poll becomes polling with identical semantics; and `/settings` becomes
`standup config`, reading its labels, help and validation from the same registry the page renders
from — which is why the configuration decision and this one belong together.

**The heartbeat is deferred with intent.** The command line acting as a poller — asking for work and
launching it on this machine — is worth having and is not first-release work. Named here so it is not
rediscovered as a new idea, and nothing forecloses it: the poll is an ordinary operation, so it
becomes another driver in the suite when it arrives.

**Two costs stated honestly.** Process start-up is the real tax and it is the reason to run the
server when you can — a hook that fires after every tool call cannot pay a process each time, which
is why the cached pattern list matters (only matches consult the rules) and why telemetry spools
locally and flushes in batches rather than opening a connection per call. And **"no dedicated server"
does not mean "no dependencies"** — a Postgres is still required. `standup init` makes that an install
step rather than a footnote: find or provision a database, migrate, seed, write local configuration,
then prove it with a real round trip. Every other command preflights and stops with *"run
`standup init` first"*, because a half-configured installation that behaves like a working one is the
worst outcome available.

**Removing the database dependency was evaluated and rejected for now.** SQLite is not one schema
with a different driver but a second data model — enums become free text, giving up the property they
were chosen for; money becomes a float; time-zone-aware timestamps are lost — and the no-server tier
is precisely the multi-writer case that suits it worst, while a file can never be the cross-machine
coordinator that half the design is about. An in-process WASM build of Postgres removes the
second-data-model objection completely and fails on a different axis: single-connection, in a tier
that is multi-process by definition. Genuinely useful for tests. **A downloaded platform binary is
the candidate worth keeping open** — real Postgres, no container — at the cost of a first-run
download, a platform matrix, and the command line taking on process supervision, which is the
underestimated part. First release: an existing connection string, a detected local Postgres, or one
provisioned through a container runtime.

**Distribution.** The package publishes the binary on the same version tag that publishes the image,
so both artefacts of a version are cut together. The packaged plugin form does not vendor a copy — it
declares the package as a prerequisite and shims to it — because a second copy is a version that can
drift, and each piece has to stay usable on its own.

## 13g. Values that must be exact are a data problem, not a type problem (2026-08-11)

`items.repo` and `items.area` were free text. `repo` is what the merge gate uses to decide which
repository a change lands in — and the reason `repo` exists separately from `area` at all is that the
gate needs **exact repository identity, which a loose category cannot give.** Free text is a loose
category, so a stated requirement had no mechanism behind it. Both fields are also filtered on and
both are in the notification-rule field whitelist, so three spellings of one name mean a filter that
splits, a count that undercounts, and a rule that silently never fires — which is a person not being
told.

**The enum-versus-text test does not cover this case, because repositories are both things at once.**
Make it an enum when you want the same value every time; keep it text when you cannot enumerate the
values in advance. A repository name is unenumerable *and* must be canonical, so it falls through the
gap between two rules that are each individually right.

**An enum is disqualified rather than awkward.** Postgres cannot remove an enum value, so a typo is
permanent; and an enum of one installation's repository names inside a generic product is precisely
the vocabulary leak this schema removed from origin, blocked-on and actor references. **A seeded
reference table with a foreign key is the one shape that gets both properties that were in tension:**
nothing has to be enumerated in advance, and the same value is stored every time. Adding a repository
becomes an insert — a data operation at runtime, not a migration and a deploy — and the per-repository
facts the system already wants (default branch, the host that turns a commit into a link, whether
visual review applies) finally have somewhere to live.

**Two tables, not one taxonomy table, and with different create postures.** A polymorphic table would
cost a discriminator on every join and give up exactly the per-repository columns that are the reason
to build it. `repos` is **created deliberately**, because a wrong repository aims the merge gate at
the wrong repository and creating one is rare. `areas` is **created on first use with normalisation**,
because it is required on every item and blocking that is friction on the most common operation there
is. The limit is stated rather than hidden: normalisation kills case and separator variants, not
synonyms, and the answer to synonyms is the one already used elsewhere — surface near-duplicates for
merging, and promote what recurs.

**It lands before the importer**, because an import set contains aliases of one repository, the
identifiers it carries are preserved verbatim by design, and importing them as free text bakes the
fragmentation in permanently on day one. Retrofitting means a second data migration over rows just
imported, and the alias mapping has to be decided either way. It is not on the binding chain, so it
costs nothing to do first.

**And it exposes a class the design had no home for.** Repositories, areas, machines, accounts and
people are all owned by the **installation**, not by the build — there is no default repository, and a
fresh database is not fully working with none of them. Configuration is the opposite on every axis:
declared in code, defaulted, stored as overrides only. So they cannot live on the settings page, which
by construction renders only what the registry declares. They get **their own surface** — `/admin`,
one page per entity kind, with the same operations on the command line so an installation with no
server is not locked out of the one class of data it cannot start without. Every value that is not a
setting lands there, including the two per-entity overrides of settings that are.

## 13h. Four things that were asked for, and what became of each (2026-08-11)

A coverage pass over the material this plan was built from turned up four instructions that no
decision here records. Three did not happen; the fourth was agreed and never written down. All four
are recorded now, plainly, because **an instruction that quietly went missing is worse than one that
was argued down** — the argued-down one leaves a reason behind, and this log is the only place a
reason survives.

### The build-or-buy survey lapsed. It was not skipped on purpose

The first thing asked for was a survey of what already exists, with a stated priority order: **use a
product that already does this, before building one, before adapting something adjacent.** What
exists instead is a light pass that describes itself as not the full research pass, and the build is
now three milestones in.

**Verdict: it lapsed.** Recording it as a deliberate skip would be the more comfortable sentence and
it would not be true — no candidate was named, compared or rejected on the record, so there is
nothing to point at as the reason it was right. *"We looked and there was nothing"* when nobody
looked is exactly the class of claim this log exists to make impossible.

**What follows.** Re-running it now as a build-or-buy gate would be theatre: the schema is baselined
and the rules are specified, and that is not work a decision can recover. But the question the survey
was for has not gone away, and it narrows to one that is still cheap to answer — **is there a product
that already enforces workflow rules server-side against agent sessions, with a client-side hook that
can refuse a tool call?** That is the unusual requirement; general task trackers do not have it. If
something does it, the right response is to stop rather than to finish. **The narrowed question is
owed before M8**, which is where the scope grows a scheduler, a budget model and a model picker —
asking it there costs five more milestones than asking it now.

### The prior-art data model was never read either

The instruction was two-part and specific: **read an existing product's data model before its code,
and do not fork it.** The don't-fork half is satisfied — nothing here is a fork — but it is satisfied
**by default**, because forking was never on the table. That is not the same as the instruction being
followed, and the half carrying the value is the half that was skipped: a data model that has
survived contact with real use is cheap evidence about which fields turn out to be needed, and it is
evidence that is only worth having *before* the first migration.

**Verdict: not done.** One thing about the timing decides what a late read is worth: the schema is a
baseline, and every change to it is additive. So prior art read from here can still argue for a
column; it cannot argue for a shape. That is the cost of the omission — bounded, and not zero.

### The differential test does not apply, and that is a decision rather than an omission

The intent behind it was sound: **a specification written as observed behaviour is worth more than one
written as prose**, because it cannot drift from what it describes — so run the same inputs through
two implementations, demand identical outcomes, and the specification tests itself. Nothing here
schedules such a test.

**Verdict: it does not apply, and that is deliberate.** A differential test is only meaningful when
the two sides are meant to agree, and the two here are meant to disagree: the transition rule is
**all-to-all transitions with required-field guards, chosen over a fixed table of legal moves** — a
different design, deliberately, and the one this repository builds. A differential suite between two
designs that were chosen to differ fails on precisely the cases the choice exists for, and passes
only where nothing differs, which is where it has nothing to say.

**But the protection it was buying is real and has to be bought some other way**, because the reason
it mattered was never the comparison — it was that edge cases are learned expensively and lost
silently. Three things carry that instead, and naming them is the point of recording this at all:

1. **Every guard ships with its rejections tested**, which is already a tenet of this repository and
   is the direct substitute: a rule that refuses the right things is what a differential test was
   checking for indirectly.
2. **Import verification (#13)** is the differential test that *does* still make sense — the same
   inputs, and the resulting item states compared row by row. It is a comparison of data, which is
   the part that was never meant to change.
3. **Anything known to be wanted is written down as a guard test, not assumed to survive.** A rule
   that lives only in somebody's head is a rule that has already been lost; the moment a design is
   chosen over an alternative is exactly the moment to write down what the choice must not cost.

No new row: this converts into an obligation on #15–#19, which exist.

### Going live happens on a day when nothing is in flight

The switch to this system as the source of truth has a precondition that was agreed and then written
down nowhere: **duplicate first, verify against the duplicate, and make the switch when no work is
executing.** Never a wholesale swap with items in flight.

The risk it answers is not hypothetical. Switching over is itself a piece of work, and a system in
the middle of being switched cannot reliably track the item that represents switching it — an item
left `executing` across the boundary has two homes, and one of them is about to stop being read. It
costs a sentence, and it belongs in two places rather than one: **§11**, which decides the shape of
the import, and **#40**, the row that performs it. Both now carry it.

## 16. The hook fails OPEN (2026-08-15)

**Every way of not getting a confident answer allows the tool call.** An unreachable server, a
non-success response, a body that cannot be parsed, a decision value this build does not recognise,
a payload shape it has never seen, and an unexpected exception on the way out — all six allow.

This **reverses** the posture stated in §4, and it is written as its own entry rather than edited
into that one because a reversal that leaves no trace is a decision nobody can audit. §4's reasoning
was sound *for the system it described*.

### Why the trade flipped

Fail-closed buys something only when the guard has something to enforce. §4's hook classified every
command against two cached pattern lists and refused anything it could not resolve; there, denying
on no answer refused a bounded set of *guarded* commands during an outage, which is plainly better
than permitting them unwatched.

**Milestone row #125 deletes those lists**, because matching command strings cannot express any rule
anyone actually wants: every real one is conditional — *never merge **without an approval***, *never
stage the whole tree **on a shared checkout*** — and the condition lives in server state that a
local matcher will never see. With the lists gone the hook enforces nothing locally, so fail-closed
has one side left and it is all cost:

- An installation that wires the hook and then has a server hiccup loses **every tool call in every
  session on that machine** — including the `Edit` that would unwire the hook, which is the failure
  mode with no way out from inside.
- What it protects in exchange is **nothing**: the calls it refuses are calls the server would have
  allowed, because there is no rule to allow them past.

A guard that cannot refuse anything, but can refuse everything when it breaks, is strictly worse
than no guard.

### What this is not

It is **not** a permissive default that a misconfiguration could widen, and there is deliberately no
setting that turns fail-open off. Both would be misreadings: there is no configuration here to get
wrong, because the client holds no rules to be configured. The refusals that remain are the ones the
*server* states explicitly — a `block` on a `PreToolUse`, and session enforcement — and neither is
reachable by accident.

Failures are still **named**, not swallowed. Each allow carries a `source` distinguishing "the
server answered" from "the server could not be reached" from "the payload was unreadable", and the
reason reaches the channel a person reads. An outage that leaves no trace is one nobody finds.

### ⚠️ This must be revisited when blocking returns

**Interventions (row #128) is where gating comes back**, and at that point a `pre` decision genuinely
gates something again — the argument above stops holding for that phase, because there will be rules
to fail open past. The question that row has to answer, deliberately left open here rather than
guessed at: **when a `block-overridable` or `hard-block` intervention exists and the server cannot be
reached, does the `pre` call allow or refuse?** Both are defensible and the answer probably differs
per level.

Two things do **not** need revisiting, whatever #128 decides:

- **`post` and `Stop` always allow.** The call has already run; a refusal there refuses something
  that already took effect. This is enforced independently in the hook script and in the service
  operation, so breaking it requires both to be wrong at once.
- **An unreadable payload allows.** That is a client failure, and refusing every call because the
  agent tool changed its payload shape is the same all-cost trade in a different disguise.

## 17. A follow-up is a sibling, not a child (2026-08-15)

**The rule:** an item becomes a **subtask** only if the parent genuinely cannot close until it is
done. Everything else discovered by finished work — including every follow-up a review raises — is a
**sibling** under the same project.

The owner's phrasing, which is the specification: *"the task should only be added as a subtask if it
is considered a blocker for the parent — the parent cannot and should not be closed until the subtask
is done. Otherwise, even if it is a follow-up, it should be added as a sibling, not a subtask. That
way, since it is a fairly separate task, it is not really considered a blocker to the first task; you
can drive the first task all the way to completion and then still have a follow-up task committed, so
that we do not accidentally drop the follow-ups."*

**This is not a guard change, and that is the point.** Two orchestrator sessions reached for
`parentId` on the same day, independently, and one of them deadlocked five merged PRs with it:
`hierarchy.no_finish_with_actionable_child` says the parent cannot finish while the child is open,
and `merge.requires_linked_followup` says the review's linked follow-up must *be* open. One item
cannot satisfy both. It read as two guards in irreconcilable conflict and it was nothing of the kind
— both guards were enforcing something true, and the deadlock was entirely a consequence of the
parenting choice. Made siblings, both stay satisfied permanently, with no reopening and no ordering
games.

**Why the sibling is the honest shape, not merely the working one.** Parenting a follow-up under the
merged task asserts a containment that is false: the PR is genuinely complete without it. There is a
second, independent reason — as children, follow-ups are invisible in a top-level board view and sit
permanently open under a permanently open parent, whereas as siblings they are real queue items that
can be prioritised, scheduled and closed on their own. **`followUpItemId` is a link, not a
hierarchy**, and conflating the two is what produced the deadlock.

**What this decision does not settle, and deliberately leaves open.** A sibling records that the
follow-up exists; it does not record **where it came from**. The two items sit under one project with
nothing saying one produced the other, so the provenance is as absent as it would be in a brand-new
unrelated item — and six weeks later the row exists and nobody can say why. The proposal on the table
is a **`references` relation**: many-to-many, no state derivation, no effect on the parent's
completion, so a follow-up can point at its origin without inheriting its lifecycle. **Sibling is the
fix; a reference is the missing half**, and anything built there should make the sibling arrangement
what it looks like when it works.

**It also gives I5 somewhere to point.** That entry — a reviewer returned `lgtm_with_followups`, a
merge was requested, and no item was ever minted — is catalogued as the most expensive situation in
`INTERVENTIONS.md`, because the work was already understood and then dropped. Without this rule the
honest instruction it could offer was *"mint an item, but not as a child, and accept that its origin
is now only in a note"*. Now it can say *sibling under the same project* and mean it. Whether
`lgtm_with_followups` should mint them **automatically** from the review artifact is worth deciding
alongside the reference relation: the verdict already names them, and a human or an orchestrator
re-typing them into new items is precisely the step where they get lost.

**The measurement that made this worth settling rather than leaving to judgement:** nine PRs merged
in one day produced roughly fifteen follow-ups, which went into one orchestrator's context and then
into GitHub issues via a sweep crew dispatched specifically to stop them evaporating. That worked
because someone remembered to dispatch it — and the whole argument for this system over a markdown
file is that it does not depend on someone remembering.

From `feedback/2026-08-15-followups-need-a-reference-not-a-parent.md`,
`feedback/2026-08-15-complete-item-follow-up-guard-has-no-satisfiable-path.md` and
`feedback/interventions.md`.

## 18. A title is advised, never refused — and stored titles are left alone

Titles are written for a person scanning a board, so the detail that belongs to the mechanism — an
identifier, a file path, an issue number — belongs in `body`. That is a convention about authorship,
and settling how strictly to hold callers to it turned on one question: **is there a predicate that
is right about every string?**

There is not. "Reads well to a person" is a judgement, and every signal that correlates with a bad
title has honest counter-examples. `Inbox` is a one-word title the system creates for itself. A title
naming a real product surface can legitimately contain the characters an identifier does. So the
check reports **findings**, the create attaches them to a response that **succeeded**, and nothing is
refused. The asymmetry decides it: a wrong refusal costs a caller a mint it cannot complete except by
writing a worse title, while a wrong nudge costs a sentence nobody must act on. Where a rule is a
matter of judgement rather than validity, the cheap error is the one to prefer.

The signals are matched as **shapes**, never as a list of real values — the same posture, for the
same reason, as the enumerated prefixes in `summaries/validate.ts`, which replaced a blanket regex
that fired on legitimate technical prose. A widened pattern is worse than no pattern: it trains
callers to ignore the advice, and then the honest findings go unread too.

**Where the convention is stated.** Beside the check that applies it, and served from there — the
rule is one exported string, carried into every create's `contract.rules`. Two channels then reach a
caller without either of them being written twice: `describe_tool` serves it on demand, and every
`invalid_input` refusal already appends a `describe_tool` pointer, so a caller refused on any other
field can read the title rule in the same breath. Putting it in each tool's `summary` was rejected on
the cost `describe_tool` exists to avoid — a description is charged to every session on every turn,
whether or not it is ever read.

**The stored titles are left as they are, deliberately.** Titles are live data: they are what every
existing link, notification and person's memory refers to, and a bulk rewrite of imported titles
would be a large, hard-to-review change to the one field whose value is that it is recognisable.
Nothing is lost by leaving them — `headline` (#107) already carries a readable one-line BLUF beside
the title on every read, so an item with a work-order title is legible without that title changing,
and a title can be corrected one at a time through `update_item` by whoever is already looking at it.
The convention therefore applies where it is cheap and reversible — at authorship, on new work —
rather than as a migration whose blast radius exceeds the problem it solves.

## 14. Still open

1. **Exact band numbers** beyond the starting values above.
2. **Whether Codex needs the blocking fallback in practice**, or whether the command line covers it.
3. **Front end** — v1 is a single board view; Kanban, project and progress views are backlog, same repo.
4. **Retention defaults** for `tool_calls`.
5. **Whether a downloaded Postgres binary or an in-process build should replace the container-runtime
   path** for installations with no database of their own. Decided by one measurement, stated in
   §13f: does a single-backend Postgres sustain the write rate of a no-server installation?
6. **Whether near-duplicate areas should be merged automatically above a similarity threshold**, or
   only ever surfaced for a person to merge — see §13g.

*The command-line surface beyond wait-for-crew was on this list and is answered by §13f: it is a full
adapter over the service layer, and its shape is specified in `SCHEMA.md` §20.*
