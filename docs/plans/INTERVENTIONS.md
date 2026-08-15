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

| # | Situation | Default level | Timing | Status |
|---|---|---|---|---|
| **I1** | **Coding is finished and no reviewer exists.** An item whose builder reported done, with no reviewer assignment and no review request. Was milestone row #114 | nudge | digest | |
| **I2** | **An available row nobody is building.** The dependency graph says a row is unblocked and no crew holds it. The rule it encodes is stated in `../orchestration.md`: an unblocked row should never sit idle, because a row the graph says is available with nothing building it is a failure of orchestration rather than a neutral state. | nudge | digest | |
| **I3** | **A claim held by a session that has gone quiet** while its holder is demonstrably working elsewhere. Distinct from the liveness sweep (#99/#130), which reclaims *dead* sessions — this is about a live session sitting on work it is not doing | nudge | digest | |
| **I4** | **A subagent reported complete and the orchestrator has not started the next step.** The handoff that silently does not happen | nudge | digest | |
| **I5** | **A reviewer returned `lgtm_with_followups`, a merge was requested, and no item was ever minted for the follow-ups.** The follow-ups are agreed, recorded, and then quietly dropped — the most expensive entry on this list, because the work was already understood | nudge (prominent) | immediate | |

### Hygiene — the tidy-up nobody remembers

| # | Situation | Default level | Timing | Status |
|---|---|---|---|---|
| **I6** | **A merged item whose worktree still exists, branch is undeleted, or Playwright slot is unreleased.** Was milestone row #112. Original framing: *"a reminder after merging a task for the agent or subagent to close their worktree, delete their local branch, release playwright (only if it used any) and just general cleanup"*. **This one has history and it is the argument for the whole file:** it has been written down as a standing instruction three times and mechanised zero times, and the leftover worktrees are measurable on disk. An instruction that survives three restatements without being followed is not waiting for a fourth restatement | nudge | digest | |

### CI and merge — silence that reads as success

| # | Situation | Default level | Timing | Status |
|---|---|---|---|---|
| **I7** | **A PR with zero checks that is also unmergeable.** A conflicting PR runs no checks at all, which is byte-identical to CI not having started — so it reads as quiet rather than red. Cost a session ~20 minutes chasing trigger filters and rate limits before thinking to ask whether the PR was mergeable. The server can just look: `mergeable` / `mergeStateStatus`. **Filed as an intervention rather than the documentation line originally proposed**, because a doc line relies on someone remembering, which is precisely what failed. See milestone row **#127** and the field note it came from | nudge | immediate | |

### Budget and scale

| # | Situation | Default level | Timing | Status |
|---|---|---|---|---|
| **I8** | **Spawning a new subagent near a budget ceiling.** The advice is to wind down and finish what is open rather than fan out. Needs whatever M7 telemetry exposes as a spend signal | nudge (prominent) | immediate | |
| **I9** | **A foreground `sleep` while an unblocked row sits idle.** Waiting treated as an activity. See `../orchestration.md`: the correct response to "this will take nine minutes" is not to watch it for nine minutes; it is to spend those nine minutes starting the next four things. Detectable only with a `PreToolUse` hook, so it is gated on the hook being wirable (#125) | nudge | immediate | |

### Correctness — the ones that should block

These are the conditional rules that pattern lists could never express, and the reason #125 deletes
the allow/ask lists rather than fixing them.

| # | Situation | Default level | Timing | Status |
|---|---|---|---|---|
| **I10** | **A merge to the default branch with no approving review artifact at tip.** The rule is *not* "never run `git merge`" — it is "not without an approval", which is why a command matcher cannot express it. **Was milestone row #44**, whose one-line description — *"the judgement server-side, only command parsing local"* — is this file's thesis stated before this file existed: the server decides, the client only recognises that a merge is being attempted. Folded here from the milestone queue | block, overridable | immediate | |
| **I11** | **A broad `git add` on a shared checkout** (`-A`, `--all`, `.`, `-u`, `:/`) — stages other agents' work under your name. Inert inside a linked worktree, which has its own index, so the check is scope-aware rather than command-aware | block, overridable | immediate | |
| **I12** | **A machine-wide process kill** — anything not scoped to PIDs the asking crew registered. Already has a service call in `kill_guard`, so this entry is wiring rather than new detection | hard block | immediate | |

---

## Open questions

- **Where does an intervention's detection code live?** #128 says only "follow the repo's existing
  file conventions". Worth settling once, before there are twelve of them.
- **How does an entry get retired?** A `wont_do` for interventions — some of this list will turn out
  to be noise, and switching it off in settings is per-installation, not per-project.
- **Does the digest belong to a session, a crew, or an item?** I1–I5 are mostly *orchestrator*
  concerns; I6 and I9 are the acting agent's. A digest addressed to the wrong reader is another way
  of being ignored.
