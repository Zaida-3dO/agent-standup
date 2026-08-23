# Agent Standup — data model, config, and API surface

Companion to `PLAN.md` (the readable plan) and `DECISIONS.md` (the reasoning behind each call).
This is the concrete shape of what gets persisted and what gets exposed.

**Status: draft for review.** Types are Postgres. Nothing built.

---

## 1. `items` — the work

One table for projects, tasks and subtasks. **Hierarchy is a parent pointer**, not three types.

| Field | Type | Meaning |
|---|---|---|
| `id` | `text` PK | **Opaque.** An imported item keeps whatever identifier it arrived with, verbatim, so an import is 1:1 — but no format is mandated. Baking one installation's ID scheme into a generic product is a leak. New items get whatever the app generates. |
| `parent_id` | `text` null → `items.id` | Null = a project (a root). Otherwise the item this sits under. Unbounded depth; guarded by the `items.max_depth` setting (§17.2). |
| `kind` | enum | `project` (depth 0) · `task` (depth 1) · `subtask` (**depth ≥ 2** — nesting is unbounded, so everything deeper is still a subtask). Derived from depth, stored for cheap querying. **Recompute the whole subtree on reparent**, not just the moved row: promoting a subtask to a root changes its children's kind too. |
| `title` | `text` | One line. |
| `headline` | `text` null | **The BLUF** — what this work *is*, in one line, written when the item is minted and maintained as it moves. Distinct from `title` (what it is *called*), from `body` (the brief, which runs to kilobytes) and from `summaries` (end-of-life, §5, and only exists once the item completes). It is the field that makes the slim read below *sufficient* rather than merely small: `{id, title, state}` answers "which item" and never "what is it". Capped at 200 characters in the service layer's input validation, because the one field a bounded read always returns cannot itself be unbounded. Null means nobody has written one — deliberately not defaulted to the title, so a caller falling back can tell the two apart. |
| `body` | `text` | The brief — the durable instruction for whoever picks this up next. |
| `state` | enum | See §1.1. The only thing transitions move. |
| `priority` | enum | `P0`–`P3`. |
| `origin_type` | enum | `person` · `source` · `auto` — who or what created it. |
| `origin_person` | `text` null → `people.id` | Required iff `origin_type = person`. **A reference, never a name in the schema** — more than one person mints work, and the core should know none of them by name. Which *file* a `source` item came from is already on `source_ref`. |
| `area` | `text` → `areas.id` | **Required.** Which part of the work this concerns. Works for research and non-code work. A foreign key rather than free text (§23.1) — it is filtered on and whitelisted in notification rules, so three spellings of one name are three values to the database and one to whoever typed them. **Auto-created on first use**, with normalisation, because blocking the most common write in the system is friction nobody should pay. |
| `repo` | `text` null → `repos.id` | Concrete repo key, only when code is involved. A foreign key for the same reason, and **created deliberately** rather than on first use: this is the value the merge gate reads to decide which repository a change lands in, so a wrong one aims the gate at the wrong repository (§23.1). |
| `branch` | `text` null | Integration branch for the deliverable. Per-agent branches live on `assignments`. |
| `needs_visual_review` | `bool` | Gates the merge check. **Renamed from `visual`** to stop it colliding with the `visual` *facet*, which is a difficulty score, not a gate. |
| `drive_mode` | enum | `autonomous` · `manual` · `supervised` — see §1.2. Gates the heartbeat, budget bands, and the guard layer. |
| `merge_authority` | enum | `pre-approved` · `needs-approval` · `agent-judgement` — see §1.3. Default from config. |
| `blocked_reason` | `text` null | Required iff `state = blocked`. |
| `blocked_on_type` | enum null | `person` · `external-process` · `time`. Required iff `state = blocked`. |
| `blocked_on_person` | `text` null → `people.id` | Required iff `blocked_on_type = person`. **A reference, not a name in an enum** — putting people into core vocabulary is exactly the leak that stops a product being generic. |
| `unblock_at` | `timestamptz` null | Only for `blocked_on_type = time`. Server can clear the block when it passes. |
| `pause_reason` | `text` null | Required iff `state = paused`. |
| `resume_condition` | `text` null | What the server re-checks to unpause. Required iff `state = paused`. |
| `resume_attempts` | `int` | Dispatch attempts since the last **durable** progress — a checkpoint, commit, transition or artifact. Three → `blocked`. **Reset by evidence, never by a claim** — resetting on claim means dispatch → claim → die → repeat forever and it never escalates. |
| `difficulty` | `jsonb` null | Facet → score (1–5), **sparse** — omit facets not in play rather than zeroing them. Feeds cost estimation and the model picker. Facet list is a **fixed union in code**; see §1.1a. |
| `source_ref` | `text` null | Which source version this came from — **`path@content_hash`, a real key, not prose**, because it's what answers "what already exists from this file" and so must match exactly. There is no `sources` table (§13); this column *is* the record. Editing a file changes the hash, so older items keep pointing at the version they came from — correct history for free. |
| `notify` | `jsonb` null | Item-specific notification rules. See §1.1b. Null = only the notifier's standing rules apply. |
| `estimated_cost` | `numeric` null | Estimated cost at list price. From cost history, else from `difficulty`. **Not "points"** (collides with story points in exactly this domain) and **not a budget share** — a share is volatile, meaningless once the window definition moves. The share is computed at decision time by the budget adapter, never stored. |
| `custom_fields` | `jsonb` null | Arbitrary key/value bag, **opaque to the core** — never validated, indexed or reasoned about. The escape hatch that stops a missing field forcing a fork. Migration seeds `legacy_id` here, which is why `id` can be opaque. |
| `created_at` | `timestamptz` | Set once. |
| `updated_at` | `timestamptz` | Bumped by **every** mutation, in the same transaction that appends the corresponding `events` row — so the two can never drift. Stored rather than computed from `max(events.ts)`: it's an index for "changed since I looked" and board sorting, and a subquery per row on every board render is the wrong trade. |
| `completed_at` | `timestamptz` null | Set on entry to a `completed` state. |
| `archived_at` | `timestamptz` null | Set by `delete_item` (§1.4). **Not a state**, and deliberately outside the state machine: a state is a fact about the work, and this is a fact about the row. Non-null means no ordinary read serves it. |
| `archived_reason` | `text` null | Required by the operation that sets `archived_at`, so "why is this row invisible" is answerable from the row rather than only from history. |
| `superseded_by` | `text` null → `items.id` | The item this one was removed in favour of — most often the surviving half of a duplicate. A pointer, so a reader arriving by a stale link can be sent somewhere live. |

**No `review_round` column** — it's `max(artifacts.review_round)` for the item. Artifacts are the truth;
a second copy here would drift.

**Reads return `{id, title, state, headline}` by default; the whole row is opt-in.** `get_item`,
`list_items` and `get_board` all share one column list, and every field on it — including a `body`
that can run to tens of thousands of characters and a `custom_fields` bag with no bound at all — came
back on every call from every surface. A measured single-item read was 145,317 characters, of which
`custom_fields` was 94,038 and `body` 49,538: the scalars the caller wanted were 0.2% of what it was
sent.

Neither a filter nor a page size reaches that. `limit` bounds row *count* and nothing bounds row
*size*, so a page of one still overflows on the largest item, and `get_item` is `WHERE id = $1` with
no filter to default. **The only control is which columns come back**, so that is the control: a slim
default, with `full` restoring the whole record on every surface — service, HTTP (`?full=true`), MCP
(`full: true`) and the command line (`--full`). `get_item`'s slim response also carries
`checkpoint_headline`, the latest checkpoint's own one-line BLUF, because "what is this" and "where
is it up to" are one question and latest-checkpoint is already an indexed single-row read (§4).

**The board's slim shape is wider, and bounded.** A card cannot be drawn from four fields: `kind` is
structural (a project's column derives from its subtree, §1.1), and `priority`, `area`, `repo`,
`blocked_reason`, `blocked_on_type`, `blocked_on_person` and `pause_reason` are what a card renders.
It still leaves `body` and `custom_fields` behind, which is where the whole saving was.

**Indexes:** `(state)`, `(parent_id)`, `(area)`, `(repo)`, `(state, priority)`, `(source_ref)`.
`(repo)` is there because listing filters on it exactly as it filters on `area`.

**Two rules on `custom_fields`, or it becomes a schema inside the schema:**
- **Not addressable by notification rules.** §1.1b is bounded to a field whitelist on purpose; letting
  rules reach into an untyped bag turns the evaluator into a dynamic query engine.
- **If a key recurs, promote it to a column.** Same rule as `role_custom` and facets — the escape hatch
  is for the genuinely one-off, not a place for everyone's real data to accumulate untyped.

### 1.1 `state` — eleven values, four columns

Columns are **derived at read time**, never stored, never transitioned.

| Column | States |
|---|---|
| **Backlog** | `someday` — wanted eventually · `on-deck` — next up, the pool the heartbeat draws from |
| **In progress** | `planning` · `plan-review` · `executing` · `in-review` |
| **Waiting** | `paused` — nobody on it, resumes on a condition the system re-checks · `blocked` — an outside actor must act |
| **Completed** | `merged` · `research-done` · `wont-do` · `cancelled` |

**`paused` and `blocked` share a column** (the user, 2026-08-10), distinguished by **colour** — amber for paused, red for blocked. The states stay separate in the data; only the display groups them. Free to change because columns are derived, never stored.

⚠️ **One consequence to handle in the UI:** narrowing `blocked` was meant to make its column a trustworthy *"what needs me"* list readable by height. Sharing a column loses that, so the needs-you count wants a badge or filter of its own — otherwise the distinction survives in the data and disappears where you'd actually use it.

**Every state can reach every other state.** There is no edge whitelist. Guards are required *fields*, not forbidden moves — see §16.

### 1.1a Facets

**A facet earns its place only if models measurably diverge along it** — not "what kinds of work
exist." A facet everything scores the same on adds a dimension without adding discrimination.

| Facet | Measures | Scored from |
|---|---|---|
| `reasoning` | Depth of logic — multi-step correctness, tricky invariants | Correctness findings; bugs surviving to merge |
| `breadth` | How much unfamiliar code must be absorbed before acting | "Missed an existing helper", "broke an unrelated caller" |
| `precision` | How exactly output must match a spec, vs open-ended | Scope drift, `not_done` entries, rework |
| `autonomy` | How long it runs unsupervised without drifting | `steering_interventions`, turns to completion |
| `visual` | Does it look right | Visual review verdict — the cleanest of the six |
| `writing` | Prose a human reads | Mostly the human slider; hardest to score objectively |

`reasoning` and `breadth` are deliberately separate — reading forty files is breadth, holding a
five-step invariant is depth, and models are good at these independently. `autonomy` is separate
again: an agent can reason well and still wander over forty turns.

**Deliberately not facets:** `coding` (almost everything is coding, so it doesn't discriminate) and
`refactor` (a task *type*, not an axis — it decomposes into high `breadth` + high `precision`).

**A fixed union in code — no config indirection for now.** Free-form facets would destroy what scoring
exists for: scores only compare if the axis means the same thing across tasks, and agents inventing
them per-task would produce near-synonyms that fragment the data into columns with three data points
each. Adding one later is a code change and a deploy, which is cheap and gets type-level validation
for free.

**Selection is sparse and per-item.** Pick the facets actually in play when creating the item; only
those are scored at the end, and only those appear on the scoring UI. A backend refactor has no visual
dimension and shouldn't be asked about one.

**Editable upward only:** a facet can be added to an item later if it turns out to matter, but one
that already carries a score shouldn't silently disappear — that's data, not a preference.

⚠️ **Facet data cannot be retrofitted.** A facet added in month six starts with zero history while the
rest have hundreds of runs. An unused facet costs a JSON key; a missing one costs six months — so err
toward more at the start.

### 1.1b Notification rules

Same shape in two places: `items.notify` (one-offs) and `people.notify_rules` (standing preferences,
matched against every item). Most rules are standing — *"anything in `web` that completes"* shouldn't
be copy-pasted onto every task, because that's how it gets forgotten.

Each rule is `{ notify, when_all?, when_any? }`. **No nesting** — conditions and groups never share an
array, so the evaluator never type-discriminates elements.

```jsonc
[
  // completed
  { "notify": ["user-a"],
    "when_all": [ {"field": "state", "op": "eq", "value": "completed"} ] },

  // blocked AND waiting on the second user
  { "notify": ["user-a", "user-b"],
    "when_all": [ {"field": "state",             "op": "eq", "value": "blocked"},
                  {"field": "blocked_on_person", "op": "eq", "value": "user-b"} ] },

  // web work that is either blocked or P0
  { "notify": ["user-a"],
    "when_all": [ {"field": "area",     "op": "eq", "value": "web"} ],
    "when_any": [ {"field": "state",    "op": "eq", "value": "blocked"},
                  {"field": "priority", "op": "eq", "value": "P0"} ] }
]
```

**Semantics:** `all(when_all) && any(when_any)`, a missing bucket being vacuously true. **Any** rule
firing notifies its recipients. Three lines of evaluator.

**Same-field ORs use `in`** rather than `when_any` — `{"field": "state", "op": "in", "value":
["blocked","completed"]}` is an OR over one field, so `(blocked OR completed) AND (web OR infra)`
stays one rule.

**Validation: at least one bucket must be present.** A rule with neither has no conditions — a
footgun, not a feature. **The footgun is silence:** it fires **zero** times, not constantly. The
obvious reading is the opposite, because `ruleMatches` does treat a missing bucket as vacuously
true — but `parseStoredRules` drops such a rule before the evaluator sees it, and `evaluateRules`
is edge-triggered (`matchesAfter && !matchesBefore`), so a rule matching everything matches the
*before* snapshot too and the edge never occurs. A rule that looks configured and notifies nobody
is worth rejecting at the boundary precisely because nothing downstream will ever complain.

**Known limit, accepted:** two *independent* OR groups ANDed together (`A AND (B OR C) AND (D OR E)`)
needs splitting across rules, since there's only one `when_any`. `in` covers most of that territory,
and the simpler evaluator is worth more than the exotic case.

**Edge-triggered.** Evaluated on every mutation; fires when a rule **becomes** true having been false.
"Notify on completed" must fire on the *transition into* completed, not repeatedly while it sits there.

**Deliberately bounded, so it doesn't become a query language:**
- **Field whitelist only** — `state`, `blocked_on_type`, `blocked_on_person`, `area`, `repo`,
  `priority`, `drive_mode`, `merge_authority`, `assignee`. Nothing arbitrary.
- **Four operators** — `eq`, `neq`, `in`, `changed` (`changed` covers "tell me on any state change").
- **One level.** No nested groups, no expressions, no parser.

`notify` names recipients by `people.id`; **how** they're reached is the configured `notify`
capability — the core hands over a doc path and never knows what the chat app is.

### 1.2 `drive_mode`

A spectrum of **how much the system may act on the task**, not of who does the work.

| Value | Agents work unattended | Heartbeat may dispatch/resume | Budget bands | Guards |
|---|---|---|---|---|
| `autonomous` | yes | yes | enforced | live |
| `supervised` | yes | **no** | **soft — nudge only** | live |
| `manual` | no — you're driving | no | none | logging only, plus blast-radius warnings |

`supervised` is *"I kicked off a crew myself and I'm watching."* Don't pile more work in, don't hard-stop
it mid-flight, but do tell it when it's burning the window.

⚠️ **A supervised task whose agent dies is not re-dispatched.** It pauses and stays paused, because the
heartbeat isn't allowed to touch it. Correct — you're supervising — but stated here so it isn't
discovered at 3am.

### 1.3 `merge_authority`

| Value | Meaning |
|---|---|
| `pre-approved` | Merge when done, don't ask. |
| `needs-approval` | Always block on a human. |
| `agent-judgement` | Agent decides at the gate — could this break something? Yes → block on you; no → merge. **Requires a recorded one-line rationale.** |

### 1.4 Removing an item — `delete_item`

**It is called delete and it never deletes.** Nothing leaves the database; the row stops being
*served*. No ordinary read returns it, no board column counts it, no parent derives its state from
it, and no repair pass will move it — unlike `cancelled`, which is a real outcome and correctly still
appears. Every inbound link and every attribution keeps resolving, which is the whole reason the row
is kept.

**Three reads still reach it, each on purpose.** `get_item` and `get_item_detail` resolve one **by
id**, which is what a stale link needs in order to land somewhere real and find its replacement;
`get_events` reads the append-only ledger, because the row is withheld from item reads rather than
erased from history, and the archive event carrying the reason is the most useful row in it. There is
no single predicate every item read passes through, so that guarantee is held by a *set* of call
sites agreeing — and a test enumerates the reads from the operation registry and drives each one, so
a read added later that serves an archived row fails on the day it is written.

**What it is for, and why `cancelled` does not cover it.** A cancellation records work that was
wanted, considered, and deliberately not done. A duplicate is not that, and neither is a row created
by accident: cancelling one records a decision nobody made, which leaves the record *wrong* rather
than merely cluttered. This fills that gap and nothing wider.

**Break-glass, and shaped to stay that way.** The steering lives in the refusals rather than in
documentation, because a caller reaching past `cancelled` is not reading the documentation:

- A **reason is required**, and one too short to name which duplicate or which accident is refused.
- Reasons **describing a cancellation** are refused by name, with `cancelled` named as the call to
  make instead. This is the refusal that actually fires.
- **Inbound references are surfaced first** — live children, and reviews that deferred findings into
  this item — rather than silently orphaned. Proceeding takes a second, explicit acknowledgement.
- `superseded_by` **should name the replacement** whenever there is one, because the common case has
  a survivor.

**It is exposed on every surface, including MCP.** Restricting it to one surface was considered and
is not available: §22 bounds waivers to operations no guard can reject, and this one refuses four
ways. It is also the weaker protection — the same caller holds a command line and an HTTP client, so
hiding one door relocates the call rather than preventing it, and costs the property that every
adapter refuses identically. The restrictions that survive being routed around are the refusals
above.

---

## 2. `assignments` — who is on it

One row per agent per item — role and ownership in the same record, so there is no second place for
either to be true.

| Field | Type | Meaning |
|---|---|---|
| `id` | `uuid` PK | |
| `item_id` | `text` → `items.id` | |
| `role` | enum | `orchestrator` · `builder` · `reviewer` · `visual-reviewer` · `scout` · `custom`. An enum so the common roles are the *same value* every time — free text lets `reviewer`/`Reviewer`/`review` coexist and every count undercounts. (`visual-reviewer`, not `visual` — that word already means a facet and a gate.) |
| `role_custom` | `text` null | Required iff `role = custom`. The escape hatch that stops a new role forcing a fork. **If a custom value recurs, promote it to the enum** — otherwise the fragmentation just moves one level down. |
| `holder_type` | enum | `person` · `agent`. **A manually-driven session gets an assignment too** — without one, supersession, liveness and cost rollup all stop working for exactly the tasks you did by hand. |
| `holder_id` | `text` | → `people.id` or `agents.name`, per `holder_type`. For an agent this is the crew name, which also gives log continuity. |
| `session_id` | `text` | The client's session identifier. **The index everything looks up by.** |
| `parent_session_id` | `text` null | Who spawned this one **directly**. The tree — what answers *"the builder died, what did it leave running?"* Null for a root. |
| `root_session_id` | `text` | Top of this session's tree; a root points at itself. Denormalised so "is this session part of the crew on item X" is one comparison, not a recursive walk. **Named `root`, not `orchestrator`** — a manual session with no crew is its own root and has no orchestrator. |
| `machine` | `text` | Which PC. Required for worktree paths to mean anything. |
| `pid` | `int` null | Process ID from the launcher. Liveness beats timeouts. |
| `branch` | `text` null | This agent's working branch. |
| `worktree` | `text` null | Path on `machine`. Meaningless without it. **The fact only** — whether it's dirty is derived by whoever picks it up (`git status`), never stored: a dirty flag is stale the instant it's written and has no good writer, since the agent that would set it is the one that died. |
| `liveness` | enum | `running` · `stalled` · `dead` · `superseded`. **Separate axis from `items.state`**, but a single axis in itself — see the two invariants below. |
| `superseded_by` | `text` null | The session that took over. Lets the rejection *name the holder* instead of failing blankly. `released_at` carries the when. |
| `claimed_at` | `timestamptz` | When ownership was taken. |
| `last_active` | `timestamptz` | Stamped by the hook on every tool call — free, no agent effort. |
| `released_at` | `timestamptz` null | Set on release, takeover, or death. Rows are kept, not deleted — this is `previous_sessions`. |
| `model` | `text` null | **The exact vendor model ID** — `claude-opus-5`, `claude-sonnet-5`, `claude-haiku-4-5` — never a friendly form like "opus". "opus" spans 4.6/4.7/4.8/5, so an abbreviated name pools materially different models into one scoring bucket *and* makes the run unpriceable. Storing the vendor's own ID also means a Codex ID drops in with no translation. |
| `effort` | `text` null | The literal effort value (`low`/`medium`/`high`/`xhigh`/`max`), never a paraphrase. |

**Uniqueness — narrower than it first looks.** Multiple agents work one item simultaneously (an
orchestrator *plus* a builder *plus* two reviewers), so neither `(item_id)` nor `(item_id, role)` is
correct. The only genuinely exclusive thing is **who is driving**:

```sql
CREATE UNIQUE INDEX ON assignments (item_id)
  WHERE role = 'orchestrator' AND released_at IS NULL;
CREATE UNIQUE INDEX ON assignments (item_id, session_id)
  WHERE released_at IS NULL;   -- one session can't hold two rows on one item
```

**Plus an application-level check that doesn't depend on `role` being set right:** a claim arriving with
a **different `root_session_id`** than the item's existing active assignments means a second crew has
appeared. Reject it and name the current holder — that's the supersession path.

**Claims must be atomic** (compare-and-set) or two machines can both win.

**Supersession — two invariants keep it a single axis:**

1. **You cannot supersede a `running` assignment.** Takeover requires `stalled` or `dead`, so "superseded
   *and* alive" never arises.
2. **After supersession, a rejected call is not activity.** Liveness freezes at `superseded`. Without
   this, a woken old session's next call would stamp `last_active`, flip it back to `running`, and the
   value would contradict itself — the exact conflict that made this look like two axes.

The call is rejected *with an explanation* — who took over and when — not a bare failure.

**Reclaiming a stranded claim — lazily, at contention.** A claim is an `INSERT ... ON CONFLICT DO
NOTHING` against the indexes above, so a session that claims an item and then dies holds it forever:
every later claim conflicts with a row nothing will ever release. Deriving that the holder *looks*
dead frees nothing on its own — something has to perform the release, and that is the only reason a
deployment ever needed a scheduler for this. So **`claim` itself evicts**: when it is refused because
somebody already holds the item, the holder is judged, and if the evidence says it is gone its row is
released and the claim retries. The check then happens exactly when the answer matters. `sweep` and
`takeover` both stay reachable and unchanged; the lazy path only covers the unattended case.

> **⚠️ The liveness signal this rests on is weaker than the `last_active` row above claims.** That row
> says "stamped by the hook on every tool call", and **nothing stamps it except the `heartbeat`
> operation** — which agents are told is "usually unnecessary, the hook does it". The hook does not. Likewise `liveness.stale_after_seconds` describes itself as the fallback for
> "when a process check cannot answer", and **there is no process check**: nothing consults the OS
> about a holder's pid, and `registered_processes` holds processes an agent *started*, not the agent.
>
> So a session that claims an item and then legitimately works for half an hour is, on `last_active`
> alone, indistinguishable from one that crashed immediately. Two things follow, and both are
> deliberate: eviction reads the session's most recent `tool_calls` row as a **second, independent**
> liveness signal (written by a different mechanism, and the one that actually moves), and
> `liveness.evict_after_seconds` defaults to **four hours** rather than reusing
> `dead_after_seconds`. It is biased towards leaving a stranded claim stranded — that is visible and
> fixable with `takeover` — over evicting a live builder, which loses uncommitted work silently.
> **When the hook starts stamping `last_active`, this threshold should come down.** The policy is
> written once, in `src/lib/claim-eviction.ts`.
>
> **Escalation still needs a push.** Everything above is reachable at contention because a *claim*
> is the thing that wants it. Escalating a blocked item is the opposite case — nobody is reading, by
> definition — so it has no contention point to hang off and remains a genuine reason to run `sweep`
> on a schedule.

**Ghost sessions have no assignment**, and that's what makes them ghosts: manual work on a task that
was never minted has nothing to assign to, so it exists only as `tool_calls` rows with a null
`item_id`. It still counts toward capacity when the planner allocates — the server just can't say what
it's for, so it's costed at a deliberately high baseline.

---

## 3. `events` — the ledger

One append-only stream for everything that happens — per-item history and the cross-item "what
changed while I was away" view are the same rows, sliced differently. Queried for slices, never
dumped whole.

| Field | Type | Meaning |
|---|---|---|
| `id` | `bigserial` PK | Also the cursor. |
| `tx_id` | transaction id | The transaction that wrote the row, defaulted on insert. **A cursor alone is not enough to read this table exactly once.** Sequence values are handed out *before* commit, so sequence order is not commit order: a transaction holding id 100 can commit after one holding 101, and a reader doing `id > since ORDER BY id` at that moment advances past 100 and never sees it. Anything that must not skip a row — wait-for-crew, §19 — bounds itself to rows whose writing transaction has finished, and orders by `id` inside that set, where the order is both stable and complete. Cost: a row is held back until the oldest transaction concurrent with it finishes, which is milliseconds unless something holds a long transaction open — a reason for the importer to commit in batches, and a reason to make the horizon's age observable. |
| `item_id` | `text` null → `items.id` | Null for system-level events. |
| `ts` | `timestamptz` | |
| `actor_type` | enum | `person` · `agent` · `system`. |
| `actor_id` | `text` null | → `people.id` or `agents.name` depending on `actor_type`. Null for `system`. |
| `session_id` | `text` null | |
| `assignment_id` | `uuid` null → `assignments.id` | Set on `checkpoint` and other per-agent events. |
| `body` | `text` null | Prose for `checkpoint`, `note`, `nudge`, `escalation`. **A column, not payload** — slice reads on the hottest path would otherwise drag text nobody asked for, and it's cheap to exclude here. |
| `headline` | `text` null | **The one-line BLUF beside `body`** — what changed, in one line. Set on a `checkpoint`, whose prose is free text with no structure, so *"where is this up to?"* would otherwise mean reading every checkpoint on the item in full: the most-asked question of in-flight work, and the most expensive to answer. A column, not a payload key, for the same reason `body` is one, and the sharper case of it — the whole point of a headline is being readable *without* the prose, which a key on the same jsonb document cannot be. Optional: a checkpoint that records only prose is still a checkpoint, and making the cheapest durable-progress signal in the system more expensive to write is the wrong direction. Capped at 200 characters in the service layer, because a one-line BLUF that may be a paragraph is not one. Reads fall back to the prose's first line when it is null, so a checkpoint written without one is still answerable. |
| `type` | enum | `field-change` · `state-change` · `claim` · `release` · `takeover` · `review-requested` · `review` · `merge` · `dispatch` · `dispatch-claimed` · `checkpoint` · `nudge` · `escalation` · `note` · `setting-change`. An enum, not text — a typo would silently create a phantom event class that every count then misses. `note` is the escape hatch, so no `custom` is needed. **Postgres can't remove an enum value**, so add one only when the code that emits it exists. That rule is enforced by `npm run check:event-emitters`, which fails on a declared value nothing writes; a value legitimately reserved ahead of its writer goes in that script's `KNOWN_UNEMITTED` with the milestone row that closes it. The check counts *write sites*, not reachable ones — a read path naming a type does not satisfy it, and neither does a writer nothing calls. `setting-change` is its own value rather than a reuse of `field-change`, which carries `{field, from, to}` about an *item* and has consumers that assume one; its payload is below, its posture is §17.8, and it is written by §19's `PATCH /settings`. |
| `payload` | `jsonb` | Type-specific. **A discriminated union keyed on `type`** — see below. |

*(No `state_at` here — it's derivable from the `state-change` rows in this same table, event volume is
low, and "what state was it in when this comment was posted" is rarely asked. `tool_calls` keeps its
copy for a reason that doesn't apply here — see §10.)*

### Payload shapes

Typed in the **service layer**, not the column. The service is the only writer, so a discriminated
union validated on write is enforced in practice — while the column stays plain `jsonb` and the ledger
stays a single queryable stream. A column per type would be a wide sparse table; a table per type would
turn `GET /events?since=` into a twelve-way union, killing the query the ledger exists for.

| `type` | `payload` |
|---|---|
| `field-change` | `{field, from, to}` |
| `state-change` | `{from, to, reason?}` |
| `claim` · `release` · `takeover` | `{assignment_id, role, holder_id}` |
| `review-requested` | `{round}` |
| `review` | `{evidence_id, verdict, round}` |
| `merge` | `{commit_sha, authority_used}` |
| `dispatch` | `{machine, account_id, estimated_cost}` — prompt in `body` |
| `dispatch-claimed` | `{dispatch_event_id, session_id}` |
| `checkpoint` | *(none — prose is in `body`, one-line BLUF is in `headline`, agent is in `assignment_id`)* |
| `nudge` | `{kind}` — text in `body` |
| `escalation` | `{to_person}` — reason in `body` |
| `note` | *(none — text in `body`)* |
| `setting-change` | `{key, from: {set, value?}, to: {set, value?}, batch_id}` — `item_id` is null |

**`setting-change` carries `{set}` rather than a bare `from`/`to` because JSON `null` is a legal
setting value** (§17.2): notifications off, retention forever. Without the discriminator, *"cleared
the override"* and *"set it to nothing"* serialise identically, and those are different acts —
`set: false` means "was at the registry default". `batch_id` is shared by every row one `PATCH
/settings` writes (§19), so a save of six values reads back as one human act rather than six
unrelated ones. Delivered by **#78**, with the posture that governs it in §17.8.

**When to lift a field out of the payload into a real column: only when it's queried *across* event
types, or when deriving it at query time is expensive at that table's volume.** Neither applies to
anything here — Postgres indexes jsonb expressions fine, and event volume is low. (`tool_calls.state_at`
is the one place the second test bites; see §10.)

**Every mutating call appends a row.** `field-change` is what makes that true for ordinary field edits —
priority, area, merge authority — which would otherwise vanish from the record. An edit that leaves no
trace is indistinguishable from one that never happened, so leaving these out would be a hole in the
ledger rather than a simplification. It also makes `updated_at` an index over the ledger rather than
an independent fact.

**Seen state is per person** — see `event_seen` in §8a. It cannot be a column here: one person marking something
read must not clear it for another.

---

## 3a. Open loops — a pair of events, not a table

The loose ends a session is carrying that are not themselves work items: *"the retry path is
untested"*, *"we never checked what happens on a cold boot"*. A resuming session needs to be told
about them, and there is nowhere else to put them.

**A loop is two events and a line of text.** It has no state machine, no assignee, no review and no
merge — the four things that make something an item here — so modelling it as one would put every
loose end on the board and into every count that ranges over items. It has exactly two moments, which
is the shape `events` already is:

| Type | Payload | Meaning |
|---|---|---|
| `open_loop` | `{loop_id, text}` | Something was left unresolved. |
| `open_loop_closed` | `{loop_id}` | It has been resolved. |

**`loop_id` is a correlation key supplied by whoever opens the loop, never derived from the text.**
Deriving it would make closing a loop depend on quoting its wording back exactly, and would silently
merge two genuinely different loops that happened to be phrased identically. The closing event does
not repeat the text: the opening event carries it, and a second copy is a second thing that can
disagree.

**A `loop_id` may be used once per item, ever — not once at a time.** Reuse is refused at the write
even for an id whose loop was closed, and the reason is the fold below rather than tidiness: it
collects every close into a set over the whole stream and filters every open against it, with no
pairing and no ordering, so **one close suppresses every open of that id, past and future**. An id
reused after its loop closed would therefore write a row, return success, and produce a loop that
`orientation` never reports and that nothing can close — invisible and unclosable, which is strictly
worse than the duplicate it looks like. Supporting reuse would mean pairing opens to closes in
sequence, and that is the one thing the fold cannot do (see order-independence below). Ids are
cheap: `loop_add` mints one when the caller does not supply it, so the cost of this rule is nothing
and the cost of the alternative is a class of loop nobody can see or clean up.

**Whether a loop is open is derived, never stored** (§13a — store facts, derive volatiles). It is
every `open_loop` whose `loop_id` has no `open_loop_closed`, folded at read time. So closing a loop
appends a fact rather than marking anything: there is no row to update, and the ledger stays
append-only.

That fold is **order-independent by construction** — the closes are collected first, then the opens
filtered against them. This is not fastidiousness: `events.id` is allocated before commit (§3), so a
read can legitimately return a close before its own open, and a single-pass fold that only cancelled a
loop it had already seen opened would report a closed loop as open in exactly that case.

**The read and write paths deliberately disagree about malformed input, and the asymmetry is the
design.** The write path validates and refuses: a loop whose id is missing can never be closed, so
accepting one would write a permanently-open loop into the ledger, and a close naming a loop that is
not open is a caller mistake that would otherwise land as an inert row. The read path skips what it
cannot parse and ignores a close for a loop it never saw opened — it reads a bounded slice, the
opening event may simply be older than the window, and one bad row written at any point in history
must not make *"catch me up"* permanently unusable for that item. A refusal at the write costs one
caller a clear error; a refusal at the read costs every future session.

**Why this is not `summaries.not_done`.** That field is one-to-one with an item and written only at
completion, so an item still `executing` — the state in which it is *most* likely to be carrying a
loose end — could not record one at all. `orientation` reports both, alongside actionable children, as
three sources of the same question.

---

## 4. Checkpoints — an event type, not a table

**No `checkpoints` table.** A checkpoint is `events` with `type = 'checkpoint'` and `assignment_id` set.

The surviving satellite tables each have a *structural* reason to exist — `artifacts` is referenced by
transition guards, `summaries` is 1:1 and heavily validated. Checkpoints have none: append-only,
referenced by nothing, no cardinality rule. They are a thing that *happened*, which is what `events` is
for. (`comments` failed the same test later and was cut too — §7.)

- **Per agent, not just per item** — `assignment_id` carries that, so a stalled builder still has its own
  resume point.
- **A headline, beside the prose.** `events.headline` (§3) carries the one line that answers "where is
  this up to" without reading the checkpoint. This is what the board card and the item detail show
  without expanding, and what a slim item read carries so the question costs one indexed row rather
  than the whole history. A checkpoint written without one falls back to the first non-empty line of
  its prose — which is where a writer of a BLUF-shaped checkpoint already puts it — so the read is
  useful over checkpoints recorded before the field was askable, not just over new ones.
- **Latest is `WHERE type='checkpoint' AND assignment_id=A ORDER BY ts DESC LIMIT 1`**, indexed. No
  `is_latest` flag: that would mean writing the *previous* row on every insert — a second write, a race,
  and guaranteed drift, to save an index lookup.
- **Orientation gets simpler**: "latest checkpoint plus everything since" is one query over one table
  rather than two joined on a timestamp.

**Cost, stated:** `events WHERE type='checkpoint'` is one step less obvious than a table called
`checkpoints`. That's the whole downside.

---

## 5. `summaries` — the closing summary

1:1 with an item. **Required to enter any `completed` state.**

| Field | Type | Rule |
|---|---|---|
| `item_id` | `text` PK → `items.id` | |
| `shipped` | `text[]` | 1–5 entries, ≤120 chars each. Outcomes, not steps. |
| `not_done` | `jsonb` | 0–5 typed entries — see §5a. **Must be present** — an empty array you wrote is an assertion; a missing field is an oversight. |
| `user_facing` | `bool` | **Forces the branch below** so neither case can be skipped. |
| `what_to_test` | `jsonb` null | **Required iff `user_facing`.** 1–3 entries of `{text, link?}`. Each is one concrete thing to do and check, physical actions included — *"turn on the lights and check the TV comes on"*. `link` is optional per step: plenty of changes have no address, and where there is one, keeping it separable lets the UI render a tappable button beside the step rather than an inline link buried in prose. **No separate location field** — for anything without a URL, *where to go* and *what to check* aren't separable concepts. |
| `how_verified` | `text` null | Required iff **not** `user_facing`. What was run and **observed live**. |
| `watch_for` | `text[]` | 0–3. **Only risks that could not be verified now** — *"only shows up under load"*, *"the first weekly run will tell us"*. If it could have been checked, it belongs in `what_to_test` or `how_verified`; if it needs work, it's a `not_done` follow-up. Explicit empty is fine and is the common case. **The one summary field with no structural check** — so the narrow definition is what stops it filling with *"monitor for unexpected behaviour"*. |
| `final_state` | `jsonb` | **Derived, never authored** — commit, branch, deploy target, merged_at. |

**Static validators, no model in the loop:**
1. Count and length caps — **reject, never truncate**.
2. No entry ≥85% similar to any `events` row for this item (kills the log-paste).
3. **Jargon denylist** on human-facing fields — the vocabulary of the system rather than of the work: internal command names, raw field identifiers (`owner=`, `review_round`), review shorthand (`LGTM`, `fail-open`), bare cross-references (`§n`, `#n`, `PR-n`), script filenames, ALL-CAPS prefixes.
4. `how_verified` may not consist *solely* of a CI/test reference.

### 5a. `not_done` — deferral must be proved, not explained

"The explanation must be good enough" can't be graded as prose without putting a model in the server.
So the standard is inverted into something checkable:

> **If you're deferring work, prove it's actually blocked.**

Each entry is `{ text, reason, item_id? }`:

| `reason` | Requires | Rejected when |
|---|---|---|
| `follow-up` | A **minted `item_id`** | That item is **actionable** — not `blocked` and not `paused`. Completion fails with *"this follow-up isn't blocked; go do it."* |
| `follow-up-scheduled` | A minted `item_id` that is **scheduled** and a **sibling** | That item is closed, `someday`, `blocked`/`paused`, or a **descendant** of the item being completed |
| `needs-approval` | A minted `item_id` that is `blocked` with `blocked_on_type = person` | The linked item isn't actually blocked on someone |
| `descoped` | Nothing — no work is being deferred | — |

`descoped` is the tiny-and-benign case: a deliberate decision not to do something, recorded as a
decision rather than a failure.

**`follow-up-scheduled` is the other half of `follow-up`, not a softer version of it.** `follow-up`
proves deferral by requiring the linked item to be **stopped**: if the work were startable, nothing
would be stopping you doing it. That is right for *"something is in the way"*, and it stays exactly
as strict. It is the wrong test — unsatisfiable, in fact — for the outcome §17 of `DECISIONS.md`
calls correct: a review raises findings that are real but not blocking, the change merges, and the
findings become a **sibling** item that is open and ready to pick up. Open and ready is actionable,
which `follow-up` refuses, so the endorsed shape was the one shape that could not be recorded — and
the observed response was to drop `not_done` and write the deferral into `watch_for` as prose,
losing exactly the machine-readable link this field exists to keep.

So the second reason asks for the **mirror** proof: not that the work is stopped, but that it is
**live** — a real open row, and a sibling rather than a descendant. The two reasons accept disjoint
sets of linked states, so neither is a route around the other.

**Each reason has to charge a real price, or it becomes the cheap way out.** `follow-up` charges by
demanding the linked item be `blocked` or `paused` — and `blocked` demands a reason and a
`blocked_on_type`, so faking it lands the work on somebody's needs-you list and makes it *more*
visible. `follow-up-scheduled` charges by demanding the linked item be genuinely **scheduled**:
`someday` is refused, because it is the one state whose meaning is *unscheduled*, and accepting it
would let *"I will get to it"* complete cleanly while making the reason's own name false.

**The two prices are not equal.** A false `blocked` costs a reason, a `blocked_on_type`, and a place
on somebody's needs-you list. Refusing `someday` costs a positive assertion that the work is queued —
which is real, because it is a claim someone can disagree with and it lands in a permanent record,
but lighter, since a newly minted item already sits in an accepted state and `someday` and `on_deck`
render in the same board column. Recorded here rather than smoothed over: a design that claimed
parity would be claiming more than it delivers.

**This is a widening, and it is recorded as one.** Mutual exclusivity between the two follow-up
reasons is not on its own a guarantee; the question is whether their *union* covers "later", and the
`someday` exclusion is what keeps it from doing so. The comparison that justifies the trade is not
against a perfect version of this rule but against what was actually happening: the endorsed shape
had no representation, so deferrals were being written into `watch_for` as prose — costless,
requiring no false statement either, and with the machine-readable link destroyed. A priced,
checkable, linked path is better than that. It is still less airtight than three reasons were, and
saying so here is cheaper than letting a future reader discover it.

**The sibling requirement is enforced, not advised.** A follow-up parented *under* the item being
completed asserts that the item is not finished without it, which contradicts completing it — and an
open descendant already blocks the completion through the hierarchy rule below. Refusing it here
names the actual mistake (the follow-up is inside the work instead of beside it) rather than leaving
the caller to infer it from a hierarchy rejection that never mentions `not_done`.

**The rejection message is the mechanism, not decoration.** A bare validation error teaches an agent to
satisfy the check; the rejection should ask the question instead:

> *"You're deferring this, but nothing is blocking it. Is there a good reason you didn't just do it now?
> If not, go back to `executing` and finish it."*

**And the obvious way to game it self-surfaces.** An agent could mark the follow-up `blocked` to get
past the check — but `blocked` demands a `blocked_on_type`, and if that's a person, the item lands on
that person's needs-you list. A false block makes the work **more** visible, not less. The enforcement
fails loudly rather than silently, which is the property you want when the check is beatable.

**The same test extends up the tree:** an item cannot complete while any **child** is actionable — every
child must be completed, blocked or paused. Otherwise a parent goes "done" with live subtasks under it.

---

## 6. `artifacts` — things produced

**Renamed from `evidence`.** The table holds *things* — a plan document, a review, a screenshot, a
commit. "Evidence" is a **role an artifact plays** when a guard points at it, not what the table is.
Naming it for the role broke the moment a plan doc needed a home. The gating rules live in §16, which
is already the place that says which transitions require what.

| Field | Type | Meaning |
|---|---|---|
| `id` | `uuid` PK | |
| `item_id` | `text` → `items.id` | |
| `kind` | enum | `plan` · `plan-review` · `code-review` · `visual-review` · `test-run` · `commit` · `pull-request` (§6a-pr) · `historical-verification` (§6b) · `merge-override` (§6c) · `screenshot` · `other`. The **thing** and its **review** are separate rows — as `commit` and `code-review` already were, so `plan` and `plan-review` follow the same shape. |
| `verdict` | enum null | `approved` · `changes-required` · `n/a`. Null on artifacts that aren't reviews — a plan document has no verdict; its `plan-review` does. |
| `review_round` | `int` | Which round this belongs to. |
| `commit_sha` | `text` null | What it applies to — the "at tip" check. |
| `supersedes_sha` | `text` null | On a `commit`, the sha this one REWRITES — a squash, a rebase, an amend (§6d). Null on everything else, and null by default: what makes the "at tip" check satisfiable when the forge rewrites the commit, without widening it for a commit that carries new work. |
| `body` | `text` null | Review text, stored inline: queryable, survives a repo move. |
| `ref` | `text` null | Path or URL for binaries (screenshots), and the PR's URL on a `pull_request`. |
| `browser_session` | `text` null | Which browser session a visual review ran in. An opaque string — the core never learns that any browser-automation tool exists. |
| `created_by_type` | enum | `person` · `agent`. A review by a person and one by a reviewer agent are both evidence. |
| `created_by_id` | `text` | → `people.id` or `agents.name`, per `created_by_type`. |
| `created_at` | `timestamptz` | |

---

### 6a-pr. `pull_request` — the link the progress report will not invent

`progress_report` (MILESTONES.md #136) renders each row's reference as a **link to the open pull
request**, falling back to the branch and then to the item id. The link is the half that makes a row
actionable: *"in review, branch `feat/whatever`"* still leaves a reader to go and find the PR.

**The obvious cheap implementation is wrong, and not repairably so.** The report already holds
`Item.repo` and `Item.branch`, so a URL could be composed from them with no schema change and no
write. But the branch is present in *all three* of the cases a reader needs told apart — the PR is
open, the PR was closed unmerged, nobody ever opened a PR — so a composed link would render
identically for all three and be live for only one. It would also have to guess a forge: `Repo.host`
is nullable by design (unknown is a distinct state from a guess) and nothing records which forge a
host runs or how it spells a pull-request path. **A link that 404s is worse than the branch name it
replaced**, because a reader who clicks a dead link stops trusting the links that work.

So a PR is a recorded fact: an artifact of kind `pull_request` whose `ref` is the URL, written by
whoever opened it — at the one moment the URL is in hand and free to record.

Three properties keep the promise that no dead link is ever emitted:

1. **The URL is refused at the write if it is missing or not `http(s)`.** `ref` is a generic column
   shared with screenshots, so a path, a bare PR number or a sentence are realistic values. A
   markdown link to a `javascript:` or `data:` target is also an injection into whatever renders the
   report, from a string that arrived over the API.
2. **Closure is a NEWER row, never an edit.** `artifacts` is append-only — the merge gate's "at tip"
   reasoning depends on it — so a PR that closes is recorded as another `pull_request` artifact
   whose `body` is `closed`. The report reads the newest row per item and links only when it says
   `open`. Every PR an item ever had survives underneath, in order, so re-proposed work reads
   correctly: open, closed, open again.
3. **The status vocabulary is two words and is enforced at the write.** `open` · `closed`. Coercing
   unrecognised prose to `open` is exactly how a closed PR keeps rendering as a live link — a caller
   recording `"closed by review"` would read as open. The *read* is deliberately more forgiving
   (unrecognised prose reads as `open`), because rows written before this vocabulary existed cannot
   be refused retrospectively and one legacy row should cost one link, not the whole report.

`merged` is deliberately not a status. A merged PR's item reaches `merged` on its own, and a link to
a merged PR is still a live link — so it would be a third value that no reader branches on
differently from `open`.

**Why a kind rather than a column on `items`.** A PR is a thing produced for an item, by a known
actor, at a review round — which is what this table is for. A column would hold one URL, silently
lose the previous one when work is re-proposed, and carry neither author nor timestamp.

---

### 6b. `historical_verification` — closing work that finished before this installation existed

Entering `merged` requires an approving `code_review` at the item's current review round and tip
commit. That is right for a change being proposed, and it is the only thing standing between
unreviewed code and a board that says the code was reviewed. It has **no truthful answer for work
that already shipped** under a process this installation did not run: there is no reviewer who could
have written that artifact, because there was nothing to review it in.

**The failure mode is a forged approval, and it should not depend on good manners.** An agent facing
that refusal can record a `code_review` with an approving verdict and close the item in one call, and
nothing in the product can tell that apart from a real review — a forged review is identical to an
honest one in kind, in verdict, and in every column a reader sees. The gate's whole value then rests
on an agent declining to do the cheap thing, and the pressure to do it is highest exactly where the
approval would mean least.

So the merge gate accepts an artifact of kind `historical_verification` as an **alternative
satisfier** for the code-review clause. Four properties bound it, and none of them carries the
argument alone:

1. **The window cannot be opened from inside.** It is an environment variable checked fail-closed, so
   nothing reachable over HTTP, MCP or the command line can turn it on for itself. While it is shut
   this path does not exist and the gate behaves exactly as it does without it. The window is
   announced at startup, for the same reason the import window is: the realistic failure is opening it
   for one cleanup, being interrupted, and leaving it open.
2. **It is not a review and cannot be read as one.** This does not make fabrication impossible — an
   agent willing to forge a review will forge an inspection. What it buys is that the fabrication is
   *visible*: an item closed this way is permanently marked as closed-on-inspection, in its artifact
   list, in its closing summary's `final_state`, and by the absence of a `review` event. The cheap
   path leaves a trace, which is precisely what an approving verdict recorded on the review path
   does not.
3. **The claim has to be checkable.** A verdict is a judgement and cannot be audited; an inspection is
   a set of facts and can be. The artifact is refused at the write unless it names the commit it was
   checked against and records what was inspected, so a later reader can confirm or refute it. A claim
   someone can be publicly wrong about is a different kind of thing from an unfalsifiable approval.
4. **It never satisfies authorisation.** `merge_authority` of `needs_approval` is enforced by a
   separate clause reading `kind = 'code_review' AND created_by_type = 'person'`, untouched by this.
   The window widens what counts as review **evidence**, never what counts as **authorisation**.
   Defended twice: a verdict is refused on this kind at the write, so the clause's approving-verdict
   filter excludes it even before the kind scope applies.

**It also cannot dissolve an obligation a review already created.** `merge.requires_linked_followup`
resolves the approval it reasons about by **round and tip**, so an honest `lgtm_with_followups` stops
qualifying when either moves — and `max(review_round)` spans every artifact kind, so a verification
recorded at a higher round demotes that review by itself. What made this harmless without an
alternative satisfier is that the same non-qualification refused the merge outright; satisfying that
clause by another route removes the backstop. So the verification path re-checks the bargain at its
own source and refuses while it is unhonoured. An inspection may stand in for a review that was never
possible; it may not discharge a promise a review that *did* happen made.

**The check asks whether an unhonoured bargain exists anywhere on the item, not whether the newest
approving review carries one** — and the difference is reachable with one ordinary call. Recording a
review does not check its `commit_sha` against the tip, so a *deliberately stale* plain approval can
be written: too stale to satisfy any merge clause itself, but newest by creation time, and therefore
able to answer "nothing deferred here" on behalf of an unhonoured bargain recorded before it. An
obligation may only be retired by a review with standing to retire it — strictly newer, approving,
and qualifying at the current round and tip, which is the same bar the merge rests on.

**Scoped to the tip commit, not to the review round.** The artifact must name the item's current tip,
so an inspection cannot silently carry across to later code — the claim is "I read what is actually
there". Round is deliberately not required: `max(review_round)` spans every artifact kind, so
requiring a match would let an artifact recorded at a higher round invalidate an honest `code_review`
on a live item. An inspection of merged code is not part of a review conversation and is not scoped
to one.

**What was deliberately not used as the gate.** Keying this to a property of the row — that it arrived
through an import — was rejected twice over. The obvious markers (`origin_type`, a `legacy_id` in
`custom_fields`) are caller-supplied through the ordinary create path, so gating on them would rest
the protection on a value the caller writes. And even an unforgeable column would grant a permanent
second merge path to a permanent class of rows, still standing long after one of those items has been
reopened and worked on live. A window is bounded by construction and expires by being closed.

---

### 6c. `merge_override` — the judgement call, recorded rather than waved through

`historical_verification` (§6b) answers "this shipped before we existed". Two other things were
arriving at the same refusal and neither was that, so both were being answered by forging a review.

**The first was not strictness — it was a check no honest caller could pass.** See §6d: under a
squash-merge workflow the review-at-tip requirement is unsatisfiable in either ordering. That is a
bug and it is fixed as one, in §6d. **It deliberately does not consume an override.** An escape
hatch reached daily stops being read, and routing a structural defect through it would have buried
the defect under a pile of "reasons" nobody audits.

**The second is a genuine judgement call**, and it is the only thing this kind is for: *nothing
material changed since the review, so the review still stands*. A doc tweak after approval, a lint
fix, a rebase onto a moved base. The reviewer's judgement really does still apply, no rule can
establish that it does, and a person can see it in a second.

So the merge gate accepts an artifact of kind `merge_override` as an alternative satisfier for the
code-review clause. Four properties bound it:

1. **It is a row, not a request field.** The cheap implementation is a `merge_override_reason`
   passed alongside the transition, as `merge_rationale` already is. Rejected: `fields` on a
   transition is read by the guard that wants it and then **discarded**, so the reason would exist
   only inside the refusal that did not happen. An override nobody can read afterwards is a silent
   bypass with a conscience. An artifact is durable, attributed, timestamped, and appears in the
   item's detail view beside the reviews it stood in for.
2. **The reason is mandatory, and checked for content rather than presence.** `record_artifact`
   refuses a `merge_override` with no `commit_sha`, with no `body`, or with a body under
   `MIN_REASON_LENGTH`. A required field satisfiable by `"x"` is an optional field with extra
   keystrokes. The floor is a crude proxy and does not pretend to detect a *considered* reason —
   what it removes is the dismissal, which is the shape a mandatory field collapses into when
   nothing checks it.
3. **It is scoped to the commit it excuses**, and its lineage (§6d) — never to the item. An override
   is a statement about one specific state of the code; a standing one would be permission to skip
   review forever, which is a different and far worse thing than what was asked for.
4. **It never satisfies `merge_authority = needs_approval`.** That clause reads `kind = 'code_review'
   AND created_by_type = 'person'` and is untouched. This widens what counts as *review evidence*,
   never what counts as *authorisation* — the same boundary §6b respects.

**No environment window, unlike §6b, and the difference is deliberate.** That window gates a one-off
event, so a permanent capability would be a permanent second merge path. This serves a judgement
call that recurs, at low volume, forever: a window would be opened and then left open, which reads
as a control while being permanently disarmed. The control here is that **every use is a countable
row with a name on it** — "how often is this installation overriding its own merge gate, and on
whose authority" is one query against one `kind`. That is a real control precisely because it does
not depend on anyone remembering to close anything.

**Never readable as a review.** Its own `kind`, carrying no `verdict`, for the reason §6b gives:
a flag on `code_review` would be a distinction every existing reader ignores by default.

### 6d. `supersedes_sha` — why review-at-tip was unsatisfiable under squash-merge

`artifacts.supersedes_sha` records, on a `commit` artifact, the sha this commit is a **rewrite of**
— set when the commit carries already-reviewed work under a new identity rather than new work. A
squash merge, a rebase, an amend.

**The defect.** Entering `merged` requires an approving `code_review` at the item's tip commit, and
the tip is the newest `commit` artifact's sha. Under a squash merge those two facts cannot both be
satisfied, in either order:

- Record the squash commit, and the tip becomes a sha the review does not name — the review was
  recorded against the branch tip, the only sha in existence when it happened. Refused as stale.
- Do not record it, and `merge.requires_commit` refuses instead.

The squash sha **does not exist until the merge happens**, so "get it reviewed at the tip commit"
names something unreviewable. There is no ordering that satisfies the gate. Worse, it refused
identically whether a byte of the tree had changed or not — and a squash rewrites the commit object
while leaving the tree identical. That is not staleness detection; it is a check no honest caller
can pass, and its observed effect was to train callers to record an approval nobody gave.

**Why a recorded link rather than asking git.** The obvious fix — "accept an approval whose sha is
an ancestor of the tip" — is not available and would not work. The service has no clone and no
network path to one; and a squash commit is **not a descendant** of the branch it squashed, so
ancestry would not answer this even with a repository to ask. Comparing trees has the same problem
twice over. So the link is a recorded fact, supplied by the caller that performed the merge and
therefore the only party that knows both shas — the same shape every other evidence column here
takes.

**Why this does not widen the gate.** The guard builds the set of shas the tip stands in for by
following `supersedes_sha` links, and an approval qualifies if it names any sha in that set. The set
contains **only** shas that a `commit` artifact explicitly declared its own sha to be a rewrite of:

- A commit recording genuinely new work sets nothing, contributes nothing, and invalidates earlier
  approvals exactly as before — which is the case the guard exists for.
- Only `kind = 'commit'` can extend the chain. A review carrying the column has no standing to
  assert that one sha replaced another.
- The column is nullable with no backfill, so every pre-existing row keeps precisely the meaning it
  had, and the new behaviour is opt-in per artifact.
- The walk is bounded and keeps a visited set, because the chain is caller-supplied and a cycle must
  not hang the transaction that decides a merge.

It carries a **real** approval forward onto the sha that reviewed code actually landed as. It never
invents one: with no approval at the superseded sha, nothing is carried and the gate refuses exactly
as before.

---

## 7. Comments — cut

**No `comments` table.** It was a Jira/Linear convention imported without testing it against the actual
workflow, and it earns nothing:

- **Timestamped remarks** are already `events` with `type = note` — who said it, when, on which item.
  The only thing a comments table added was *editability*, which is a reason for it to be separate, not
  a reason for it to exist.
- **Durable instruction for whoever picks this up next** belongs in `items.body`, the brief — which
  orientation shows first, where a comment would have to be hunted for.
- **Discussion** was never really on offer: neither design has threading. If it's wanted later it comes
  back with replies designed in, rather than a degenerate flat version bolted on now.

---

## 8. `authorizations`

Standing grants as rows rather than prose, so the question that matters is a query rather than a
read: *"is there a standing auth covering this?"*

| Field | Type | Meaning |
|---|---|---|
| `id` | `text` PK | |
| `granted_by` | `text` → `people.id` | **Who granted it.** Missing before — an authorisation with no grantor is unauditable, and one person can authorise work another can't speak for. |
| `granted_at` | `timestamptz` | |
| `expires_at` | `timestamptz` null | Null = no expiry. |
| `revoked_at` | `timestamptz` null | |
| `scope` | `jsonb` | What it covers — areas, repos, transitions. |
| `grant_text` | `text` | What you actually said. **Not `text`** — a column named after its own type reads terribly in every query. |

---

## 8a. `people` — profiles, not accounts

Netflix-style profile picker on first load; the choice lives in the browser and is changed from an
icon in the top bar. **This is a claim, not a credential** — there is no password, and anyone who can
reach the app can pick any profile. It exists so the record can say *who did this*, not to control
*who may*. Access control, if it's ever wanted, is a separate concern layered on top.

| Field | Type | Meaning |
|---|---|---|
| `id` | `text` PK | `user-a`, `user-b`. Stable, used in every attribution column. |
| `display_name` | `text` | Shown on the picker and in the UI. |
| `avatar` | `text` null | Image reference or an emoji. |
| `colour` | `text` null | For the picker tile and attribution chips. |
| `notify_rules` | `jsonb` null | Standing notification rules, same shape as `items.notify` — see §1.1b. Where the *"anything in web that completes"* kind of rule lives. |
| `created_at` | `timestamptz` | |
| `archived_at` | `timestamptz` null | Archive rather than delete — attribution rows still point here. |

Seeded with two rows. Nothing in the schema is capped at two.

## 8b. `event_seen` — per-person read state

| Field | Type | Meaning |
|---|---|---|
| `event_id` | `bigint` → `events.id` | Composite PK with `person_id`. |
| `person_id` | `text` → `people.id` | |
| `seen_at` | `timestamptz` | |

Since-your-last-visit is `events LEFT JOIN event_seen` for the current profile. Unseen for one profile and
seen for another is a normal, expected state.

## 9. `agents` — registry and names

| Field | Type | Meaning |
|---|---|---|
| `name` | `text` PK | Assigned, never self-chosen — names appear throughout history. |
| `role_hint` | `text` null | Which role pool this name belongs to. |
| `persona` | `text` null | The charming bit. |
| `retired_at` | `timestamptz` null | |

**No `in_use` flag** — it's "does any assignment hold this name with `released_at IS NULL`". A stored
copy needs clearing on every release, including releases that happen via takeover or death.

**Assigned automatically, not requested.** A session is drawn a name (or keeps the one it already
holds) when it registers (§21) and again — for an agent holder specifically — when it claims (§18);
neither call requires the session to ask for one separately. Assignment is atomic under concurrency:
`UPDATE ... WHERE name = (SELECT ... FOR UPDATE SKIP LOCKED LIMIT 1)` picks and locks one available
row in a single round trip, so two sessions racing for the last name can never both win it.

---

## 10. `tool_calls` — telemetry

The highest-volume table and the foundation for everything measured. Written by the hook; zero agent effort.

| Field | Type | Meaning |
|---|---|---|
| `id` | `bigserial` PK | |
| `session_id` | `text` | Always present. |
| `assignment_id` | `uuid` null | Null for a **ghost session** — real work with no minted task. |
| `item_id` | `text` null | Same. |
| `ts` | `timestamptz` | |
| `tool` | `text` | Tool name. |
| `command` | `text` null | For shell tools. Enables repeat detection **and** duration learning. |
| `paths` | `text[]` null | What it touched. Path spread is a progress signal. |
| `state_at` | state enum, null | Item state at the time. **Denormalised deliberately** — it's derivable from `events`, but only via a correlated lookup *per row* on the largest table here, and slicing cost by stage is the whole reason this column exists. Null for ghost sessions, which have no item. ⚠️ **Resolved at ingest, so it is the state at flush, not at the call.** The client spools and flushes in batches, and the server stamps whatever state the item is in when the batch arrives. The error is bounded by the flush interval and is zero for a session flushing while it still holds the item — but a consumer slicing cost by stage should read this column as "the stage this work was attributed to", not as an exact per-call reading. Making it exact means the per-row `events` lookup this column exists to avoid. |
| `input_tokens` | `int` | |
| `output_tokens` | `int` | Prices ~5× input — never fold into a single total. |
| `cache_write_tokens` | `int` | 1.25× (5-min TTL) or 2× (1-hour). |
| `cache_read_tokens` | `int` | 0.1×. |
| `usage_5h` | `numeric` null | Snapshot carried by the hook — keeps the server's budget picture fresh without it holding credentials. |
| `usage_weekly` | `numeric` null | Same. |

**Retention** configurable, off by default. Volume is small — tens of thousands of rows per busy week.

**Shape, as distinct from cost.** `runs` and the aggregation over it answer what a session *spent*.
The same rows also answer what it is *doing* — whether it keeps returning to a command, how many
distinct files it has touched, and how much of its work is reading rather than changing. A session can
be cheap and stuck or expensive and going fine, and no token count separates those two, which is why
this read exists beside the cost rollup rather than inside it.

It is exposed as a **judgement with the number attached** (`unknown` · `normal` · `elevated`, plus what
was counted) rather than as raw figures, because its consumers act rather than display: acting on a
number means knowing what is normal for it, and every consumer left to decide that separately decides
it differently. The thresholds are `shape.*` in §17. `unknown` is a real answer, not a failure — it is
what too little evidence returns, and it is distinct from `normal` so that a consumer treating them
alike has chosen to.

**Repeat detection counts returns, not attempts.** A command run and immediately re-run is a retry
loop — a session working, and the most ordinary thing an agent does — so a consecutive run counts once
however long it is. Only a command returned to *after another command ran in between* counts again.
Reading and editing between two runs do **not** break the run: the canonical retry loop is `npm test`,
fix, `npm test`, and the fix is an `Edit`, so counting that as a return would fire on the very shape
this is defined to exempt.

**Only `Bash` calls are compared.** `command` is populated for every tool — the hook fills it from the
first of `command`, `file_path`, `filePath`, `path`, `pattern`, `url`, so a `Read` stores its file path
there — which is correct for the hook's own pattern matching but is a path, not a command. Comparing on
it makes "touched this file again" read as "returned to this command", and the signal stops
discriminating: against the shipped defaults an ordinary working session and a genuinely stuck one both
land far above the threshold. A truncated command (§10's caps) is never compared: two different long
commands sharing a prefix are stored byte-identically, and a repeat reported from that did not happen.

---

## 11. `runs` — one agent's turn on one item

Rollup over `tool_calls`, so scoring never scans the raw log.

**A run is bounded by `(assignment, model, effort)`.** A mid-session model or effort change **closes the
current run and opens a new one** — because `run_scores` grades a run against a specific model at a
specific effort, and a run spanning two models attributes the score to a blend, which is precisely the
noise the picker exists to remove.

This requires **the hook to report model and effort on every call**, or a `/model` switch is invisible
and the run silently spans both. They aren't stored on `tool_calls` — two strings on ~450k rows a year
buys little, since `started_at`/`ended_at` already bound which calls belong to a run. The server
compares each report against the open run and cuts a new one when it differs.

| Field | Type | Meaning |
|---|---|---|
| `id` | `uuid` PK | |
| `item_id` | `text` → `items.id` | |
| `assignment_id` | `uuid` → `assignments.id` | |
| `session_id` | `text` null | The session whose calls the run rolls up. Implied by the assignment, and stored anyway because the per-session rollup must not depend on a join that omits work with no assignment behind it. |
| `state_at` | state enum, null | The stage the run's calls were attributed to, carried up from `tool_calls.state_at` (§10) at ingest. Denormalised for the reason that column is: the per-stage rollup is an indexed read here, and a scan of the highest-volume table if derived. **A stage change closes the run and opens a new one**, exactly as a model or effort change does — a run is the unit cost is attributed by, so one spanning a transition would report a whole stage's work against whichever stage it opened in. That error would not be bounded by the flush interval the way §10's is; it would last as long as the run. What this column inherits from §10 is the narrower caveat that the stage is resolved at flush, so a batch spanning a transition attributes its calls to whichever side the flush landed on. |
| `started_at` | `timestamptz` | |
| `ended_at` | `timestamptz` null | Null while running. |
| `model` | `text` | **Exact vendor model ID**, per §2 — required to recompute `cost` from the token counts, and to keep scoring buckets from merging different model generations. A run whose calls all arrived without one carries a named sentinel rather than an empty string, so "nothing reported this" is visible in a query result and cannot collide with a vendor ID; a sentinel matches no rate, so such a run is unpriced rather than free. |
| `effort` | `text` | Literal effort value. |
| `selection_reason` | enum, null | `recommended` · `exploration` · `override` · `pinned`. Why this model was used. `override` is the valuable one — an agent rejecting the soft-deny — because whether overridden runs go better or worse is the picker's own report card. **Null where no dispatch decision stands behind the run** — every value names a choice something made and stated, and a run cut from telemetry has none: the hook reports which model served a call, never why it was picked. Filling it with `recommended` in that case would put runs nobody recommended anything about into the comparison group recommendations are graded against, so null is both the truthful value and the excludable one. |
| `recommendation_strength` | `numeric` null | Confidence at dispatch time. Low strength is what licenses an exploration in the first place. |
| `input_tokens` | `bigint` | **The facts.** Four separate counts — they price at wildly different rates, so a single total destroys the information. |
| `output_tokens` | `bigint` | |
| `cache_write_tokens` | `bigint` | |
| `cache_read_tokens` | `bigint` | |
| `cost` | `numeric` | Denormalised convenience for sorting and rollups. **Recomputable** from the counts + `model`; the counts are the truth. Rates live in the `pricing.model_prices` setting (§17.2) rather than in code, and the stored figure is **recomputed from the accumulated counts on every write, never incremented** — an incremented total is a sum of figures priced under whatever rates were configured at each flush, so it corresponds to no price table that ever existed and cannot be reproduced or corrected. Null where the model has no configured rate: unpriced and free are opposite claims, and collapsing them makes a total read as complete while being short by an unknown amount. |
| `tool_call_count` | `int` | |
| `turn_count` | `int` | |
| `outcome` | enum | `completed` · `stalled` · `superseded` · `failed`. |
| `rework_required` | `bool` | |
| `blocking_findings` | `int` | |
| `steering_interventions` | `int` | The signal that actually discriminates — steered runs cost ~2×. |

**`model` records what served the request, not what was asked for.** API responses carry the model that
actually ran; that's ground truth.

⚠️ **Known limit:** the hook sees tool calls, not API responses, so it may not have access to that
field — in which case this records what was *dispatched*. And the documented ID can resolve to different
underlying snapshots over time, so two runs six months apart recorded as the same model may not have
been served identically. Not solved; stated, because it bounds how far back scoring data stays
comparable.

---

## 12. `run_scores` — how well it went, per facet

**Two separate scales, never merged.** They measure different things and the *delta* is the signal.

| Field | Type | Meaning |
|---|---|---|
| `id` | `uuid` PK | |
| `run_id` | `uuid` → `runs.id` | |
| `facet` | enum | One of the fixed set in §1.1a — `reasoning` · `breadth` · `precision` · `autonomy` · `visual` · `writing`. Only facets the item declared are scored. |
| `agent_score` | `int` null | 1–5. Outcome-derived where possible, rubric-guided otherwise. **Immutable once written** — correcting it destroys the delta. |
| `user_score` | `int` null | 1–5. Usually empty. Set on the since-your-last-visit screen. |
| `user_scored_by` | `text` null → `people.id` | **Who scored it.** Two people may judge the same work differently — collapsing them loses that. |
| `user_scored_at` | `timestamptz` null | **Timestamp matters** — a correction three weeks later (it broke in production) is far stronger evidence than one at merge time. |

**No separate review table.** `user_score = null` would otherwise be ambiguous — "nobody looked" and
"looked and agreed" are opposite data points, and collapsing them biases the learning signal toward
failures, because you'd only ever learn from the runs you intervened on.

**On accept, write `user_score = agent_score`.** That resolves it in the columns already here:

| `user_score` | Means |
|---|---|
| `null` | Nobody looked |
| equal to `agent_score` | Looked, agreed — **the majority case**, and a weak endorsement worth recording |
| different | Looked, corrected |

Delta analysis is unchanged; agreement is a delta of zero.

⚠️ **Accepted loss:** a passive accept is indistinguishable from someone dragging a slider to the same
number. Slightly weaker evidence, treated as equal.

**Flag the runs where a score is worth most.** Where `selection_reason = exploration` or
`recommendation_strength` is low, the since-your-last-visit card should ask for real eyes — *"we tried a
cheaper model here; is it up to standard?"* — rather than letting a passive accept stand.

Without it the exploration design has a hole: an experiment that went badly gets skimmed past and
recorded as a weak endorsement, and you conclude the cheaper model was fine having never looked.

**Two kinds of attention, worth keeping distinct in the UI:** `blocked` means *work can't proceed
without you*; a flagged run means *it proceeded, but your judgement is unusually valuable here*. One is
urgent, the other is an invitation — and conflating them makes the urgent list untrustworthy.

---

## 13. Minting idempotency — no table

**The file is the atom, not the section** — two agents can split one document differently, so
per-section identity can't be made deterministic. But that doesn't need a `sources` table:

- **"Has this file been minted from?"** is `SELECT 1 FROM items WHERE source_ref = (path, hash)`.
- **A file that yields nothing still mints an item** — a `wont-do` with a summary saying why. Better
  than a silent `processed_at`: the decision becomes visible work with reasoning attached, rather than
  a timestamp nobody reads.
- **Concurrency is the dispatch record.** A "go mint from this file" instruction that hasn't been
  claimed or timed out means the server doesn't issue another — the same mechanism that stops an item
  being dispatched twice. No separate lease.

Editing a file changes its hash, so it becomes eligible again and the agent is told which items already
came from the previous version.

---

## 14. Dispatch — an event, not a table

**No `dispatches` table.** A dispatch looked like it needed one because `session_id` gets filled in
later — a *mutation*, which an append-only ledger can't hold. But that's only true if it's one row. As
**two appends** it's pure ledger:

- **`dispatch`** — `{machine, account_id, estimated_cost}`, server-composed prompt in `body`
- **`dispatch-claimed`** — `{dispatch_event_id, session_id}`, written when a session first reports in

**"Did the launch fail?"** is a `dispatch` with no matching `dispatch-claimed` inside
`dispatch.failed_after_seconds`. More awkward than reading a null column — but it runs every five
minutes over recent events, not on a hot path, and it keeps the ledger whole.

Same query answers the minting lease: an unclaimed mint dispatch means don't issue another.

---

## 15. `machines` and `accounts`

**Usage belongs to the account, not the machine.** Machines are compute; limits are billing. One
account driven from two machines is the ordinary case, and the reverse becomes possible the moment a
second account exists — so budget state on `machines` would be a modelling error that reads fine
with one account and stops making sense at two.

### `machines`

| Field | Type | Meaning |
|---|---|---|
| `name` | `text` PK | `desktop`, `laptop`. |
| `last_poll_at` | `timestamptz` | Lets the server notice *"no poll in 6 hours"*. Without it, a machine that quietly stops asking for work is invisible. |
| `live_sessions` | `int` | **A hint, not truth.** A poll snapshot, stale between polls — but it knows about sessions that launched and haven't made a tool call yet, which the server cannot see. Treat as a floor. |
| `source_globs` | `text[]` null | **Per-machine override of the `minting.source_globs` setting** (§17.7). Null = inherit the setting. A column here rather than a scope axis on `settings`, because filesystem layouts are a property of a machine and machines differ; validated by the registry's own validator, so it is a different *place* for the value and never a different type. |

### `accounts`

| Field | Type | Meaning |
|---|---|---|
| `id` | `text` PK | |
| `vendor` | `text` | `anthropic`, later others. Selects the usage adapter. |
| `display_name` | `text` | |
| `plan_type` | enum | `subscription` · `metered`. Bands mean different things: a subscription has windows to exhaust, metered spend just accrues. |
| `usage_5h` | `numeric` null | **A cache, deliberately.** Derivable as the newest reported reading, but the planner needs it every poll and a `max()` over `tool_calls` per decision is the wrong trade. |
| `usage_weekly` | `numeric` null | Same. |
| `usage_at` | `timestamptz` null | When that snapshot was taken — a stale reading is worse than none. |
| `budget_windows` | `jsonb` null | **Per-account override of the `budget.windows` setting** (§17.7). Null = inherit the setting. Bands key off `account_id` and `plan_type` makes them mean different things — a metered account has no window to have boundaries in — so one global value cannot describe two accounts, which is the same test that keeps `vendor` a column rather than configuration. Same shape and same validator as the setting, including the cross-boundary check (§17.4). |

### `machine_accounts`

| Field | Type | Meaning |
|---|---|---|
| `machine` | `text` → `machines.name` | Composite PK with `account_id`. |
| `account_id` | `text` → `accounts.id` | Which accounts this machine can dispatch against. |

### `registered_processes`

Backs the kill guard (§4, MILESTONES.md #45): *"would this command end a process this session's crew
does not own?"* A process registers itself here when it starts; the guard answers by looking it up.

| Field | Type | Meaning |
|---|---|---|
| `id` | `text` PK | |
| `machine` | `text` | Which host the pid is meaningful on. **A pid is only unique per host**, so every lookup is keyed on `(machine, pid)` and never on the pid alone. Supplied by `STANDUP_MACHINE` (§17.1). |
| `pid` | `int` | |
| `executable` | `text` | The image name, normalised — lower-case, no `.exe`. Stored because the machine-wide kill (`taskkill /IM node.exe`) names an *executable* rather than a pid, and answering "would this kill something that is not yours" needs a name comparable across rows written by different sessions on different platforms. |
| `session_id` | `text` | The session that started it. |
| `root_session_id` | `text` | The root of that session's tree. **The ownership check compares roots, not sessions** — a builder spawned by an orchestrator is the same crew, and a crew killing its own subagent's dev server is exactly the case that must stay allowed. |
| `description` | `text` null | Free text from the registrant — a command line, a label. Never parsed; shown in a refusal so a person reads what they would have hit. |
| `registered_at` | `timestamptz` | |
| `ended_at` | `timestamptz` null | Null = still live. Only live rows are considered, so a finished process cannot make a later, unrelated pid look owned. |

Bands and the pace line key off **`account_id`**, and the future case — *dispatch against whichever
account has headroom* — becomes an ordinary query rather than a redesign.

**`machines.source_globs` and `accounts.budget_windows` are the only two per-entity overrides of a
setting, and the list is closed.** Both are nullable columns on a table that already has rows, which
costs one `COALESCE` at the single point that resolves each; a third needs an argument rather than a
precedent. §17.7 is where the rule lives and why the alternative — a scope axis on `settings` — was
rejected.

---

## 16. Transition guards

Every `(from, to)` pair is legal. What's enforced is **what must be supplied**.

| Entering | Required |
|---|---|
| `blocked` | `blocked_reason` + `blocked_on_type`; plus `blocked_on_person` iff type is `person`, or `unblock_at` iff type is `time`. |
| `paused` | `pause_reason` + `resume_condition`. |
| anything, **from** `blocked`/`paused` | Those fields cleared in the same transaction. |
| `in-review` | ≥1 `artifacts` row of kind `review-requested`. |
| `executing` **from** `plan-review` | A `plan-review` artifact with `verdict = approved`. |
| any `completed` state | A valid `summaries` row. |
| `merged` | Plus `commit_sha`, plus an approving `code-review` artifact at the current `max(artifacts.review_round)`; plus an approving `visual-review` artifact iff `needs_visual_review`; plus an auth check per `merge_authority`. "At the tip commit" includes any sha the tip declares it supersedes (§6d). The code-review clause has two alternative satisfiers: `historical_verification` (§6b, env-gated) and `merge_override` (§6c, reason mandatory) — **neither satisfies the `needs_approval` auth check.** |
| `backlog` from in-progress | No live `assignments` row. |

`POST …/transition?dry_run=true` validates and returns the would-be rejection without mutating.

---

## 17. Configuration

Configuration lives in three tiers, and which tier a value belongs to is decided by one question:
**what must be known before the process can reach the database?**

| Tier | Read from | Changed by |
|---|---|---|
| **Bootstrap** | Environment variables | Editing the environment and restarting |
| **Settings** | The `settings` table, over a registry of typed defaults declared in code | `/settings` in the front end, or `standup config set` |
| **Build constants** | Compiled in | Shipping a new version |

Anything needed to connect and listen is bootstrap. Everything read after that point comes from a
database that is already reachable, so it is a setting — typed, validated, explained and audited.
Anything describing what this build *is*, rather than how it is configured, is a constant.

### 17.1 Bootstrap — environment variables

| Variable | Values | Meaning |
|---|---|---|
| `DATABASE_URL` | connection string | Postgres. The one value nothing else can be read without. |
| `HOSTNAME` | address | Interface the server binds to. The name belongs to the runtime, not to us; the image sets it explicitly rather than inheriting it, because container runtimes commonly set `HOSTNAME` to the container's own name and binding to that is not what anyone means. |
| `PORT` | int | Port it listens on. Same ownership. |
| `NODE_ENV` | `development` · `production` · `test` | Set by the toolchain, not by an operator. |
| `SHADOW_DATABASE_URL` | connection string | Development and CI only. The disposable database the migration drift check drops and rebuilds. Never points at anything anyone cares about. |

The command-line adapter adds two of its own, bootstrap for the same reason:

| Variable | Values | Meaning |
|---|---|---|
| `STANDUP_URL` | base URL | Where a server is, if there is one. Present → commands call the API; absent → they use `DATABASE_URL` and run the service layer in-process. |
| `STANDUP_SESSION_ID` | text | The session a command acts as. Exported by whatever launches a session, never typed by hand. |
| `STANDUP_MACHINE` | text | Which host this session is on — the `machine` half of every `registered_processes` lookup (§15). **A machine with the kill-guard hook installed and this unset behaves identically to one with no guard shipped at all**: nothing resolves, so nothing is owned, and the guard is silent, green and permissive. That silence is the failure mode worth knowing about; making it *visible* is tracked on MILESTONES.md #48 rather than fixed here. |

**Not all of these are optional to the same degree.** Either `DATABASE_URL` or `STANDUP_URL` must
resolve, or the process has no idea what it is talking to — in which case it says so and stops,
rather than starting up half-configured. See `standup init` in §20.

### 17.2 Settings — the registry, and the table

**Every setting is declared in code.** The registry is the single source of key, schema, default,
label, help text, category and when a change takes effect. **The database stores overrides only** — a
row exists for a key exactly when someone has deliberately set it. Three properties follow, and they
are the whole reason for the shape:

1. **A fresh database boots fully working with no configuration at all.** Defaults are code, so there
   is nothing to seed and nothing to forget to seed.
2. **The editing surfaces are generated, not maintained.** `/settings` renders labels, widgets,
   validation and per-field help *from the registry*; so does `standup config`. Explaining a field as
   it is set is a property of the declaration, not a document somebody has to remember to update.
3. **A value has one type, in one place.** The schema that validates a write is the schema that types
   the read, so a guard reading a setting gets a number, not an unknown.

**This is the same argument as capabilities being named values rather than a generic map** (§17.5),
not a departure from it. A registry is named-and-typed; a key-value bag with free-form values is the
map that argument rejects. What changes is only *where the value is stored* — never whether it is
typed.

| Key | Type · default | Category | Meaning |
|---|---|---|---|
| `items.max_depth` | int, `6` | Items | Runaway guard on the item tree. |
| `items.default_merge_authority` | enum, `needs-approval` | Items | What `merge_authority` a new item gets when nothing sets it. |
| `agents.subagent_delegation` | `never` · `allowed` · `required`, default `allowed` | Agents | What an orchestrator may do itself. `never` blocks spawning; `allowed` nudges toward delegating; `required` blocks the orchestrator doing the work. Only fires when an orchestrator role exists, so a single-agent installation is never affected. |
| `liveness.stale_after_seconds` | int, `900` | Liveness | Quiet → `stalled`. A process check comes first; this is the fallback. |
| `liveness.dead_after_seconds` | int, `1800` | Liveness | Stalled → `dead`, claim released. |
| `liveness.evict_after_seconds` | int, `14400` | Liveness | How long a holder must go unseen before a *competing claim* may take the item from it. Checked at contention, not on a timer. Much larger than `dead_after_seconds` on purpose — see the note below. |
| `dispatch.failed_after_seconds` | int, `180` | Dispatch | No session against a dispatch → the launch failed. |
| `dispatch.resume_attempts_before_blocked` | int, `3` | Dispatch | Attempts with no durable progress before escalating to a person. |
| `poll.interval_seconds` | int, `300` | Dispatch | How often each machine asks for work. Takes effect on that machine's next poll. |
| `crew.wait_timeout_seconds` | int, `240` | Crew | How long a wait-for-crew call is held before returning empty. Sized to stay inside the shortest prompt-cache lifetime a session may be given, which is not always signalled — a wait that outlives the cache costs more than the wait saves. |
| `crew.wait_poll_interval_seconds` | int, `5` | Crew | How often the polling implementation of wait-for-crew re-reads the ledger. Used only where no long-poll is available; both implementations return identically (§19). |
| `budget.enabled` | bool, `false` | Budget | Master switch. |
| `budget.windows` | object, `{}` | Budget | Per window: enabled, plus the boundary of each band. See §17.4. |
| `model_picker.enabled` | bool, `false` | Model picker | The mechanism ships before the data does; enable it once there is something to learn from. |
| `model_picker.explore_rate` | 0–1, `0` | Model picker | How often to deliberately try one tier down on low-risk work. At zero it never learns. |
| `notify.doc` | path or null, `null` | Capabilities | Document explaining how to reach people. Null = notifications off. Wanted whenever any notification rule exists, or rules fire with nowhere to go. |
| `visual_review.doc` | path or null, `null` | Capabilities | Document explaining how a visual review is performed here. Null = visual review unavailable. Wanted whenever any item sets `needs_visual_review`, or the item reaches the gate with no way through it. |
| `minting.backlog_low_threshold` | int, `3` | Minting | On-deck count below this triggers a mint request. |
| `minting.source_globs` | list of globs, `[]` | Minting | Where minting looks. The default; a machine that carries its own `source_globs` overrides it, because filesystem layouts differ per machine. See §17.7. |
| `pricing.model_prices` | object, `{}` | Pricing | What each model costs per million tokens, keyed by exact vendor model ID, with a separate rate for input, output, cache writes and cache reads. Run costs are recomputed from these rates and the stored counts, so a corrected rate corrects every figure computed afterwards. Empty by default: a table of figures compiled into the build is current on the day it is written and stale after, and a stale rate yields a confident wrong total where an absent one yields a visible gap. A model with no entry is recorded and left unpriced rather than counted as free. |
| `retention.tool_calls_days` | int or null, `null` | Retention | Null = keep. Applies to `tool_calls` only. |
| `shape.minimum_sample` | int, `20` | Telemetry | Tool calls a session must have made before its shape is reported as anything but `unknown`. Below it the reading is withheld rather than guessed. |
| `shape.repeat_threshold` | int, `3` | Telemetry | Returns to a shell command — with another command in between — before that reads as circling. Counts **returns, not attempts**: a command run and immediately re-run is a retry loop and counts once however long it runs, and reads and edits between two runs do not break the run. Only `Bash` calls are compared. |
| `shape.spread_threshold` | int, `25` | Telemetry | Distinct files touched before the spread reads as wide. Distinct files, not calls. |
| `shape.read_share_threshold` | 0–1, `0.9` | Telemetry | Share of *classifiable* calls that must be reads before a session reads as mostly-looking. Shell calls are classifiable as neither, so they neither raise nor lower it. |

**`settings` — the table.**

| Field | Type | Meaning |
|---|---|---|
| `key` | `text` PK | Matches a registry key. A row for a key the registry does not declare is inert — see §17.3. |
| `value` | `jsonb` NOT NULL | The override. JSON `null` is a legal, meaningful value ("explicitly nothing" — notifications off, retention forever) and is **not** the same as no row, which means "at the default". |
| `updated_at` | `timestamptz` | |
| `updated_by_type` | `actor_type` enum | `person` · `agent` · `system`. |
| `updated_by_id` | `text` null | → `people.id` or `agents.name`. Null for `system`. |

**`settings_revision` — one row, one number.**

| Field | Type | Meaning |
|---|---|---|
| `id` | `int` PK, always `1` | A single row. |
| `revision` | `bigint` | Bumped in the same transaction as every settings write, including a delete. |

A counter rather than `max(settings.updated_at)`, because clearing an override deletes a row and a
delete can lower a maximum — a change that moves state backwards would be invisible to anything
watching a high-water mark. The counter only goes up, so "have settings changed since I last looked"
is one comparison. It doubles as the entity tag for `GET /settings` and as a cheap "anything to
re-read" signal for any process holding a cached snapshot.

**`settings` is never a secret store.** Every value is served to the front end by `GET /settings` and
printed by `standup config list`. There is no redaction path and none will be added, because a value
that cannot be displayed cannot be edited in the surface the table exists to feed. Credentials,
tokens and connection strings are bootstrap environment variables — that tier exists precisely
because some values must not be readable from the application. **A registry entry whose value would
be unsafe to read aloud is in the wrong tier.** The registry's own test enforces this by shape: a key
whose name is credential-shaped fails the build.

### 17.3 Reading settings, and what happens when code and data disagree

**Resolution.** Start from the registry defaults, apply any override that validates, freeze the
result. The output is a typed snapshot, not a lookup table — `snapshot["items.max_depth"]` is a
number.

**One snapshot per service call.** The service layer resolves once at the entry to a call and threads
the snapshot through, so every guard evaluated inside one transaction sees one consistent
configuration. Re-reading per guard would let two checks in the same transaction disagree — a bug
that would appear roughly never and be impossible to reproduce.

**Caching.** A long-lived process keeps the resolved snapshot in memory and re-reads `revision` at
most once every few seconds; if it moved, the snapshot is rebuilt. The guarantee is therefore
explicit and small: **a settings change is visible in the process that made it immediately, and in
every other process within the revalidation interval.** The cost is one primary-key read per process
per interval — with a handful of processes, a couple of reads a second. A short-lived process — every
command-line invocation — builds the snapshot once and exits, so it is always current.

Push notification was considered and rejected: it needs a dedicated connection per process outside
the pool, and a notification delivered while a process is reconnecting is lost, so the version
comparison has to exist anyway as the backstop. A mechanism that does not remove another mechanism is
not an improvement.

**When the registry and the stored overrides disagree, the registry wins and says so.**

| Situation | What happens |
|---|---|
| A key is declared, an override exists, it validates | The override is used. |
| A key is declared, an override exists, it fails its schema (the schema has tightened) | **The default is used**, and the key is logged at startup and shown on `/settings` with the stored value and the validation error side by side. Not a boot failure — refusing to start because a bound moved turns a configuration nit into an outage. Not silently coerced either: a coerced value is one nobody chose. |
| An override exists for a key the registry does not declare | The row is **inert** — resolution starts from the registry, so an undeclared key can never affect behaviour. It is not deleted: deleting data on deploy loses the record of what someone had configured. It is listed under "Unrecognised" on `/settings` with a remove action, and logged once at startup. |
| A key is renamed | The retired entry stays in the registry marked deprecated, naming its replacement, and a one-shot step copies the value across. A rename is written deliberately, never inferred from a similar name. |
| A default changes in a new version | Every installation that never overrode that key changes behaviour on upgrade. **That is a behaviour change and is treated as one** — it belongs in the release notes, not in a diff nobody reads. |

### 17.4 `budget.windows` — the shape, and why it is a setting

A budget window carries four bands (`free` · `selective` · `wind down` · `stop`), so it carries three
boundaries: where each of the last three begins, in percentage points of that window. `free` starts
at zero and needs no boundary.

A boundary is one of three things and no more — declarative, testable, no parser:

| Kind | Shape | Reads as |
|---|---|---|
| `constant` | `{ value }` | 80% |
| `linear` | `{ slope, offset, per }`, where `per` is `hour` or `day` | 15 × days − 5 |
| `schedule` | `{ entries: [{ at, value }] }` | 80, rising to 92 in the final hour |

`at` anchors to either end of the window — `{ elapsed }` or `{ remaining }` — because some rules are
naturally written from the start ("by day three") and some from the end ("in the final hour"), and
both reduce to the same point once the window's length is known. A schedule entry's value is a
constant or a linear; **a schedule may not contain a schedule.** One level expresses every rule
anyone has wanted; the second level is where a shape becomes a language.

**What being typed buys, concretely.** The boundaries must not cross: at *every* moment in the
window, selective is at or below wind down, which is at or below stop, and all three sit inside
0–100. With moving boundaries that is not checkable by eye — two lines with different slopes cross
somewhere, and the somewhere is the point at which the system would be told to wind down harder than
it stops. The setting's validator samples the window across its length and rejects a value whose
boundaries cross or leave the range, naming the moment it happens. A configuration format that cannot
be inspected cannot be checked this way; a typed value can, and this is the check worth the most.

### 17.5 Capabilities — still named values, and where they are validated

**Capabilities are named settings, not a generic map.** A capability is a path *plus the moment the
core hands it over* — and that moment is code, so one can never be added by configuration alone. A
map would give up type safety and per-capability rules (`notify.doc` and `visual_review.doc` are
wanted under different conditions) in exchange for flexibility that does not exist. Same reasoning as
facets being a fixed union.

**Where a capability document is checked, and by whom, needs care, because the core deliberately
never reads one.** It hands over a path; the agent reads it. Server and agent do not necessarily
share a filesystem, so "the path exists" is a question the server can answer only sometimes:

| Check | When | Effect |
|---|---|---|
| Well-formed — absolute path or valid URL, no traversal | On write | **Refuse.** Provable from the value alone. |
| Exists, where the server can see that filesystem | On write | **Refuse.** Provable. |
| Exists, where it cannot | On write | **Accept, mark unverified**, and show it as unverified on `/settings`. Recording "I could not check" is honest; recording a pass is not. |
| Still exists | On the sweep that already runs for liveness | **Warn**, loudly, in the log and on `/settings`. |
| Configured at all, when something needs it | Continuously, and **in the rejection at the gate** | The transition rejection names the missing setting rather than reporting a missing artifact. |

Checking early was never valuable for its own sake — the point is that a missing document must not
first be discovered by an item stuck at a gate, with a message that does not say what to do. Refusing
the bad edit tells the person who made it while they are looking at it; naming the setting in the
rejection fixes the message; the sweep covers a document deleted an hour after it was checked. **The
one thing given up is that a misconfigured installation still starts** — the right trade for a running
service, because a service that refuses to start is down for everyone, including whoever is trying to
fix the configuration through the interface built for it.

`/settings` and the startup log both state, in a sentence, when a capability is wanted and unset:
*"14 items require a visual review and `visual_review.doc` is not set."*

### 17.6 Build constants — fixed by this version, not configurable

| Constant | Meaning |
|---|---|
| `HOOK_PROTOCOL.http.current` / `.min_supported` | The version of the HTTP hook protocol this build speaks, and the oldest it still accepts. |
| `HOOK_PROTOCOL.cli.current` / `.min_supported` | The same for the command-line hook protocol. The two variants are versioned independently because they change independently — a fix to one must not force every session using the other to reinstall. |
| `APP_VERSION` | The published version of this build. |

**None of these is configurable, and the reason is the same for all of them: they describe what this
build implements.** Setting a required protocol version to one the build does not implement produces
a system that refuses everything for a reason nobody can act on. They are exposed read-only on
`/settings` and by `standup doctor`, because knowing them is useful and changing them is not.

**Two numbers per variant, not one**, because "you should update" and "I cannot talk to you"
are different statements, and collapsing them makes every version bump a breaking one. Raising
`min_supported` is the deliberate act that makes an update mandatory. §21 covers what each answer
does to a session.

### 17.7 Two kinds of thing that are not settings

**A setting is a value the *build* knows about.** It exists because code reads it, it has a default,
and a fresh database boots fully working with none of them stored. Two other kinds of value fail that
test, and pushing them into the registry would break it.

**Installation-owned entity data.** `repos`, `areas`, `machines`, `accounts`, `people`. The build
cannot know these; there is no default repository; a fresh database is *not* fully working with zero
rows if an item names a repository. They are entities, declared in the schema rather than in code,
and they are edited on the **administration surface** (§23) — not `/settings`, which by construction
can render only what the registry declares.

**Per-entity overrides of a setting.** Two values are genuinely a global default *plus* a
per-entity exception, and both are the same mechanism:

| Value | Default | Override | Why an override is needed |
|---|---|---|---|
| Minting globs | `minting.source_globs` | `machines.source_globs` | Filesystem globs are a property of a machine, and machines have different layouts. |
| Budget windows | `budget.windows` | `accounts.budget_windows` | Bands key off `account_id`, and `accounts.plan_type` makes them mean different things — a metered account has no window to have boundaries in. One global value cannot describe two accounts, which is the same test that keeps the usage adapter on `accounts.vendor` rather than in configuration. |

**The rule, stated so it does not grow:** **settings are global; a value varies per entity only by an
override column on that entity's own table, and only where the entity already exists.** Two uses, and
the door is closed to a third without an argument. This is deliberately *not* a scope axis on
`settings` — that would mean a resolution order at every read, a cache keyed per scope, and a form
that becomes a matrix. A nullable column on a table that already has rows costs one `COALESCE` at the
one place that reads it.

**And the override is validated by the registry's own validator**, so the typed editor and the
cross-boundary check in §17.4 apply identically to a per-account value. The override is a different
*place*, never a different *type*.

**One value is not configuration at all in either sense.** Which usage adapter reads an account is
`accounts.vendor`, a column with an existing home and an existing meaning. Its value should be checked
against the registered adapter list on write, which it is not.

### 17.8 Who may change a setting — the posture, stated

**There is no authorisation on `/settings`, for the same reason there is none on the profile picker:
identity here is a claim, not a credential.** Anyone who can reach the app can change any setting, and
`standup config set --as <person>` asserts its own identity. Access control is a separate concern
layered on top, and it is deferred.

**That deferral has a sharper edge here than it does on the board, and it is stated rather than
discovered.** Some settings do not merely tune the system — they switch off the enforcement it exists
to provide:

| Setting | What one write does |
|---|---|
| `items.default_merge_authority` → `pre-approved` | Every subsequently created item skips the human approval gate |
| `budget.enabled` → `false` | The bands stop applying |
| `notify.doc` → `null` | Every notification path goes silent, including the escalation that puts a blocked item on somebody's list |
| `liveness.dead_after_seconds`, `dispatch.resume_attempts_before_blocked` → large | Dead work is never reclaimed and never escalates |
| `retention.tool_calls_days` → a small number | **Destroys history that cannot be recreated.** Facet and cost data is measured, not derived; once deleted it is gone |

**So the registry declares two flags, and they are different classes of thing:**

- **`sensitive`** — this setting relaxes an enforcement. Rendered in its own section of `/settings`
  behind a *"these change what the system enforces"* heading, requires typing the setting's key to
  confirm, and writes an audit event of its own kind so it is greppable rather than buried among
  ordinary changes.
- **`irreversible`** — this setting can destroy data that cannot be recreated. Everything `sensitive`
  does, **plus a floor in its own schema** (retention cannot be set below a bounded minimum), **plus a
  refusal in the consuming job**: a retention pass that would delete more than a bounded fraction of
  the table stops and reports instead of proceeding. *Irreversible* and *unauthenticated* is the
  combination worth breaking first, and the floor is the cheap half of breaking it.

**What a deployment is expected to do.** Put whatever access control it wants in front of the app —
a reverse proxy, a network boundary, an identity-aware gateway. The app does not authenticate and does
not pretend to. **And note the honest limit: in `direct` mode the command line reaches the database
without passing through any of that, so database access is unrestricted settings access.** That is
inherent to a tier whose whole premise is a client with a connection string; it is written down here
rather than left to be found.

---

## 18. What an agent sees — the MCP tools

Deliberately small. MCP servers exposing sixty-odd tools are easy to find, and every one of those descriptions sits in context on every turn whether or not it is used.

| Tool | Description as the agent reads it |
|---|---|
| `get_item` | Fetch one item plus a summary of its children. |
| `list_items` | Filter by state, area, parent, assignee, repo, priority. **Finished work is excluded by default** — `includeTerminal` asks for it, and filtering on a terminal state directly still returns it. |
| `my_work` | What you hold right this moment, and in what role. |
| `progress_report` | **How is it going.** A numbered row per item this session holds — its branch, a human title, its state and what is blocking it — with two bullets on what is done and what is left, and open loops as sub-bullets. Computed and shaped by the server, so two reports a week apart are comparable. Finished work is counted in the summary and listed only on `includeCompleted`. |
| `orientation` | **Catch me up.** Latest checkpoint, current state, events since that checkpoint, open loops, crew and worktree state. What a fresh session reads instead of being resumed. |
| `create_item` | Create a project, task or subtask. `parent_id` optional. |
| `update_item` | Change non-state fields. |
| `transition` | Move to a new state. Validates required fields. `dry_run` to preview a rejection. |
| `complete` | Finish an item. **Separate from `transition` on purpose** — the required summary shape is in this tool's schema, where the agent can see it. |
| `checkpoint` | Record what you tried, what you ruled out, what's next. |
| `note` | Leave a timestamped remark on an item. |
| `claim` | Take ownership of an item in a role. Atomic — two agents can't both win. Returns `crew_name` — the name the claiming session is now known by, assigned automatically (§9, §21). |
| `release` | Give up ownership. |
| `heartbeat` | Still alive. (Usually unnecessary — the hook does it.) |
| `crew_status` | Non-blocking digest of what your crew is doing. |

**Naming is not a tool a session calls.** A crew name is assigned as a side effect of registering (§21) and of `claim` above — the two calls a session already makes — rather than by a separate request. `get_crew_name` still exists as a registered operation (§9) for the rare caller that wants a name with no other side effect, reachable over HTTP and the command line; it is deliberately absent from this list because no agent needs it.

**Not exposed as MCP:** `wait_for_crew`. It's `standup crew wait` (§20), because only a shell call can be backgrounded — and backgrounding is the whole point.

## 19. HTTP endpoints

Same service, different consumers.

### Authentication — a bearer token per machine

Every endpoint below presents `Authorization: Bearer <token>`, and so does the MCP mount at `/mcp`.
The server matches it against `STANDUP_TOKENS` — one `machine:token` pair per machine — and the
machine it resolves to is carried on the call as `caller.machine`.

**The point is not the header; it is that a remote client has a path at all.** Every rule this
product enforces lives in the service layer as application code, and Postgres cannot evaluate any of
them — *allowed only with an approving review at tip* is conditional on state a grant cannot see. A
client with no authenticated remote path reaches the store the only way left to it, a direct
connection, and every guard is bypassed by never being reached. §22's rule that only the service
layer may import the database client is the same invariant one process inward; this is what lets it
hold across hosts.

**Per machine rather than one shared secret**, because `machines` is already a first-class entity
with a name: a token per row gives revocation without rotating every other machine, and it turns the
`X-Standup-Actor` header from an unverified self-report into a claim with an established origin
beside it. `caller.machine` and `caller.actor` stay separate fields for exactly that reason — one is
proved, one is declared.

**It fails closed, including when nothing is configured.** With `STANDUP_TOKENS` unset the server
refuses every authenticated call rather than serving them all. A gate that switches itself off when
its configuration is missing protects nothing precisely when a deployment has gone wrong, and a loud
failure at rollout is cheaper than a server that has quietly been open since someone mistyped a
variable name.

### The front end calls through a server that holds the credential

**A browser is not a machine, and the argument above is an argument about
machines.** A machine holds configuration, an operator can hand it a secret,
and its token can be withdrawn without anyone else noticing. A browser has
none of those properties: there is nobody to hand it a credential, and
anything shipped to a page is readable by whoever opens the developer tools —
which would publish the token to every reader and make per-machine revocation
meaningless.

So the front end is not given one. It calls `/api/ui/*`, a route that runs on
the server, attaches the token for a machine of its own (`browser` by default,
`STANDUP_BROWSER_MACHINE` to override) and forwards to the very same handlers
every remote client reaches. The credential lives in the server process and is
never serialised into a response.

**This is deliberately not a same-origin exemption.** The tempting shortcut is
to admit a request that looks like it came from the app — `Origin`,
`Sec-Fetch-Site`, a referer. Every one of those is a value the client chooses,
so a gate on them refuses only clients that are honest about being clients,
while reading like a boundary. It would also split the model by verb — reads
exempt, writes not — and the front end genuinely writes: it transitions items,
edits settings and marks events seen. Nothing here is exempt instead: the
forwarded call presents a real token, is matched against the table by the same
constant-time comparison, and resolves to a real machine name that appears in
the logs and beside attributed writes.

**It fails closed like everything else.** With no token configured for that
machine the route refuses with a 503 naming the variable to set, rather than
forwarding the call without a credential — which is the one shape that could
later be "fixed" by exempting the forwarded call from the gate, leaving the
API open to anyone who can reach the port.

The forwarding route strips the browser's own `Authorization` before attaching
the server's, so a reader cannot have this server present a guessed token and
use it as an oracle; it refuses path segments that would escape `/api`; and it
takes the destination's origin from the request URL rather than any header, so
a client cannot choose where a request carrying a valid credential is sent.

**Three routes are deliberately unauthenticated**, each because its consumers run *before* an
installation is configured and hold no credential: `GET /health` and `GET /ready` (probes read by
restart policies, deployment gates and load balancers) and `GET /hook/script` (fetched during the
registration handshake; it serves a build artefact that ships in the public image). All three report
only booleans, counts, or a file that carries no installation state.

### Liveness and readiness are separate routes

`GET /health` answers *is this process alive* and touches no database. `GET /ready` answers *can I
use this yet*: it runs the cheapest real query and reports the migration state with it, answering
`200` when the database responds and no migration is half-applied, `503` otherwise.

They must not share a route. A restart policy wants the first — a database being down is not a
reason to kill an application container — while a deployment gate, a `depends_on` condition and a
load balancer want the second. A process whose Postgres is still initialising is alive and not
ready, and collapsing the two means one of those consumers is silently given the other's answer.

The migration counts are part of the answer because *connected* and *ready* are different claims: a
process running against a schema two migrations behind fails at the point of use, as an internal
error, rather than at the gate meant to catch it.

### Request ids — `X-Request-Id`, in both directions

Every endpoint below that calls a service operation reads this header and echoes it, so it is stated
once here rather than repeated per row. Three routes are exempt: `GET /health` and `GET /hook/script`
run no operation, so there is no server-side line for an id to join (`GET /ready` does call one, and
resolves and echoes an id like the rest); and the MCP mount at `/mcp`
mints an id per *tool call* rather than per request, because one HTTP request there can carry
several — labelling the envelope would be the wrong grain.

A caller that sends `X-Request-Id` has that value stamped on every server-side log line written for
the call, which is what lets a client's own lines and the server's be read as one call instead of
two unrelated ones. A caller that sends nothing gets an id minted for it. Either way the id comes
back on the response — on a success as much as on a failure — because "I called X and got Y" is
asked about both, and the value in hand is what finds the call in the log.

The id is a **log label and nothing else**: it is never looked up, never compared against stored
state, and authorises nothing, which is what makes accepting a caller-supplied one safe. What it
cannot be allowed to do is corrupt the newline-delimited JSON it lands in, so a value carrying a
newline, a control character, whitespace, non-ASCII bytes, or more than 200 characters is **ignored
in favour of a minted one rather than refused** — a bad log label is not worth failing an operation
over.

**Agent-facing** — one per MCP tool above, plus:

| Endpoint | Purpose |
|---|---|
| `POST /items/{id}/transition?dry_run=` | The validated move. |
| `GET /items/{id}/orientation` | The resume payload. |
| `GET /crew/wait?since=&timeout=` | **Long-poll.** Returns on the first crew event after `since` that is below the transaction-visibility horizon, or empty at the timeout. `since` is required and is handed back by `claim`, `orientation` and every wait, so a caller always has one. The horizon, not the cursor alone, is what makes this and the polling implementation return identically — a sequence identifier is allocated before commit, so ordering by it alone can step over an event that commits late (§3). `timeout` is clamped to `crew.wait_timeout_seconds`. |

**Machine-facing:**

| Endpoint | Purpose |
|---|---|
| `POST /poll` | Launcher. Sends machine, live sessions, usage snapshot, pending source hashes. Returns zero or more dispatches, each with a server-composed prompt. |
| `POST /hook` | The dumb pipe. Sends event type, session, tool, command. Returns allow/deny for guarded patterns, or nudge text, or nothing. |
| `POST /tool-calls` | Telemetry ingest (§10). One flush: `{sessionId, calls[]}` — the session on the envelope, because a flush is one session's work and it makes the assignment lookup once per request rather than once per record. Caps the big fields (truncating, marked) and refuses malformed measurements. Answers `201` with what the batch was attributed to, including `null` for a ghost session. Beside `/hook` rather than under `/items` because a ghost session has no item to nest under. |
| `POST /sessions/{id}/register` | Handshake. Reports the hook variant and its protocol version; the **transport the registration arrived over is stamped by the adapter** and decides which hook variant the reply describes (§21). The reply says what to update, and whether the session may claim — which reflects `hook.require_registration_to_claim` (§21), not the version verdict alone. Registering with no version at all also returns `fetch` — where to get the hook and where to put it (§21). |
| `GET /hook/script?variant=<variant>` | Serves the built hook script for one variant — the other half of the bootstrap loop `register_session` starts (§21). `404` for a variant this build has no script for, whether or not it is a real `HookVariant`; not cacheable (`no-store`), because the URL names a variant, not a version, and the file behind it changes across releases with nothing in the URL to signal that. |
| `POST /kill-guard` | *"Would this command end a process my crew does not own?"* Takes the command and the asking session; answers `allow` / `deny` with the reason naming what would have been hit. The **judgement is here and only here** — the hook parses the command locally (it is the one part that cannot run anywhere else) and sends everything it cannot rule out. A command the local parser cannot decompose is sent rather than assumed harmless, and an unreachable server denies. |

The other three process operations — `register_process`, `end_process` and `list_processes` — are
how `registered_processes` (§15) gets its contents. They are **registered service operations with no
HTTP route, no MCP tool and no command**: reachable through the service layer and the adapter
conformance suite, but not from a session. While that holds, the registry stays empty on a real
machine, and an empty registry means the guard owns nothing and refuses machine-wide kills rather
than allowing them — fail-closed, but not yet useful. Giving them a surface is what makes the guard
usable, and belongs with MILESTONES.md #48.

**Human-facing:**

| Endpoint | Purpose |
|---|---|
| `GET /board?priority=&area=&repo=&kind=&state=&assignee=&search=&includeTerminal=` | Items grouped by derived column. Filters compose (AND); `state` excludes projects (§1: their stored state is a creation leftover, never a fact about them); `assignee` matches a live assignment's holder; `search` is a case-insensitive substring match over title/body. **Finished work is excluded by default** — `includeTerminal` asks for it, and filtering on a terminal `state` directly still returns it. |
| `GET /search?q=&state=&area=&repo=&openOnly=&limit=` | Find items by text in `title`, `headline` or `body`, best match first. A case-insensitive **literal** substring match (a caller's `%`/`_` are escaped), ranked title > headline > body with bonuses for an exact field and a word-start match. **Every state is searched by default, finished work included** — the inverse of the list reads, because a caller naming a phrase wants that item whatever state it reached; `openOnly` excludes terminal work. Returns `{id, title, state, headline, matchedIn, score, excerpt}` per match plus `considered`, `truncated` and a `notice`; never a whole record — read one with `GET /items/{id}`. |
| `GET /events?since=` | Since-your-last-visit. A **slice**, never the whole ledger. |
| `POST /events/{id}/seen` | Mark read. Optionally carries facet scores. |
| `GET /items/{id}` | Read one item for the UI. |
| `PATCH /items/{id}` | Edit non-state fields. |
| `POST /items/{id}/notes` | Leave a timestamped remark (an `events` row of type `note`). |
| `GET /authorizations?scope=` | Is there a standing auth covering this? |

Configuration (§17):

| Endpoint | Purpose |
|---|---|
| `GET /settings` | Every declared setting with its value, source (default or override), schema, label, help, category and validation state. The registry, rendered. Carries the revision as an entity tag. |
| `GET /settings/{key}` | One setting, same shape. |
| `PATCH /settings` | Set and clear several keys at once, in **one transaction**, with one revision bump and one audit row per key sharing a batch identifier. The primary write path, because one human act on `/settings` is one act. Cross-setting validators see the proposed set, not the stored set. |
| `PUT /settings/{key}` | Set one override — the single-key case of the same path. |
| `DELETE /settings/{key}` | Clear an override, returning the key to its registry default. Also audited. |

Installation-owned entities (§23):

| Endpoint | Purpose |
|---|---|
| `GET`/`POST`/`PATCH` `/repos`, `/areas` | The reference tables. Creating a repository is deliberate; `POST /areas` finds-or-creates by normalised name (the same mechanism an item write triggers on first use), and `PATCH /areas/{id}` is what renames or archives one. |
| `GET`/`PATCH` `/machines` | Including `source_globs`, the per-machine override of `minting.source_globs`. |
| `GET`/`PATCH` `/accounts` | Including `vendor` — validated against the registered adapter list — and `budget_windows`, the per-account override, validated by the registry's own validator. |
| `GET`/`POST`/`PATCH` `/people` | Profiles. Archive rather than delete; attribution rows point here. |

**None of these is `/settings`, and the distinction is structural rather than stylistic**: settings are
declared by the build and stored as overrides; these are entities the installation owns and the build
cannot know. See §17.7.

---

## 20. The command line

`standup` is a third adapter over the service layer, alongside the web API and MCP. It exists so the
app can be used where a server cannot be hosted, and it enforces exactly the same rules, because it
reaches them the same way.

**Two transports.** With `STANDUP_URL` set it calls the API; otherwise it uses `DATABASE_URL` and
runs the service layer in-process. `--direct` forces the second. One set of command implementations
sits above both, so only the two bindings could ever diverge — and §22 is the test that says they do
not.

**Postgres is still required.** "No dedicated server" means the app does not have to be hosted, not
that it has nothing to talk to. `standup init` finds an existing database, accepts a connection
string, or provisions one through a container runtime; then migrates, seeds, writes local
configuration, and proves it with a live round trip. **Every other command preflights** and stops with
*"run `standup init` first"* — a half-configured installation that behaves like a working one is the
worst available outcome.

**Shape.** `standup <noun> <verb>`, nouns `item` · `session` · `crew` · `config` · `repo` · `area` ·
`machine` · `account` · `person`, plus `init`, `doctor`, `hook` and `mcp`, which name one thing each.
A short alias list covers the commands used constantly; aliases resolve to the same operation, so
nothing downstream sees them.

**Output.** Human-readable by default, `--json` for anything parsing it — one document, one envelope,
`{ ok, data }` or `{ ok, error: { code, message, fields } }`, with all human text on standard error so
standard output stays parseable. **The error code is the same identifier the API returns**, which is
what lets identical enforcement be asserted rather than assumed.

**Exit codes** separate the situations that want opposite responses: `0` accepted · `1` unexpected
failure · `2` malformed command · **`3` rejected by a rule** · `4` not configured.

**Who is acting.** `--as` names the person, else the environment, else the only profile if there is
one. **A claim, not a credential** — the same posture as the profile picker, and the command's help
says so. `--session` names the session, from the environment in practice, and is required by anything
that takes or releases ownership. Precedence throughout is flag, then environment, then the
configuration file. The connection string is read from the environment or written by `init` into that
file with owner-only permissions, and is never printed by any command.

**Wait-for-crew follows the binding, not the adapter** — over `http` it calls the long-poll; over
`direct` it polls the ledger, bounded by the same visibility horizon so both return the same events
(§22 covers the test that says so).

**What needs a server**, stated rather than discovered: the front end. Everything else is substituted
— MCP over stdio, wait-for-crew by polling, and configuration through `standup config`, which renders
the same registry the settings page does.

---

## 21. Session registration, and which hook a session gets

A session registers before it does anything. **The transport it registers over is a capability
signal**: registering over the command line proves the command line is installed and the database is
reachable; registering over MCP or HTTP proves a server is reachable. So the transport — stamped by
the adapter, not supplied by the caller — decides which hook variant the reply describes. With both
available the registration transport wins; an explicit override in the payload is honoured and
recorded as an override.

**Registering is also what names the session.** The reply carries `crewName` — the name this session
is now known by (§9), assigned atomically from the pool, or the name it already held if it is
registering again. `crewName` is `null` only when the pool is exhausted; that never blocks
registration itself, because naming is a courtesy riding on a call the session had to make anyway,
not a precondition for it.

### The bootstrap loop — obtaining a hook, not just being told which one

Naming a variant and a protocol version is only useful to a session that can already reach the
script. A session on an arbitrary machine has no reason to hold a source checkout of this
repository, so being told "run the `http` hook" with no way to obtain one is a dead end dressed as an
instruction. Registering with **no hook version at all** answers with a route out instead:

1. **The session registers, reporting no `hookVersion`.** This is the honest state of a session that
   has never run the hook — indistinguishable from one reporting one truthfully, because both are "I
   have made no claim about what I can enforce" (the same reading `assessVersion`'s `unregistered`
   verdict already gives this case).
2. **The reply carries `fetch`** — present only in this case, absent once any version has been
   reported (including a stale one; a session that already has *something* installed does not need
   fetch instructions repeated at it on every ordinary re-registration). Two fields:
   - **`scriptUrl`** — a path, `GET /hook/script?variant=<variant>` for the session's own
     `hookVariant`. A URL rather than the script inline: an MCP response is not the place for a
     payload that size, and a URL also lets a client fetch it with ordinary tooling. A path, not a
     full URL — the service layer holds no notion of its own external address (§22), and a caller
     reaching this handshake at all already has the base URL it registered against.
   - **`install`** — deliberately vague: what the file is and that it must be wired to `PreToolUse`
     and `PostToolUse`, never a concrete path. The server cannot know a given machine's layout for
     "where hooks live", and a wrong concrete path would look authoritative while being wrong on most
     machines — worse than an honest "figure out where yours go."
3. **The session fetches `scriptUrl`, installs it, and registers again reporting the version it now
   runs.** The server records `hookVersion` on the same row (an upsert, as every re-registration is)
   — no separate "hooked" flag exists or is needed, because `hookVersion !== null` already means
   exactly that.

### Serving the script

`GET /hook/script?variant=<variant>` returns the built artefact for that variant, as bytes — not
executed, not parsed, just written back. `404` for a variant this build has no script for, and
**the same `404`** whether the name isn't a real `HookVariant` at all or is one (`cli` is a real,
versioned slot in this schema) with no script built for it yet: from a caller's perspective both mean
"there is nothing to fetch," and answering them alike means adding a `cli` script later costs one
entry in the build map, never a change to this route's behaviour.

**Not cacheable — `no-store`.** The URL names a variant, not a version, and the file behind it
changes on any release that touches the hook. A cache — browser, proxy, CDN — sitting in front of
this route would keep serving a stale build after an upgrade with nothing in the URL to signal the
content changed, which is silently worse than no caching: a session believing it just fetched the
current hook while in fact running a stale one. Content-addressing the URL itself (naming the
protocol version) would make long-lived caching correct and cheap; until then `no-store` is the only
response that cannot go stale.

### `sessions`

| Field | Type | Meaning |
|---|---|---|
| `id` | `text` PK | The client's session identifier. |
| `machine` | `text` | |
| `transport` | enum | `cli-direct` · `cli-http` · `mcp-stdio` · `mcp-http` · `http`. How this session registered. Five values because the version rule turns on the binding, and they are the same names the conformance drivers use. |
| `hook_variant` | enum null | `cli` · `http`. From `transport` unless overridden. |
| `hook_variant_overridden` | `boolean` | Whether the variant came from the payload rather than the transport. Without it an override and a derivation are indistinguishable afterwards, and *"why is this session on the cli hook when it registered over HTTP?"* has no answer. An override naming what the transport would have chosen anyway is **not** recorded as one — it changed nothing. |
| `hook_version` | `text` null | What the session reported. Null = never reported one. |
| `client` | `text` null | What kind of agent tool it is, as it describes itself. |
| `person_id` | `text` null → `people.id` | Who it acts as, where known. Half of the declaration later calls inherit — see *Defaults that carry* below. |
| `drive_mode` | enum null | `autonomous` · `manual` · `supervised`. How work this session creates is driven, absent a per-item decision. **Null is meaningful**: it is "declared nothing", which is a different fact from declaring the value that happens to be the item-level default, and only the first falls through. |
| `registered_at` · `last_seen_at` | `timestamptz` | |

**Nothing references this table by foreign key.** A session that never registered still writes tool
calls — that is what makes it a ghost — so a constraint would either reject those rows or force a
phantom registration. This is a registry, not a constraint.

### Defaults that carry

A session that acts for a person acts for that person for its whole life, and one running unattended
runs unattended for its whole life. Neither fact changes between two creates a minute apart, so
**they are declared once at registration and inherited** rather than restated on every call.
`person_id` and `drive_mode` above are that declaration; `create_project`, `create_task` and
`create_subtask` resolve them for any field the call omitted.

Four rules bound it, and the last two matter more than the first two:

1. **An explicit value always wins**, including one equal to the declaration — the call stays on the
   record either way.
2. **A declared person implies a person origin.** `origin_type` is `person` and `origin_person` is
   that person, because declaring a person is what "the work I create comes from this person"
   *means*.
3. **The reverse inference is never made.** A session with no declared person does **not** get
   `origin_type: auto` — creating work on somebody's behalf from an autonomous session is ordinary,
   and defaulting the field would silently relabel it as machine-originated. `origin_type` stays
   required unless a declaration answers it.
4. **A declaration is validated on every use, not trusted because it was made.** An inherited person
   goes through the same existence check as a typed one, so a declaration can never write a dangling
   reference.

A re-registration that does not restate the declaration **refreshes rather than retracts it** — the
ordinary reconnect sends neither field, and clearing them there would silently un-declare a session
mid-run. The cost is that a declaration cannot be cleared by omission: changing one means sending
the new value.

### Versions, and what each answer does

The build carries two protocol versions per hook variant: the one it speaks and the oldest it still
accepts (§17.6).

| Reported | Answer |
|---|---|
| At or above `current` | Nothing to say. |
| Below `current`, at or above `min_supported` | **Advisory** — a nudge on the handshake and on the next hook call. A fix must not disable every session the moment it deploys; anything that genuinely must be enforced is expressed by raising `min_supported`, which is a deliberate act in a release. |
| Below `min_supported` | **The session may not claim** — but only where `hook.require_registration_to_claim` is on. |
| Never registered | **The session may not claim** where that setting is on, and is nudged to register on its first write-shaped action either way. |

**Where the refusal applies, refusing the claim rather than everything is the honest maximum.** A
hook can always be not installed, so its presence cannot be enforced on a machine the server does not
control. What *can* be enforced, in the service layer and therefore through every adapter, is that
**no unguarded session holds work**: such a session may still read, orient and update itself, but may
not take ownership of an item under rules it cannot enforce.

**`hook.require_registration_to_claim` turns that refusal on**, and defaults to off. It is
`sensitive` in the tightening direction: on means a session that cannot register cannot hold work,
which is the right posture for an installation that has finished rolling the hook out and wants to
keep it that way.

**It defaults to off because the version is information, not permission.** What a reported version
tells the server is which signals to expect from that session: one running the hook reports its tool
calls, so silence from it means something; one running no hook reports nothing, so silence from it
means nothing at all. Both facts are useful, and neither is a reason to refuse the session work.

Enforcing it by default also made ownership unreachable for an honest caller, which is the sharper
argument. Claiming required a registered version; registering one truthfully required running the
hook; and a session with no hook had no way to obtain one. The only route through was to assert a
version it had not run — precisely the false claim the check exists to catch. **A gate whose only
exit is a lie protects nothing**, and the cost of shipping it off is met instead by asserting both
positions of the gate in the test suite, so the refusals are exercised on every run rather than first
exercised the day an installation turns them on.

**How a `cli-http` registration is told apart from a plain `http` one.** Four of the five transports
are self-evident to the adapter that receives them, because of where that adapter runs. The fifth is
not: a command line talking to a server and any other HTTP caller arrive at the same route in the
same shape. The command line's `http` binding therefore stamps a header naming itself, which the
registration route reads from a one-entry allow-list and ignores otherwise. The header is
unauthenticated, and what it can change is which hook variant the reply *describes* — which the
registration payload's own `hookVariant` override already grants any caller outright. It cannot make
an unregistered session claimable or an incompatible one compatible, because the claim check reads
the reported version and never the transport.

**One case collapses.** Where the command line runs in `direct` mode it *is* the app — the hook, the
rules and the migrations are one installed package — so the hook cannot be a different version from
the rules, and the remaining question is whether that package is current with the database's
migration state. An older package against a newer database refuses rather than warns: it is the one
skew that can corrupt rather than merely fail. **This does not generalise** — a hook shelling out to
the command line in `http` mode still has two independently versioned artefacts.

---

## 22. Adapter conformance

Every way in — the web API, MCP over each transport, the command line on each of its two — is a thin
shell over one service call. That is a claim, and this is the test that makes it true rather than
intended, because the failure it guards against is silent: **a rule implemented inside an adapter is
enforced for that adapter's callers and for nobody else, and nothing reports it.**

**One driver per adapter, behind one interface**, in a map typed from the **adapter registry** — the
module the application mounts its adapters through, so the names are load-bearing at runtime rather
than a list maintained for a test. `AdapterName` is its key type, so
**adding an adapter without adding its driver does not compile.**

**Cases are authored once per operation, never per adapter.** A case names an operation, a seed, an
input and an expectation — accepted, or rejected with a specific code and set of offending fields.
The runner takes the cross product with every driver that exposes that operation, so a new case costs
nothing per adapter, which is what stops the suite decaying when writing cases becomes tedious.

**Four assertions:**

1. **Identical outcomes.** The same acceptance, or the same rejection code and fields, from every
   driver. *Message text is deliberately not compared* — a terminal and an API should word things
   differently, and asserting text is both brittle and a weaker claim.
2. **Every operation has an accepting case and a rejecting case.** A guard that never refuses anything
   passes a happy-path suite and protects nothing.
3. **Every registered guard appears in at least one *observed* rejection** — computed from the `guard`
   identifier the service returned, never from what a case declared, because a case can name one rule
   while the service refuses on another with the same code. So a new guard fails the
   build until it has a case, and nobody has to remember to write per-adapter tests for it. This is
   the assertion that keeps the suite honest a year from now.
4. **Adapter completeness.** Every operation an adapter exposes maps to a registered service
   operation, and any it deliberately does not expose carries a written waiver — the board is a
   user-interface read, the poll is machine-facing, `init` is local-only. An unwaived divergence
   fails.

**Waivers are bounded by construction, not by review attention.** They live in one reviewed file with
a reason each, printed in the CI summary, and **no operation any registered guard can reject may be
waived by an adapter that exposes any write operation** — so an adapter is read-only by declaration,
or fully covered, with nothing in between. Without that, a driver that declines to expose anything
passes assertion 1 vacuously.

**And one structural rule, because behaviour comparison cannot catch an adapter that satisfies every
case and then adds a check of its own.** It is an allowlist rather than a denylist:

> **Only the service layer, the settings resolver, and migrations and seeds may import the database
> client. Nothing else, anywhere in the repository.**

A denylist naming route directories would leave out pages, layouts and server actions — which live in
the same bundle and also mutate — so it would be wrong the first time the front end writes anything.
An allowlist needs no maintenance as directories are added and covers code nobody has written yet. If
an adapter cannot reach the database except through a service, it cannot bypass a rule — not because
it was reviewed carefully, but because it will not build.

**One negative control per claim.** A fixture adapter reaching past the service layer, a guard with no
case, a driver returning a different code, an operation with only an accepting case, an adapter
exposing an unmapped operation — each asserted to fail — **plus a direct assertion that the guard
registry is not empty**, because an assertion evaluated over an empty set passes forever and silently.

**Cost, and how it is kept sane.** Run in-process wherever the process boundary is not the thing
being tested — call the route handler directly, drive the command line through its entry point with
an argument vector — and keep a much smaller spawned smoke subset (a real process, a real stdio
session) as its own job. The in-process matrix runs on every change; the spawned subset proves the
wiring and does not grow with the case table.

---

## 23. Installation-owned data, and where it is edited

Configuration (§17) is owned by the build: a key exists because code reads it, every key has a
default, and a fresh database boots fully working with no rows at all. **A second class of data does
not work that way.** Repositories, areas, machines, accounts and people are owned by the
*installation*: the build cannot know them, there is no default repository, and a database with no
rows here cannot serve an item that names one. They are entities, declared in the schema, and they
belong on their own surface rather than stretched into a settings page that can only render what the
registry declares.

### 23.1 `repos` and `areas`

**A value that must be exact cannot be free text.** `items.repo` is what the merge gate uses to decide
which repository a change lands in, and `items.area` is required on every item, filtered on, and in
the notification-rule field whitelist. Three spellings of one name are three values to the database
and one to whoever typed them — which shows up as a filter that splits, a count that undercounts, and
a notification rule that silently never fires.

**An enum is disqualified rather than merely awkward.** Postgres cannot remove an enum value, so a
typo is permanent; and an enum of one installation's repository names, in a product meant to be
generic, is exactly the vocabulary leak this schema removes everywhere else. **A reference table with
a foreign key is the one shape that gets both properties that were in tension** — nothing has to be
enumerated in advance, and the same value is stored every time. Adding a repository is an insert: a
data operation at runtime, not a migration and a deploy.

| Table | Create posture | Why the difference |
|---|---|---|
| `repos` — `id`, `display_name`, `default_branch`, `host`, `needs_visual_review`, `archived_at` | **Deliberate.** Creating one is an explicit act | A wrong repository aims the merge gate at the wrong repository, and creating one is rare |
| `areas` — `id`, `display_name`, `archived_at` | **Auto-create on first use**, with normalisation: lowercase, trim, collapse separators | It is written on every item, including research and non-code work; blocking that is friction on the most common operation in the system |

`items.repo` and `items.area` become foreign keys, and `items.repo` gains the index that its filters
already assume.

**`default_branch` is nullable.** `null` means genuinely unknown, distinct from any string — never a
guessed constant. It is read at PR-creation time, where an absent value makes a caller ask before
picking a base branch and a wrong string would let it proceed confidently against the wrong one.

**The honest limit:** normalisation kills case and separator variants, not synonyms — `web` and
`website` will coexist. The answer is the one used elsewhere for the same shape: surface
near-duplicates for merging, and promote what recurs. An accepted limit, not a hidden one.

**Archive, never delete** — attribution and history point at these rows.

### 23.2 Per-entity overrides of a setting

Two settings have a per-entity exception, and both are edited here beside the entity rather than on
the settings page: `machines.source_globs` overriding `minting.source_globs`, and
`accounts.budget_windows` overriding `budget.windows` (§17.7). **The override is validated by the
registry's own validator**, so the same typed editor, the same help text and the same cross-boundary
check apply — the override changes the place, never the type. Each row shows whether it carries an
override or is inheriting the setting.

`accounts.vendor` is checked against the registered adapter list on write; a vendor with no adapter is
a setting nobody can act on.

### 23.3 Where it is edited

`/admin`, one page per entity kind, and `standup repo` · `standup area` · `standup machine` ·
`standup account` · `standup person` for the same operations — because a no-server installation must
not be locked out of the one class of data it cannot start without. Same service calls, same
conformance drivers, same rules.

---

## Open, and deliberately so

**`DECISIONS.md` §14 is the canonical open list; five of its six bear on this document** — the exact
band numbers beyond the starting values in §17; whether Codex needs the blocking fallback in practice
(§19); the retention default for `tool_calls`, also §17; whether near-duplicate areas are merged
automatically above a similarity threshold or only ever surfaced for a person to merge (§23.1); and
which substrate carries an installation that has no database of its own (§20). The sixth is how far
the front end goes beyond a single board view, which this document does not describe. Anything else
settled in principle but not yet to the field level is a gap to be found by building, not a thread
recorded somewhere else.

**The command-line-versus-MCP split is not on that list**, because §20 settles it: the command line
is a full adapter, and `wait_for_crew` stays off MCP for the one reason that has nothing to do with
surface area — only a shell call can be backgrounded.
