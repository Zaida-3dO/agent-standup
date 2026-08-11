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
| `parent_id` | `text` null → `items.id` | Null = a project (a root). Otherwise the item this sits under. Unbounded depth; guarded by `MAX_ITEM_DEPTH`. |
| `kind` | enum | `project` (depth 0) · `task` (depth 1) · `subtask` (**depth ≥ 2** — nesting is unbounded, so everything deeper is still a subtask). Derived from depth, stored for cheap querying. **Recompute the whole subtree on reparent**, not just the moved row: promoting a subtask to a root changes its children's kind too. |
| `title` | `text` | One line. |
| `body` | `text` | The brief — the durable instruction for whoever picks this up next. |
| `state` | enum | See §1.1. The only thing transitions move. |
| `priority` | enum | `P0`–`P3`. |
| `origin_type` | enum | `person` · `source` · `auto` — who or what created it. |
| `origin_person` | `text` null → `people.id` | Required iff `origin_type = person`. **A reference, never a name in the schema** — more than one person mints work, and the core should know none of them by name. Which *file* a `source` item came from is already on `source_ref`. |
| `area` | `text` | **Required.** Which part of your work this concerns. Works for research and non-code work. |
| `repo` | `text` null | Concrete repo key, only when code is involved. |
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

**No `review_round` column** — it's `max(artifacts.review_round)` for the item. Artifacts are the truth;
a second copy here would drift.

**Indexes:** `(state)`, `(parent_id)`, `(area)`, `(state, priority)`, `(source_ref)`.

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

**Validation: at least one bucket must be present.** A rule with neither matches everything and fires
on every change — a footgun, not a feature.

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
| `item_id` | `text` null → `items.id` | Null for system-level events. |
| `ts` | `timestamptz` | |
| `actor_type` | enum | `person` · `agent` · `system`. |
| `actor_id` | `text` null | → `people.id` or `agents.name` depending on `actor_type`. Null for `system`. |
| `session_id` | `text` null | |
| `assignment_id` | `uuid` null → `assignments.id` | Set on `checkpoint` and other per-agent events. |
| `body` | `text` null | Prose for `checkpoint`, `note`, `nudge`, `escalation`. **A column, not payload** — slice reads on the hottest path would otherwise drag text nobody asked for, and it's cheap to exclude here. |
| `type` | enum | `field-change` · `state-change` · `claim` · `release` · `takeover` · `review-requested` · `review` · `merge` · `dispatch` · `dispatch-claimed` · `checkpoint` · `nudge` · `escalation` · `note`. An enum, not text — a typo would silently create a phantom event class that every count then misses. `note` is the escape hatch, so no `custom` is needed. **Postgres can't remove an enum value**, so add one only when the code that emits it exists. |
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
| `checkpoint` | *(none — prose is in `body`, agent is in `assignment_id`)* |
| `nudge` | `{kind}` — text in `body` |
| `escalation` | `{to_person}` — reason in `body` |
| `note` | *(none — text in `body`)* |

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

## 4. Checkpoints — an event type, not a table

**No `checkpoints` table.** A checkpoint is `events` with `type = 'checkpoint'` and `assignment_id` set.

The surviving satellite tables each have a *structural* reason to exist — `artifacts` is referenced by
transition guards, `summaries` is 1:1 and heavily validated. Checkpoints have none: append-only,
referenced by nothing, no cardinality rule. They are a thing that *happened*, which is what `events` is
for. (`comments` failed the same test later and was cut too — §7.)

- **Per agent, not just per item** — `assignment_id` carries that, so a stalled builder still has its own
  resume point.
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
| `needs-approval` | A minted `item_id` that is `blocked` with `blocked_on_type = person` | The linked item isn't actually blocked on someone |
| `descoped` | Nothing — no work is being deferred | — |

`descoped` is the tiny-and-benign case: a deliberate decision not to do something, recorded as a
decision rather than a failure.

**There is no reason code for *ran out of time*, *too hard*, or *will do later*.** They can't be
expressed, so a task can't quietly carry them to completion.

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
| `kind` | enum | `plan` · `plan-review` · `code-review` · `visual-review` · `test-run` · `commit` · `screenshot` · `other`. The **thing** and its **review** are separate rows — as `commit` and `code-review` already were, so `plan` and `plan-review` follow the same shape. |
| `verdict` | enum null | `approved` · `changes-required` · `n/a`. Null on artifacts that aren't reviews — a plan document has no verdict; its `plan-review` does. |
| `review_round` | `int` | Which round this belongs to. |
| `commit_sha` | `text` null | What it applies to — the "at tip" check. |
| `body` | `text` null | Review text, stored inline: queryable, survives a repo move. |
| `ref` | `text` null | Path or URL for binaries (screenshots). |
| `browser_session` | `text` null | Which browser session a visual review ran in. An opaque string — the core never learns that any browser-automation tool exists. |
| `created_by_type` | enum | `person` · `agent`. A review by a person and one by a reviewer agent are both evidence. |
| `created_by_id` | `text` | → `people.id` or `agents.name`, per `created_by_type`. |
| `created_at` | `timestamptz` | |

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
| `state_at` | state enum, null | Item state at the time. **Denormalised deliberately** — it's derivable from `events`, but only via a correlated lookup *per row* on the largest table here, and slicing cost by stage is the whole reason this column exists. Null for ghost sessions, which have no item. |
| `input_tokens` | `int` | |
| `output_tokens` | `int` | Prices ~5× input — never fold into a single total. |
| `cache_write_tokens` | `int` | 1.25× (5-min TTL) or 2× (1-hour). |
| `cache_read_tokens` | `int` | 0.1×. |
| `usage_5h` | `numeric` null | Snapshot carried by the hook — keeps the server's budget picture fresh without it holding credentials. |
| `usage_weekly` | `numeric` null | Same. |

**Retention** configurable, off by default. Volume is small — tens of thousands of rows per busy week.

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
| `started_at` | `timestamptz` | |
| `ended_at` | `timestamptz` null | Null while running. |
| `model` | `text` | **Exact vendor model ID**, per §2 — required to recompute `cost` from the token counts, and to keep scoring buckets from merging different model generations. |
| `effort` | `text` | Literal effort value. |
| `selection_reason` | enum | `recommended` · `exploration` · `override` · `pinned`. Why this model was used. `override` is the valuable one — an agent rejecting the soft-deny — because whether overridden runs go better or worse is the picker's own report card. |
| `recommendation_strength` | `numeric` null | Confidence at dispatch time. Low strength is what licenses an exploration in the first place. |
| `input_tokens` | `bigint` | **The facts.** Four separate counts — they price at wildly different rates, so a single total destroys the information. |
| `output_tokens` | `bigint` | |
| `cache_write_tokens` | `bigint` | |
| `cache_read_tokens` | `bigint` | |
| `cost` | `numeric` | Denormalised convenience for sorting and rollups. **Recomputable** from the counts + `model`; the counts are the truth. |
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
`DISPATCH_FAILED_AFTER_SECONDS`. More awkward than reading a null column — but it runs every five
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

### `machine_accounts`

| Field | Type | Meaning |
|---|---|---|
| `machine` | `text` → `machines.name` | Composite PK with `account_id`. |
| `account_id` | `text` → `accounts.id` | Which accounts this machine can dispatch against. |

Bands and the pace line key off **`account_id`**, and the future case — *dispatch against whichever
account has headroom* — becomes an ordinary query rather than a redesign.

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
| `merged` | Plus `commit_sha`, plus an approving `code-review` artifact at the current `max(artifacts.review_round)`; plus an approving `visual-review` artifact iff `needs_visual_review`; plus an auth check per `merge_authority`. |
| `backlog` from in-progress | No live `assignments` row. |

`POST …/transition?dry_run=true` validates and returns the would-be rejection without mutating.

---

## 17. Environment configuration

| Variable | Values | Meaning |
|---|---|---|
| `DATABASE_URL` | connection string | Postgres. |
| `BIND` | address | Interface the service listens on. |
| `PORT` | int | Port it listens on. |
| `MAX_ITEM_DEPTH` | int, default `6` | Runaway guard on the item tree. |
| `DEFAULT_MERGE_AUTHORITY` | enum | Product default `needs-approval`; an installation that trusts its agents sets `agent-judgement`. |
| `SUBAGENT_DELEGATION` | `never` · `allowed` · `required` | What an orchestrator may do itself. `never` blocks spawning; `allowed` nudges toward delegating; `required` blocks the orchestrator doing the work. Product default `allowed`; an installation that always runs a crew sets `required`. Only fires when an orchestrator role exists, so a single-agent installation is never affected. |
| `POLL_INTERVAL_SECONDS` | default `300` | How often each machine asks for work. |
| `WAIT_FOR_CREW_TIMEOUT` | default `240` | **240, not 300** — the cache TTL drops to 5 min under usage overage, and nothing signals it. |
| `STALE_AFTER_SECONDS` | default `900` | Quiet → `stalled`. PID check first; this is the fallback. |
| `DEAD_AFTER_SECONDS` | default `1800` | Stalled → `dead`, claim released. |
| `DISPATCH_FAILED_AFTER_SECONDS` | default `180` | No session against a dispatch → launch failed. |
| `RESUME_ATTEMPTS_BEFORE_BLOCKED` | default `3` | Attempts with no durable progress before escalating to a person. |
| `BUDGET_ENABLED` | bool | Master switch. |
| `BUDGET_WINDOWS` | object per window | Each: `enabled`, and band boundaries for `free` / `selective` / `wind_down` / `stop`. A boundary is a constant, or `slope × elapsed + offset`, or an ordered list of *(when, value)* pairs. For example: weekly wind-down `15 × days − 5`; 5-hour `80`, rising to `92` in the final hour. |
| `BUDGET_VENDOR` | `anthropic` · … | Which adapter reads usage. Codex is a separate object, not a rewrite. |
| `MODEL_PICKER_ENABLED` | bool, default **off** | Mechanism ships in v1; heuristics fill in once there's data. |
| `MODEL_PICKER_EXPLORE_RATE` | 0–1 | How often to deliberately try one tier down on low-risk work. Without it, it never learns. |
| `NOTIFY_DOC` | path, null = notifications off | Doc explaining how to reach people. **Required if any notification rule exists**, or rules would fire with nowhere to go. |
| `VISUAL_REVIEW_DOC` | path, null = visual review unavailable | Doc explaining how a visual review is performed here. **Required if any item sets `needs_visual_review`** — otherwise the item reaches the gate with no way through it. |
| `SOURCES` | list of globs | Where minting looks. Scanned locally, hashed, reported on the poll. |
| `BACKLOG_LOW_THRESHOLD` | default `3` | On-deck count below this triggers a mint request. |
| `RETENTION_DAYS` | null = keep | Applies to `tool_calls` only. |
| `HOOK_VERSION_REQUIRED` | semver | Handshake compares; stale → tells the session to update. |

**Capabilities are named config values, not a generic map.** A capability is a path *plus the moment the
core hands it over* — and that moment is code, so one can never be added by configuration alone. A map
would give up type safety and per-capability validation (`NOTIFY_DOC` and `VISUAL_REVIEW_DOC` have
different required-ness rules) in exchange for flexibility that doesn't exist. Same reasoning as facets
being a fixed union.

**Both docs are validated at config time, not at transition time** — a missing one should fail on
startup, not strand an item at a gate three days later. The core checks the path exists and never reads
it.

---

## 18. What an agent sees — the MCP tools

Deliberately small. MCP servers exposing sixty-odd tools are easy to find, and every one of those descriptions sits in context on every turn whether or not it is used.

| Tool | Description as the agent reads it |
|---|---|
| `get_item` | Fetch one item plus a summary of its children. |
| `list_items` | Filter by state, area, parent, assignee, repo, priority. |
| `my_work` | What you hold right this moment, and in what role. |
| `orientation` | **Catch me up.** Latest checkpoint, current state, events since that checkpoint, open loops, crew and worktree state. What a fresh session reads instead of being resumed. |
| `create_item` | Create a project, task or subtask. `parent_id` optional. |
| `update_item` | Change non-state fields. |
| `transition` | Move to a new state. Validates required fields. `dry_run` to preview a rejection. |
| `complete` | Finish an item. **Separate from `transition` on purpose** — the required summary shape is in this tool's schema, where the agent can see it. |
| `checkpoint` | Record what you tried, what you ruled out, what's next. |
| `note` | Leave a timestamped remark on an item. |
| `claim` | Take ownership of an item in a role. Atomic — two agents can't both win. |
| `release` | Give up ownership. |
| `heartbeat` | Still alive. (Usually unnecessary — the hook does it.) |
| `get_crew_name` | Request a name for a new agent. |
| `crew_status` | Non-blocking digest of what your crew is doing. |

**Not exposed as MCP:** `wait_for_crew`. It's the `standup` CLI binary, because only a Bash call can be backgrounded — and backgrounding is the whole point.

## 19. HTTP endpoints

Same service, different consumers.

**Agent-facing** — one per MCP tool above, plus:

| Endpoint | Purpose |
|---|---|
| `POST /items/{id}/transition?dry_run=` | The validated move. |
| `GET /items/{id}/orientation` | The resume payload. |
| `GET /crew/wait?timeout=240` | **Long-poll.** Returns on a crew event or timeout, whichever first. The CLI's target. |

**Machine-facing:**

| Endpoint | Purpose |
|---|---|
| `POST /poll` | Launcher. Sends machine, live sessions, usage snapshot, pending source hashes. Returns zero or more dispatches, each with a server-composed prompt. |
| `POST /hook` | The dumb pipe. Sends event type, session, tool, command. Returns allow/deny for guarded patterns, or nudge text, or nothing. |
| `POST /sessions/{id}/register` | Handshake. Reports hook version; server replies with what to update. |

**Human-facing:**

| Endpoint | Purpose |
|---|---|
| `GET /board` | Items grouped by derived column. |
| `GET /events?since=` | Since-your-last-visit. A **slice**, never the whole ledger. |
| `POST /events/{id}/seen` | Mark read. Optionally carries facet scores. |
| `GET /items/{id}` | Read one item for the UI. |
| `PATCH /items/{id}` | Edit non-state fields. |
| `POST /items/{id}/notes` | Leave a timestamped remark (an `events` row of type `note`). |
| `GET /authorizations?scope=` | Is there a standing auth covering this? |

---

## Open, and deliberately so

Three things, and they are the whole list: the CLI-vs-MCP split for anything beyond `wait_for_crew`;
whether Codex needs the blocking fallback in practice; and the exact band numbers beyond the starting
values in §17. Anything else settled in principle but not yet to the field level is a gap to be found
by building, not a thread recorded somewhere else — `DECISIONS.md` §14 is the canonical open list.
