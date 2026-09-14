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

**A `built` entry is live; it is not necessarily the whole entry as written here.** Detection is
bounded by what the server can actually observe, and five of the entries below are shipped against a
narrower signal than their description asks for — I1 keys on the item's own state rather than on a
builder's report, and I7 on the same, because the PR fields it would really read (`mergeable`,
`mergeStateStatus`) are not collected by anything. **I15 fires on a write into the checkout, not on a
claim**: the tools whose whole purpose is to edit a file are the ones that carry no command text to
read, so the tool name is the signal; a `claim` that lands in an occupied checkout is not refused,
because the intervention payload on the ordinary service responses is not wired. It is narrowed
twice more, both deliberately — it **does not fire inside a linked worktree**, because
`(machine, repo)` cannot tell two crews sharing one working tree from two crews each in their own and
the second is the intended arrangement; and it fires only for a session that itself holds a claim,
because the checkout is identified through that claim. Each says so in its own row. The alternative was
to ship a predicate that quietly never fires, and an entry that cannot trigger is worse than an
absent one: it reads as coverage on the settings page and provides none.

**I13 ships as half of itself, and the half is named.** It fires when a session records work — a
`git commit` or a `git push` — while holding no item at all, which is a row rather than a judgement.
The near-match half of the entry (an artifact recorded against an item whose title merely resembles
the intended one) is **not** built, because it needs a similarity threshold nobody has chosen and
every available choice is wrong in a way that matters: loose enough to catch a real near-miss also
refuses the ordinary case where *"Build the X"* and *"Review the X"* are neighbouring rows. It is
also shipped as `pre` rather than the `post` catalogued here — the same call is the moment the
finding is worth saying, and a `pre` nudge reaches the caller while it can still mint the row rather
than after the commit exists.

**I14 counts edits, not read share, and the distinction is deliberate.** It reuses the existing
`isWriteTool` classification (`src/lib/telemetry/shape.ts`) but not `readShare`, which measures a
*proportion*: an orchestrator that reads forty files to brief a crew and edits three has a low read
share and is doing its job well, while one that makes twenty edits and no reads is exactly the drift
the entry describes. Keyed on the proportion those two come out backwards. It is also gated twice —
on the `post` phase, and then on the claim being held as `orchestrator` — so the windowed query lands
only on orchestrator-held sessions and never on the blocking path.

**The unbuilt entries carry their reason in code**, in `UNIMPLEMENTED_CATALOGUE_ENTRIES`
(`src/lib/interventions/builtins.ts`), naming the signal that is missing rather than the feature. A
test asserts that list and the registry together account for every entry here, so an entry cannot be
silently dropped from both.

### Flow — work that has stopped moving

| # | Situation | Phase | Audience | Default level | Timing | Status |
|---|---|---|---|---|---|---|
| **I1** | **Coding is finished and no reviewer exists.** An item whose builder reported done, with no reviewer assignment and no review request. Was milestone row #114 | `post` | `orchestrator` | nudge | digest | `built` |
| **I2** | **An available row nobody is building.** The dependency graph says a row is unblocked and no crew holds it. The rule it encodes is stated in `../orchestration.md`: an unblocked row should never sit idle, because a row the graph says is available with nothing building it is a failure of orchestration rather than a neutral state. | `post` | `orchestrator` | nudge | digest | |
| **I3** | **A claim held by a session that has gone quiet** while its holder is demonstrably working elsewhere. Distinct from the liveness sweep (#99/#130), which reclaims *dead* sessions — this is about a live session sitting on work it is not doing | `post` | `orchestrator` | nudge | digest | |
| **I4** | **A subagent reported complete and the orchestrator has not started the next step.** The handoff that silently does not happen | `post` | `orchestrator` | nudge | digest | |
| **I5** | **A reviewer returned `lgtm_with_followups`, a merge was requested, and no item was ever minted for the follow-ups.** The follow-ups are agreed, recorded, and then quietly dropped — the most expensive entry on this list, because the work was already understood | `post` | `orchestrator` | nudge (prominent) | immediate | |
| **I13** | **A crew was dispatched against work that was never minted.** A claim, a branch or a commit artifact appears for a session holding no item, or a `record_artifact` names an item whose title is a near-match for the one the caller meant rather than the one it hit. From the owner's own account of a five-crew night (`interventions.md`): *"PR2+3 was never minted as a task. I dispatched that crew — the most valuable PR of the five — without a task existing. Nobody caught it because the follow-up task had a similar name."* The same session then recorded a commit artifact against the wrong item, and there is no delete operation to take it back. **Both are one root cause, and it is the one this whole product exists to remove:** five parallel crews were being tracked in a person's head rather than against the board, so the board drifted from reality without anything failing loudly. **The rule to encode is *mint before you dispatch*, not after** — a dispatch is the moment the item becomes the only thing that knows the work exists. Detectable from claim and artifact writes against a session with no held item, which the server already records. From `feedback/interventions.md` | `pre` | `orchestrator` | nudge (prominent) | immediate | `built` |
| **I14** | **An orchestrator is doing the work itself.** Reads and edits to repository files accumulating on a session that holds an item as `orchestrator`, rather than a spawn. Detectable from the tool-call stream #50 already ingests: a cumulative count of edits and repository reads over the last several calls, which distinguishes a burst of hands-on work from the reads an orchestrator legitimately does to brief a crew. **Deliberately a nudge and deliberately cumulative**, because the single-call version of this check is wrong in both directions — one edit is often the right call, and research reads before a dispatch are the job. What is worth catching is the drift, where an orchestrator has quietly become the builder and the crew it should have spawned never gets spawned. Requested by the owner as *"you are doing work you should probably be delegating to a subagent"*. **Overlaps `fm-always-delegate-nudge` in the installation this came from and supersedes it** — that hook matches on write-shaped commands outside a path allowlist, which is the pattern-matching approach #125 retired. From `feedback/interventions.md` | `post` | `orchestrator` | nudge | digest | `built` |

### Hygiene — the tidy-up nobody remembers

| # | Situation | Phase | Audience | Default level | Timing | Status |
|---|---|---|---|---|---|---|
| **I6** | **A merged item whose worktree still exists, branch is undeleted, or Playwright slot is unreleased.** Was milestone row #112. Original framing: *"a reminder after merging a task for the agent or subagent to close their worktree, delete their local branch, release playwright (only if it used any) and just general cleanup"*. **This one has history and it is the argument for the whole file:** it has been written down as a standing instruction three times and mechanised zero times, and the leftover worktrees are measurable on disk. An instruction that survives three restatements without being followed is not waiting for a fourth restatement | `post` | `agent` | nudge | digest | |
| **I15** | **Another live crew already holds this checkout on this machine.** A claim, or a write into a worktree, where a different root session holds a running assignment on the same `(machine, repo)`. **The server already has every field this needs** — `assignments` carries `machine`, `branch`, `worktree`, `sessionId`, `rootSessionId`, `liveness` and `releasedAt` — so the predicate is a single query and the message can *name the holder*, the item, the branch and how long ago it was last active, rather than only refusing. **Key it on `(machine, repo)`, never on `worktree`**: that column is an unnormalised free-text path, so `/path/to/repo`, `/path/to/repo/` and `~/repo` do not collide and a predicate over it passes silently when it should fire — exactly the *silently wrong in both directions* failure I12 retreated from. **And on `rootSessionId`, not `sessionId`**, for the reason `registered_processes` already makes the same distinction: a worker an orchestrator spawned is the same crew and must not block itself. This also gives that table's careful root-session attribution its first consumer. From `feedback/other system.md` (F19, F2, F5) | `pre` | `agent` | block, overridable | immediate | `built` |
| **I16** | **A free-form content search rooted at a directory large enough that it will not return.** Reaching for a recursive search where listing the directory first would have answered the question — and on a tree of this size the search is slow enough to burn the turn it was meant to save. The owner's framing: *"steer against using search instead of `ls` and trying to see if it can make sense of the folder structure; on large folders search can be really slow."* **The detection is the interesting part and it constrains the level.** The server cannot see the caller's filesystem, so the hook has to carry the scope with the call — a directory and a cheap size signal — and the server decides whether that scope is too broad. That is a real cost on a `pre` check, which is why the entry is **block-overridable rather than a hard block**: a search scoped to one file or a leaf directory is fine and the caller is usually right about which it has. **Gated on #128's context declaration** — an intervention states the context it needs and the server assembles it, so this is the first entry whose declared context includes something only the client can supply, and it should not be built before that contract is real. From `feedback/interventions.md` | `pre` | `agent` | block, overridable | immediate | |

### CI and merge — silence that reads as success

| # | Situation | Phase | Audience | Default level | Timing | Status |
|---|---|---|---|---|---|---|
| **I7** | **A PR with zero checks that is also unmergeable.** A conflicting PR runs no checks at all, which is byte-identical to CI not having started — so it reads as quiet rather than red. Cost a session ~20 minutes chasing trigger filters and rate limits before thinking to ask whether the PR was mergeable. The server can just look: `mergeable` / `mergeStateStatus`. **`post` by nature** — the PR already exists by the time there is anything to notice, so this one informs rather than stops. **Filed as an intervention rather than the documentation line originally proposed**, because a doc line relies on someone remembering, which is precisely what failed. See milestone row **#127** and the field note it came from | `post` | `agent` | nudge | immediate | `built` |

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
| **I10** | **A merge to the default branch with no approving review artifact at tip.** The rule is *not* "never run `git merge`" — it is "not without an approval", which is why a command matcher cannot express it. **Was milestone row #44**, whose one-line description — *"the judgement server-side, only command parsing local"* — is this file's thesis stated before this file existed: the server decides, the client only recognises that a merge is being attempted. **Narrowed when it was split**: it now requires that *no* approving code review exists on the item at any round, so every firing is work nothing has ever approved. The other half — an approval that exists but does not stand at the tip — is I10b below, and that separation is why this one can stay a block. Folded here from the milestone queue | `pre` | `agent` | block, overridable | immediate | `built` |
| **I10b** | **A merge whose approving review does not stand at the current round and tip.** Split out of I10, and **the numbers are the reason**: across the combined entry's firings the approval half has a confirmed true positive — a genuinely unapproved merge, correctly stopped — while this half produced **fifteen firings and one true positive**, so fourteen sessions were refused a merge of work that had in fact been reviewed. Both halves lived in one entry, which meant `level` could not soften one without softening the other. **The high false-positive rate is not a detection bug**, and the original entry's own message said so: the item's review round is the highest round across *every* artifact kind, so recording a `check_run` or a commit artifact after an approval demotes it *without anything about the code changing*. The dominant cause of this firing is therefore bookkeeping rather than risk, and blocking a merge on bookkeeping is how a guard teaches people to route around it. **A nudge because the remedy is cheap and the reader is the right judge**: re-record the approval if the code moved, proceed if the demotion was an artifact. What the fourteen needed was the explanation, which they now get without losing their merge phase. **Cannot double-fire with I10** — both require no approval at tip and then split on whether one has ever existed, strictly `false` against strictly `true`, so a context answering neither triggers nothing. **Evidence that fires it:** `hasApprovalAtTip` false and `hasAnyApproval` true. From the firing record and `feedback/interventions.md` | `pre` | `agent` | nudge | immediate | `built` |
| **I11** | **A broad `git add` on a shared checkout** (`-A`, `--all`, `.`, `-u`, `:/`) — stages other agents' work under your name. Inert inside a linked worktree, which has its own index, so the check is scope-aware rather than command-aware | `pre` | `agent` | block, overridable | immediate | `built` |
| **I12** | **A broad process kill** — a kill not scoped to a specific process. **Block with a written reason, not an ownership check** (settled 2026-08-15). The point is to make the caller pause and ask whether a narrower kill would do, which is the answer most of the time; it does not need to know whether a given PID is the caller's. That matters because the ownership route needs a live process registry, correct PID attribution and an accurate crew root — machinery whose failure mode is *silently wrong* in both directions, blocking work that was fine or waving through the exact kill it exists to stop. A prompt to think costs none of that and catches the same mistake. `kill_guard` remains as a service call for anything that later wants the precise answer | `pre` | `agent` | block, overridable | immediate | `built` |
| **I17** | **A merge to the default branch carrying unsigned commits.** Nothing in the schema, the catalogue or the milestone queue covers commit signing, which is a gap rather than a decision — **I10 already reaches into *merge without an approving review at tip*, and this is the same shape at the same phase**: a condition on the commits being merged, evaluated against server-held state, expressible only as a rule about *this* merge rather than as a command matcher. The situation is detectable wherever I10's is — the item's tip is already known, and a signature is a property of the commit object at that sha. **Two things must be settled before it is built, and neither is obvious enough to assume.** First, *whose* signature counts: an installation where agents author every commit needs a trusted-key set that means something, and a rule that accepts any valid signature verifies only that signing happened, not that a trusted party signed. Second, whether it is a merge-time check or a record-time one — checking at `record_artifact` for the `commit` kind catches it earlier and closer to the author, while checking at merge is the point where the consequence lands. **Ships disabled by default**, per the defaults rule below: an installation with no signing convention would otherwise be blocked on arrival by a rule it never adopted, and this catalogue's own guidance is to prefer the weakest level that works. Filed from external field feedback (`feedback/other system.md`, F6) | `pre` | `agent` | block, overridable | immediate | |
| **I18** | **A subagent spawned at a model or effort the selector did not recommend.** The owner's framing: *"when spawning a subagent, if it's spawned with an incorrect model or effort than recommended"*. A dispatch names a tier; the selector service owns the calibrated heuristics that say which tier this job wants. Where both are known the mismatch is arithmetic, not judgement — and the cost is asymmetric in a way worth catching: too low silently produces work that fails review two rounds later, too high burns budget nobody chose to spend. **A nudge, not a block, because the selector is advice and the dispatcher may know something it does not** — a retry after a weak first attempt is a deliberate step up, not an error. What makes it worth saying is that the common case is not disagreement but omission: a tier picked from habit without consulting the selector at all. Needs the recommendation to be recorded at dispatch to compare against, which is the part not yet built. From `interventions.md` | `pre` | `orchestrator` | nudge | immediate | |
| **I19** | **A subagent spawned without the tools its job requires.** The owner's framing: *"subagents should be spawned with tools needed like playwright if they will need to review, and agent-standup always"*, strengthened later to *"subagents should immediately stall and return telling the orchestrator they can't continue without the orchestrator provisioning them all the tools they need"* — a hard block. A reviewer with no browser cannot render the thing it was sent to look at; a crewmate with no `agent-standup` cannot record what it did, and **an MCP server is not inherited by a subagent**, so the omission is silent until the agent is mid-task and unable to finish. **The reason this is worth an entry rather than a convention** is that its failure mode is indistinguishable from the agent being bad at its job — it reports what it could not do, not that it was never equipped to, and the orchestrator reads the report as a finding rather than a missing tool. **Ships as half of itself, and the half is named.** The spawn-time detection this entry asks for is *not* built and is not buildable on this schema: the server never observes a spawn, so it cannot compare the tool list an agent was given against the one its job needed, and a rule firing on every subagent without a browser would fire on every subagent that correctly had none. What ships instead fires on a **repeat** dispatch — an orchestrator spawning another agent on an item where a previous one already called `report_blocked_on_tool` and nothing has cleared it. That is a row rather than an inference. **The cost is honest: the first agent still hits the wall**, because nothing here knows anything until that agent speaks; what it prevents is the second and the third, which is the shape both documented incidents took. **The stall-and-report half is the other operation, not a predicate**: `report_blocked_on_tool` is the channel a blocked agent stalls through, and it writes an `escalation`, which is already a `CREW_EVENT_TYPE` — so an orchestrator sitting in a crew wait is woken by it rather than learning from a final report. It **distinguishes `not_granted` from `refused`**, because the two have different fixes and a check keyed only on the allowlist misses the second: `checkpoint` was in the `tools:` list of four crews on 2026-08-23 and still could not be used, because it requires a live assignment a dispatched agent does not hold. This is specific to operations with that precondition and must not be read as *subagents cannot reach the board* — `record_artifact` and `create_task` succeeded for a reviewer with no claim the same day. From `interventions.md` | `pre` | `orchestrator` | nudge | immediate | `built` |
| **I20** | **A follow-up minted as a child of the item it follows up on, when the intent is to close that item now.** The owner's framing: *"only mint as a subtask if you intend to act on them immediately; if you intend to close out this task then the follow-ups should be minted as a sibling, not a child"*. An open child keeps its parent from completing, so a follow-up filed as a subtask converts "work worth doing later" into "this item cannot close" — silently, at the moment the orchestrator believes it is finishing. **The check is the caller's own stated intent, which is why this is cheap**: a `create_subtask` against an item the same session is about to complete is the signal, and the question — *is this a prerequisite for closing, or work that outlives it?* — is one the caller can answer in a sentence. Sibling is right whenever the answer is the latter. Pairs with **I5**, which catches the follow-up that was never minted at all; this catches the one minted in the wrong place. From `interventions.md` | `pre` | `agent` | nudge | immediate | |
| **I21** | **A change to schema or migrations described as safe, additive or non-destructive without the SQL having been read.** From the owner's own account: a pending set was called *"additive, no drops"* when one migration dropped a column forward-only with no down migration, another rewrote sort order on every product row, and a third backfilled values that overwrote parent records a person may have set deliberately. All three were fine, and **the defect is the characterisation, not the migrations** — *"additive" is exactly the word that stops someone looking*. Detectable as a claim without a read: did this session open the `.sql` bodies in the changeset before summarising their risk. Same failure shape as trusting a tool's report over the underlying system, which has bitten this installation before. **A nudge and not a block**, because the claim is often true and the check is about evidence rather than correctness: *"you called this additive from the filenames. read the SQL."* From `interventions.md` | `pre` | `agent` | nudge (prominent) | immediate | |
| **I22** | **An orchestrator asking a person to approve *dispatching* work, or naming a protocol or authorisation that does not exist.** From the owner's own account of doing it twice in one session: a task touching schema and checkout paths was held for an *"explicit territory grant"* — an invented ceremony, given an official-sounding name and presented as procedure the person was supposed to recognise. *"He had to ask 'what is a territory grant?' — which is the tell."* A second item was described as gated when it was simply next in the queue. **The rule being misread is a real one applied at the wrong phase**: a blocking list of sensitive paths governs **merges**, not dispatches. Writing code on a branch is reversible — the branch can be deleted and nothing reached production — so the human decision point is the PR, with a diff attached, not the dispatch, where there is nothing yet to look at. **The cause is worth carrying because it makes this a pair, not a lone entry.** The same session had earlier held a customer-facing change for a person and watched it merge four minutes later anyway; the lesson taken was *"my hold did not stick"* and the overcorrection was to move the gate **earlier**, where it is both useless and more annoying, rather than to ask why the merge-time hold had no teeth. **An overridden hold is a product gap; it is not a reason to start asking permission to type.** Cheap signal: a question to a person containing an invented capitalised noun phrase, or an item parked as blocked whose stated blocker is a path list rather than a real dependency. Nudge: *"dispatch it; hold the PR instead."* **Wanted alongside it, and the other half of the same bug:** a way to mark an item blocking-on-a-person that is visible **at merge time**. `mergeAuthority: needs_approval` exists as a field and did not stop that merge — if orchestrators had a hold that actually held, they would not reach for a fake gate at dispatch time. From `interventions.md` and `2026-08-19-merges-outpaced-reviews-and-a-hold-was-overridden.md` | `pre` | `orchestrator` | nudge (prominent) | immediate | |

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

---

## Scoring: is any of this worth it?

Everything above describes what is detected and what happens. None of it says whether a given entry
was *worth* detecting — and the catalogue only ever grows, because every incident appends an entry
and nothing has ever removed one. Entries have shipped that were unsatisfiable by construction, and
entries have shipped whose message named a remedy the same guard then refused. Both were found by a
person hitting them.

**The loop, in four parts** (`src/lib/interventions/scoring.ts`, `survey.ts`, `capture.ts`):

1. **A firing is captured** with what the session was doing and, crucially, **the message it was
   shown**. The message is most of what is being judged: a correct detection with a bad message and a
   wrong detection both earn a low score, and they have opposite fixes — reword it, or delete it. A
   row holding only an entry id cannot tell them apart.
2. **A session-end survey asks for a 1–5 score**, on genuine wind-down rather than at any turn
   boundary. A `Stop` is necessary but not sufficient: no live crew, nothing scheduled to wake the
   session, and a real quiet period. An unknown idle time stays silent, because a survey that fired
   on unknown would fire on every stop.
3. **Scores aggregate per entry** and the report names the ones worth reading.
4. **A 1 is a removal signal**, not merely a low score.

### Orchestration — the cost of coordinating parallel work

Findings from running several crews at once. All nudges: none of these describes something *wrong*,
only something more expensive than it needs to be, and the weakest level that works is the rule.

| # | Situation | Phase | Audience | Default level | Timing | Status |
|---|---|---|---|---|---|---|
| **I23** | **Checking whether a branch was merged by comparing commit refs, in a repository that squash-merges.** A squash produces one new commit with a new sha and the branch's own commits are never ancestors of it, so `git branch --merged`, `git merge-base --is-ancestor`, `git cherry` and a two-dot `log`/`rev-list` range all report "not merged" for work that merged cleanly an hour ago. **The answer is correct for the question asked and wrong for the question meant**, which is what makes it undebuggable by looking harder at the output — sessions have concluded a merge failed, re-run it, and re-opened settled work on the strength of it. Recognisable from the command alone; the remedy is to read the pull request's own state. From `interventions.md` | `pre` | `agent` | nudge | immediate | `built` |
| **I24** | **A rebase, or the divergence check that usually precedes one.** The owner's framing: do not worry much about main purity, **bias toward fixing forward** if there are semantic conflicts, and only rebase if there are actual merge conflicts preventing the merge. Main moves several times an hour here, so a branch that is merely behind does not need rebasing and an early rebase usually means rebasing twice. **The check is recognised as well as the rebase itself**, deliberately: by the time `git rebase` is typed the decision is made and the calls are spent, whereas the divergence check is where it is still cheap to say "you may not need to". From `interventions.md` | `pre` | `agent` | nudge | immediate | `built` |
| **I25** | **Several items awaiting a visual review at the same time.** A visual reviewer is the most expensive agent dispatched — it needs a browser, holds one of a small pool of slots, and spends its budget looking at a rendered page — so one per pull request buys several sets of screenshots of intermediate states that are superseded before anyone reads them. The cheaper shape is to let them merge and do a single visual pass over the result. **The affordance is the point, not the advice**: the owner asks for a first-class way to record *"review deferred because of concurrency"* by linking the item minted to do it later, because advice to defer a review with no way to record the deferral is advice to forget it. `Artifact.followUpItemId` already carries exactly this relationship for `lgtm_with_followups`. **Silent at one** — one pending review is a review, not a batch. From `interventions.md` | `post` | `orchestrator` | nudge | digest | `built` |
| **I26** | **Work committed to a branch that never became a pull request.** The prompting incident is concrete: a branch committed, unmerged, whose item headline said in so many words *"needs the mobile check and a PR"*, sitting untouched for weeks while no entry caught it. **This is the entry that cannot be a `pre` block, and the reason is a category difference rather than a difficulty**: a `pre` entry fires on the **presence** of a call it can inspect, and this failure is the **absence** of one — the session commits and then stops, and "nothing" is not an event a matcher can match. So it fires on some *later* tool call, and the honest framing is *"soon after the work stopped"*, never *"when it stopped"*. **Evidence that fires it:** a `commit` artifact on the item and no `pull_request` artifact — both rows, no intent judged. Keyed on an exclusive stage, so it goes silent the moment a pull request exists rather than nagging for the life of the item. **A false positive costs** one digest line on a branch deliberately not yet a pull request — work in progress, an experiment, a branch parked on purpose — which is why the message offers "or record what it is waiting on" rather than demanding a pull request nobody wanted. Sibling of I1. From `feedback/interventions.md` and the 2026-09-10 catalogue note | `post` | `orchestrator` | nudge | digest | `built` |
| **I27** | **A pull request exists and nothing has requested a review of it.** The easy one, and easy for a stated reason: **both halves are already first-class records**, so it judges no intent and infers nothing from silence. **Evidence that fires it:** a `pull_request` artifact on the item with no `review_requested` event. **Distinct from I1 rather than a duplicate of it** — I1 keys on the item's *state* (`in_review` with no approval at tip), an item that has already announced it is waiting; this fires one step earlier, when the pull request exists and nobody has asked for anything yet. The shared stage vocabulary keeps them from both firing on one situation. **A false positive costs** one digest line where a reviewer was dispatched out of band without `request_review` being called — a real case, which the message treats as an answer rather than an error, because a review the board cannot see is one nothing downstream can wait for. From the 2026-09-10 catalogue note | `post` | `orchestrator` | nudge | digest | `built` |
| **I28** | **A `lgtm_with_nits` merge whose findings nothing is tracking.** **Not I5, and the asymmetry is the whole finding.** I5 (`lgtm_with_followups` with no linked follow-up) is unbuilt because nothing is missing — `merge.requires_linked_followup` already refuses that combination outright. Beneath `lgtm_with_nits` a finding at `medium` or above blocks the merge, which is correct; an `info` or `low` finding correctly does **not** — and that is the whole of its effect. Below the blocking threshold a finding is written to durable storage and then has no further lifecycle at all: no state, no owner, no follow-up, no expiry, living inside an artifact on a row that is now closed. **The equilibrium it protects is the real cost**: a reviewer who wants a finding to survive has exactly one lever — inflate it to `medium` so it blocks — while one who grades honestly watches it evaporate. Over enough reviews that either inflates severities or trains reviewers to stop recording sub-blocking findings, and the second is worse because it removes the evidence the problem exists. A reported instance had nine findings age out against a closed row, one a live hazard for the feature being built next, with a person rather than the product as the backstop. **Evidence that fires it:** the item's latest verdict-carrying review is `lgtm_with_nits`, its `findings` array is non-empty, and `followUpItemId` is unset. Keyed on the *latest* review, because a verdict is superseded by the next round rather than accumulated. **A false positive costs** one immediate line where the nits were actioned inside the same change — the likeliest wrong match by some distance, and cheap on purpose: the message accepts "already done here" without demanding a row, because requiring a linked item would push callers to mint bookkeeping rows for work already finished. `immediate` rather than digest, unlike its two siblings, because the row is *closing*: once the session moves on, the findings sit behind a merged item and the session that knew what they meant is gone. From `feedback/2026-09-10-lgtm-with-nits-merges-with-nothing-tracking-the-nits.md` | `post` | `orchestrator` | nudge | immediate | `built` |
| **I29** | **Dispatching another crew while several are already in flight.** The owner recorded the trigger — *"for large orchestration jobs, i.e. orchestrator is dispatching more than 2 crews at the same time"* — without naming an action, so **the remedy is a proposal rather than a transcription**, and it is deliberately *not* "dispatch fewer crews": parallelism is the point of the mechanism and an entry whose advice is to do less of the thing the system exists for would be correctly ignored. What goes wrong at width is what the count makes likely, and both failures are already on the record here rather than hypothesised — **overlapping territory** (the reason `checkout-held-by-another-crew` exists; that entry fires once the collision is happening, this one at the moment the territories are still being chosen, which is the only point where avoiding it is free) and **review capacity nobody planned** (four builders finishing together need four reviews, which is how I25's bill arrives unannounced). So the remedy is: confirm the new territory is disjoint, and decide the review plan now rather than when the pull requests land. **Evidence that fires it:** `COUNT(DISTINCT itemId)` over live assignments sharing this session's `rootSessionId`, on non-terminal items. **Scoped to the crew, not the board** — several orchestrators each running two crews is a busy system working correctly, and a board-wide count would fire on it while telling the reader nothing they could act on. **Counts items rather than agents**, so the ordinary builder-plus-reviewer pair on one item reads as one front rather than two. **Silent at two**, which is the ordinary shape. `immediate` rather than digest, unlike its siblings, because the decision it speaks to is being made by the very call it rides on. From `feedback/interventions.md` | `pre` | `orchestrator` | nudge | immediate | `built` |
| **I30** | **A visual review deferred with nothing recording the deferral.** The half of I25 that was advice rather than a mechanism. I25 tells an orchestrator to batch concurrent visual reviews into one pass after merge and asks that each deferral be recorded; the owner's ask is that this be **first class** — *"there should be a first class way to handle 'review deferred because of concurrency'"* — because advice to defer a review with no way to record the deferral is advice to forget it. **The affordance already existed and needed no schema change**: `Artifact.followUpItemId` carries exactly this relationship and `merge.requires_linked_followup` already enforces it for `lgtm_with_followups`. What was missing is that **nothing noticed when it was skipped** — a week later, a deferral nobody wrote down is indistinguishable from a review nobody thought of. **Evidence that fires it:** the item is flagged `needsVisualReview`, its state is terminal, no `visual_review` artifact exists, and no artifact on it links a follow-up. **The link is accepted on any artifact, not only a visual review**, because the deferral is naturally recorded by the artifact that stood in for it — usually the code review that merged the work — and requiring it on a `visual_review` would mean recording a visual review in order to say one had not been done. **Not a duplicate of I25**: different moment, different remedy, and they cannot both fire on one situation — I25 fires *before*, on a queue, and says "batch these"; this fires *after*, on one closed item, and says "the deferral you took is not recorded". An orchestrator that follows I25 and records the link never sees this entry at all. **A false positive costs** one line where the visual review was genuinely not needed — which the message accepts as an answer rather than an error. `immediate` for I28's reason: the row is closing, and the context that makes the answer cheap goes with the session. From `feedback/interventions.md` | `post` | `orchestrator` | nudge | immediate | `built` |
| **I31** | **Putting a question to the person before trying to answer it.** **This entry was argued against, and the objection is recorded because it decides the entry's shape**: judging whether a question is justified requires reading intent, which nothing here can do, and its false positive is uniquely invisible — a question that is suppressed is never asked, so neither the agent nor the person learns it was wanted, making it the one entry whose harm cannot be measured after the fact. **What makes it buildable is a measurement answer rather than a detection one.** The owner's instruction: *"maybe have a way to log how often that intervention ran and how often the agents decided they could figure it out themselves vs how often the agent genuinely felt there was justification to ask me. let's build it and add logging."* So **the logging is the precondition, not an accompaniment**: every firing is already an `intervention_events` row, and the *what happened next* half rides the existing scoring path rather than a parallel store — the session rates the firing, and the two outcomes are opposite ends of a scale that already means exactly this (a 4 or 5 = worked it out alone; a 2 or 1 = asked anyway and was right to). `get_intervention_scores` then answers "how often did this suppress a question that should have been asked" as the low-score share against this id. **Nudge, and never anything stronger** — the asymmetry is why: a false positive on a block suppresses a question invisibly, while a false positive on a nudge costs one ignored line. It is also load-bearing rather than cautious, because the split can only be observed if the agent stays free to ask; an entry that blocked would destroy the measurement justifying it. **It fires on every question and makes no accuracy claim**, naming instead the three things that usually answer one without a person — read the code or item body, re-read the brief, take the more sensible reading of an ambiguity and say which — while still saying plainly that genuinely unsafe, irreversible or person-only decisions are worth asking about. **Evidence that fires it:** the tool being called is a question-to-person tool, read off the name, so it costs no lookup and works for a session holding no claim. From `feedback/interventions.md` and the owner's 2026-09-14 override | `pre` | `agent` | nudge | immediate | `built` |

---

### Stopping with work left — why this is not an entry in the table above

The owner asked for an intervention on stopping: *"the agent shouldn't just stop if there is still
work remaining. The intervention should interject and ask the agent: is he really done with all the
work he was directed to do? And if not he should continue with the next set of unblocked tasks and
not just pause there for no reason."*

**It is built, and deliberately not as an intervention.** The reason is a hard limit of this engine
rather than a preference, and it is recorded here so that nobody adds a catalogue row for it later:

- `INTERVENTION_PHASES` is `["pre", "post"]`. Both are sides of a **tool call**, not lifecycle
  events, so there is no phase value an entry could carry that would mean "at the end of a turn".
- `hook_decision` returns before the registry is consulted on such an event: it answers
  `{ decision: "allow", findings: [] }` for a stop without assembling a context or walking the
  catalogue. Its own reason is that a stop *"carries no tool call at all, so there is nothing for a
  predicate keyed on a command or a tool to be about."*

So an entry naming that phase would be a predicate the engine never evaluates — the failure
`builtins.ts` warns about, where a registry row reads as coverage on the settings page and provides
none. **The blocker is this server's intervention engine, not the hook client**, which does carry
the event and already acts on it.

**Where it lives instead:** `src/lib/hook/stop-catch.ts`, beside the crew catch, which is the one
mechanism that does run at the end of a turn. That module is advisory *by construction* — its
functions return text or `null`, with no return shape that could express a refusal — which matches
the ask exactly, and matters because a refused stop can trap an agent in a loop that burns a budget
with nobody watching. It asks rather than asserts, because it cannot know the remaining rows are the
work the session was directed to do; and it is **silent unless the remaining work is unblocked**,
since a session whose open rows are all waiting on somebody else has correctly stopped. When crew
are still running, the crew catch speaks instead — that session already has an answer to "are you
done", and two messages at one stop is how both get skipped.

**Known gap, stated rather than papered over:** the `stop` block that carries this context is read
by the client but is emitted by no operation in this repository, so the count has no producer yet.
The check is correct and tested and activates for any caller that supplies the context; wiring a
server-side producer for it is its own row.

---

### The scale

| Score | Meaning |
|---|---|
| **5** | Would have gone down the wrong path and wasted a lot of tokens, or done something incorrect, without it |
| **4** | Saved time or tokens, but nothing dangerous was about to happen |
| **3** | Neutral — it helped, but the answer was reachable anyway |
| **2** | Did not help; incorrect or misleading, and cost time |
| **1** | Actively wrong or harmful — a block that had to be routed around. Remove it |

**The wording is load-bearing and lives in one place** (`INTERVENTION_SCORE_MEANINGS`), which the
survey prompt renders from rather than restating. A tidied paraphrase — "very useful / useful /
neutral / unhelpful / harmful" — reads like the same scale and is not one: 4 and 3 are separated by
*whether the answer was reachable anyway*, not by degree of usefulness, and 1 carries a request
rather than a sentiment. A rater handed the tidy version scores the same firing differently, and
every aggregate keeps computing while meaning something else.

### Two flag triggers, not one

An entry is flagged when its **mean is at or below 2.5**, *or* when **any rater scored it 1** —
either one, both subject to a minimum of three ratings so one bad afternoon cannot retire an entry.

The second trigger is the one that matters and a mean-only report would miss it. An entry can be
right on nine firings and harmful on the tenth, averaging a comfortable 4.6; the harm is usually a
detection firing outside its intended scope, and averaging it away is exactly how such an entry stays
shipped. A single 1 is a rater saying it did active harm, which is worth a look regardless of how
well it does the rest of the time.

### Keeping it cheap

Rating that costs more than the guard saves defeats itself, so the ask is bounded structurally rather
than by asking politely: **one item per entry** (the entry is what is being judged, not the call),
**at most five per survey**, and **a fixed JSON reply** that needs no model call to interpret. A note
is optional and one line — worth adding on a low score, because that is where "wrong detection" and
"bad message" have to be told apart.

Unrated firings stay unrated and can be asked about at a later wind-down, rather than being forced
into one oversized survey that gets a column of 3s.
