# Interventions — what Agent Standup notices, and what it does about it

The **engine** is milestone row **#128**: the registry, the response levels, the digest, the settings
surface. **This file is the catalogue** — the situations worth detecting.

They are separated deliberately. The engine is one bounded piece of work that gets built once. The
catalogue only grows: every time someone works in this system and something goes wrong in a way a
server could have spotted, that is a new entry. Filing each one as a milestone row would swamp the
queue with things that are not really PRs, and reading `MILESTONES.md` would stop telling you what to
build next. **New findings are appended here, not minted as milestone rows.**

---

## What an intervention is

A **detectable situation** plus a **response**. Both halves are required: a situation nobody can
detect from server state is not an intervention (it is a wish), and a detection with no response is
just logging.

The registry is seeded and code-backed — you cannot invent one from the UI, because detection is
code. What the UI *can* do is switch an entry off, change its level, change its timing, and rewrite
its message.

### Phase — `pre` or `post`

Every entry declares which side of the tool call it runs on, and **the phase decides which responses
are even available to it.**

| Phase | Runs | Responses it may use |
|---|---|---|
| **`pre`** | Before the tool call | nothing · nudge · block, overridable · hard block |
| **`post`** | After the tool call has run | nothing · nudge |

**A `post` entry cannot block, and this is a fact rather than a policy.** By the time it runs the
call has already happened, so a refusal there would be refusing something that already took effect —
it can only tell you about it. Anything that must *stop* an action has to be `pre`.

That cuts both ways: plenty of situations are only *detectable* after the fact, and those are
honestly `post` — they get a nudge and that is the whole of what they can do. The phase is stored on
the entry and surfaced in the front end, so what an entry is capable of is visible beside it rather
than being something a reader has to infer from the response level.

### Audience — who is told

Every entry names **who the finding is addressed to**, because a message delivered to the wrong
reader is another way of being ignored.

| Audience | Who that is |
|---|---|
| **`orchestrator`** | Whoever is running the queue. Flow findings are almost all this: the orchestrator is the only party who can spawn a reviewer, start the next step, or mint the follow-ups nobody minted. |
| **`agent`** | The session whose call triggered the check. Hygiene and correctness findings are this: the actor is the only party who can tidy up after itself or not run the command. |

The split is not cosmetic. Telling a builder that an unblocked row is sitting idle asks it to do
something outside its remit; telling an orchestrator that a worktree it never created was left behind
is noise it can only forward. Where a finding genuinely concerns both, name both — but the default is
one, and picking the narrower one is usually right.

### The response levels


| Level | What it does |
|---|---|
| **nothing** | Detected and recorded, says nothing. Useful for a new entry you want to observe before it starts talking. |
| **nudge** | A message. Prominence belongs to the *message*, not to the level — every entry stores a plain and a prominent version, and the front end picks. |
| **block, overridable** | Refuses the call; the agent may proceed by writing a `reason`, which is recorded. **The value is the recorded reason, not the friction** — an agent asked to justify itself will always produce a justification. |
| **hard block** | Refuses, no override. |

### Timing

Every entry declares whether it fires **immediately** or **rides the next digest** (~5 minutes).
Blocks have no choice and always fire immediately. **Most nudges should default to the digest** — a
batch arriving at a natural juncture gets acted on, while a trickle of small nudges gets skipped,
which is the failure this design exists to avoid.

### Writing a good entry

- **State the situation in terms the server can actually evaluate** — item state, claim state,
  artifacts, event history, elapsed time, budget. If it needs something the server cannot see, say so
  and stop; that is a finding about the schema, not an intervention.
- **The message should say what to do next, not what went wrong.** *"Nothing has picked up #123 since
  its builder finished — spawn a reviewer"* beats *"item #123 is stale"*.
- **Prefer the weakest level that works.** Blocking is for things that are wrong; nudging is for
  things that are merely forgotten, and most of this list is the second kind.

---

## The catalogue

Status: blank = not built · `built` = live in the registry.

### Flow — work that has stopped moving

| # | Situation | Phase | Audience | Default level | Timing | Status |
|---|---|---|---|---|---|---|
| **I1** | **Coding is finished and no reviewer exists.** An item whose builder reported done, with no reviewer assignment and no review request. Was milestone row #114 | `post` | `orchestrator` | nudge | digest | |
| **I2** | **An available row nobody is building.** The dependency graph says a row is unblocked and no crew holds it. The rule it encodes is stated in `../orchestration.md`: an unblocked row should never sit idle, because a row the graph says is available with nothing building it is a failure of orchestration rather than a neutral state. | `post` | `orchestrator` | nudge | digest | |
| **I3** | **A claim held by a session that has gone quiet** while its holder is demonstrably working elsewhere. Distinct from the liveness sweep (#99/#130), which reclaims *dead* sessions — this is about a live session sitting on work it is not doing | `post` | `orchestrator` | nudge | digest | |
| **I4** | **A subagent reported complete and the orchestrator has not started the next step.** The handoff that silently does not happen | `post` | `orchestrator` | nudge | digest | |
| **I5** | **A reviewer returned `lgtm_with_followups`, a merge was requested, and no item was ever minted for the follow-ups.** The follow-ups are agreed, recorded, and then quietly dropped — the most expensive entry on this list, because the work was already understood | `post` | `orchestrator` | nudge (prominent) | immediate | |
| **I13** | **A crew was dispatched against work that was never minted.** A claim, a branch or a commit artifact appears for a session holding no item, or a `record_artifact` names an item whose title is a near-match for the one the caller meant rather than the one it hit. From the owner's own account of a five-crew night (`interventions.md`): *"PR2+3 was never minted as a task. I dispatched that crew — the most valuable PR of the five — without a task existing. Nobody caught it because the follow-up task had a similar name."* The same session then recorded a commit artifact against the wrong item, and there is no delete operation to take it back. **Both are one root cause, and it is the one this whole product exists to remove:** five parallel crews were being tracked in a person's head rather than against the board, so the board drifted from reality without anything failing loudly. **The rule to encode is *mint before you dispatch*, not after** — a dispatch is the moment the item becomes the only thing that knows the work exists. Detectable from claim and artifact writes against a session with no held item, which the server already records. From `feedback/interventions.md` | `post` | `orchestrator` | nudge (prominent) | immediate | |
| **I14** | **An orchestrator is doing the work itself.** Reads and edits to repository files accumulating on a session that holds an item as `orchestrator`, rather than a spawn. Detectable from the tool-call stream #50 already ingests: a cumulative count of edits and repository reads over the last several calls, which distinguishes a burst of hands-on work from the reads an orchestrator legitimately does to brief a crew. **Deliberately a nudge and deliberately cumulative**, because the single-call version of this check is wrong in both directions — one edit is often the right call, and research reads before a dispatch are the job. What is worth catching is the drift, where an orchestrator has quietly become the builder and the crew it should have spawned never gets spawned. Requested by the owner as *"you are doing work you should probably be delegating to a subagent"*. **Overlaps `fm-always-delegate-nudge` in the installation this came from and supersedes it** — that hook matches on write-shaped commands outside a path allowlist, which is the pattern-matching approach #125 retired. From `feedback/interventions.md` | `post` | `orchestrator` | nudge | digest | |

### Hygiene — the tidy-up nobody remembers

| # | Situation | Phase | Audience | Default level | Timing | Status |
|---|---|---|---|---|---|---|
| **I6** | **A merged item whose worktree still exists, branch is undeleted, or Playwright slot is unreleased.** Was milestone row #112. Original framing: *"a reminder after merging a task for the agent or subagent to close their worktree, delete their local branch, release playwright (only if it used any) and just general cleanup"*. **This one has history and it is the argument for the whole file:** it has been written down as a standing instruction three times and mechanised zero times, and the leftover worktrees are measurable on disk. An instruction that survives three restatements without being followed is not waiting for a fourth restatement | `post` | `agent` | nudge | digest | |
| **I15** | **Another live crew already holds this checkout on this machine.** A claim, or a write into a worktree, where a different root session holds a running assignment on the same `(machine, repo)`. **The server already has every field this needs** — `assignments` carries `machine`, `branch`, `worktree`, `sessionId`, `rootSessionId`, `liveness` and `releasedAt` — so the predicate is a single query and the message can *name the holder*, the item, the branch and how long ago it was last active, rather than only refusing. **Key it on `(machine, repo)`, never on `worktree`**: that column is an unnormalised free-text path, so `/path/to/repo`, `/path/to/repo/` and `~/repo` do not collide and a predicate over it passes silently when it should fire — exactly the *silently wrong in both directions* failure I12 retreated from. **And on `rootSessionId`, not `sessionId`**, for the reason `registered_processes` already makes the same distinction: a worker an orchestrator spawned is the same crew and must not block itself. This also gives that table's careful root-session attribution its first consumer. From `feedback/other system.md` (F19, F2, F5) | `pre` | `agent` | block, overridable | immediate | |
| **I16** | **A free-form content search rooted at a directory large enough that it will not return.** Reaching for a recursive search where listing the directory first would have answered the question — and on a tree of this size the search is slow enough to burn the turn it was meant to save. The owner's framing: *"steer against using search instead of `ls` and trying to see if it can make sense of the folder structure; on large folders search can be really slow."* **The detection is the interesting part and it constrains the level.** The server cannot see the caller's filesystem, so the hook has to carry the scope with the call — a directory and a cheap size signal — and the server decides whether that scope is too broad. That is a real cost on a `pre` check, which is why the entry is **block-overridable rather than a hard block**: a search scoped to one file or a leaf directory is fine and the caller is usually right about which it has. **Gated on #128's context declaration** — an intervention states the context it needs and the server assembles it, so this is the first entry whose declared context includes something only the client can supply, and it should not be built before that contract is real. From `feedback/interventions.md` | `pre` | `agent` | block, overridable | immediate | |

### CI and merge — silence that reads as success

| # | Situation | Phase | Audience | Default level | Timing | Status |
|---|---|---|---|---|---|---|
| **I7** | **A PR with zero checks that is also unmergeable.** A conflicting PR runs no checks at all, which is byte-identical to CI not having started — so it reads as quiet rather than red. Cost a session ~20 minutes chasing trigger filters and rate limits before thinking to ask whether the PR was mergeable. The server can just look: `mergeable` / `mergeStateStatus`. **`post` by nature** — the PR already exists by the time there is anything to notice, so this one informs rather than stops. **Filed as an intervention rather than the documentation line originally proposed**, because a doc line relies on someone remembering, which is precisely what failed. See milestone row **#127** and the field note it came from | `post` | `agent` | nudge | immediate | |

### Budget and scale

| # | Situation | Phase | Audience | Default level | Timing | Status |
|---|---|---|---|---|---|---|
| **I8** | **Spawning a new subagent near a budget ceiling.** The advice is to wind down and finish what is open rather than fan out. Needs whatever M7 telemetry exposes as a spend signal | `pre` | `agent` | nudge (prominent) | immediate | |
| **I9** | **A foreground `sleep` while an unblocked row sits idle.** Waiting treated as an activity. See `../orchestration.md`: the correct response to "this will take nine minutes" is not to watch it for nine minutes; it is to spend those nine minutes starting the next four things. Detectable only with a `PreToolUse` hook, so it is gated on the hook being wirable (#125) | `pre` | `agent` | nudge | immediate | |

### Correctness — the ones that should block

These are the conditional rules that pattern lists could never express, and the reason #125 deletes
the allow/ask lists rather than fixing them.

| # | Situation | Phase | Audience | Default level | Timing | Status |
|---|---|---|---|---|---|---|
| **I10** | **A merge to the default branch with no approving review artifact at tip.** The rule is *not* "never run `git merge`" — it is "not without an approval", which is why a command matcher cannot express it. **Was milestone row #44**, whose one-line description — *"the judgement server-side, only command parsing local"* — is this file's thesis stated before this file existed: the server decides, the client only recognises that a merge is being attempted. Folded here from the milestone queue | `pre` | `agent` | block, overridable | immediate | |
| **I11** | **A broad `git add` on a shared checkout** (`-A`, `--all`, `.`, `-u`, `:/`) — stages other agents' work under your name. Inert inside a linked worktree, which has its own index, so the check is scope-aware rather than command-aware | `pre` | `agent` | block, overridable | immediate | |
| **I12** | **A broad process kill** — a kill not scoped to a specific process. **Block with a written reason, not an ownership check** (settled 2026-08-15). The point is to make the caller pause and ask whether a narrower kill would do, which is the answer most of the time; it does not need to know whether a given PID is the caller's. That matters because the ownership route needs a live process registry, correct PID attribution and an accurate crew root — machinery whose failure mode is *silently wrong* in both directions, blocking work that was fine or waving through the exact kill it exists to stop. A prompt to think costs none of that and catches the same mistake. `kill_guard` remains as a service call for anything that later wants the precise answer | `pre` | `agent` | block, overridable | immediate | |

---

## Defaults, overrides, and retiring an entry

Every field on an entry — enabled, level, timing, audience, both messages — ships with a **default**
that the installation inherits. An installation may override any of them from the settings page.

**An entry that has never been overridden tracks the product.** If a later release changes a default
level, retunes a message, or retires an entry outright, an installation that never expressed an
opinion about it simply picks that up on update. Nothing needs migrating and nobody has to go and
switch anything off.

**An override is a decision, and it sticks.** Once an installation has set a field explicitly, later
releases leave that field alone. The cost of the rule is that an installation which overrode a
setting keeps its own answer even when the shipped one improves — which is the correct trade, because
the alternative is a product update silently reversing a deliberate choice.

So **retiring an entry is a release, not a migration**: mark it retired and every installation that
never had an opinion stops seeing it, while the few that deliberately turned it on keep it until they
say otherwise.

**Where the detection code lives is the implementer's call** — the ordinary conventions of this
repository, decided when the engine is built rather than settled in advance here. This document
governs *what* is detected and *what happens*, not the file layout.
