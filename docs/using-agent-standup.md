# Using Agent Standup

**For an agent that _uses_ the tracker.** Not for someone changing it — that is
[`CLAUDE.md`](../CLAUDE.md), which is about contributing to this repository and will not help you
here.

You are probably reading this because you were dispatched to work an item and the tool calls started
refusing you. Everything below is a fact about the product, true in any workspace.

---

## The one habit worth building: ask the server, don't guess

```
describe_tool                       # what this build is, and the limits it enforces
describe_tool {tool: "claim"}       # one tool's full contract
```

**`describe_tool` states the conditional rules a schema cannot.** A JSON schema can say `sessionId`
is a string; it cannot say the row that `sessionId` names must already exist. Those rules are the
ones that refuse you, and they are written out in the `rules` array.

Call it **before your first use of any write tool** — `claim`, `checkpoint`, `record_artifact`,
`complete_item`, `transition_item`. It costs one call and it is the difference between a refusal you
predicted and twenty minutes of rediscovery.

> **A `rules` entry is evidence of presence, never of absence.** It reports what an operation
> _declares_. An empty array means "this operation declares no conditional rules here", **not** "this
> operation has no requirements" — a check that reads the database cannot always be expressed as a
> declared rule. To establish that something is _not_ required, read the source or make the call.
> This exact inference has been got wrong twice, in both directions, by people acting in good faith.

`standup service info --json` is the same idea for the catalogue as a whole.

---

## Getting a session onto an item

```
register_session {sessionId, machine}
claim {itemId, role, holderType, holderId, sessionId, machine}
```

**Names are issued by the server**, as a side effect of these two calls. You are handed one and you
keep it across repeat calls. Do not invent a name and do not read one from a file.

**Read the top-level `mayClaim`** from `register_session`. It is the real answer, resolved against
the `hook.require_registration_to_claim` setting. The nested `version.*` field is a protocol-version
comparison _alone_, and reports `false` for any session that declared no `hookVersion` — so a nested
`false` beside a top-level `true` is the ordinary healthy shape, not a fault.

Do **not** declare a `hookVersion` you do not actually run to make a number go green.

### If you were dispatched by another agent, `rootSessionId` is not optional

**Pass the ORCHESTRATOR's session id as `rootSessionId`.** Not your own, and not `parentSessionId`
(which records the spawn tree and satisfies no guard).

Claims are **role-scoped**, so an orchestrator and a builder legitimately hold the same item at once
— but only if they are the same crew. `rootSessionId` **defaults to your own `sessionId`**, which
makes you the root of a brand-new crew; the guard then sees the orchestrator's live row as foreign
and refuses with _"already held by another crew"_.

If you were dispatched without it, you can recover: `orientation {itemId}` and read
`crew[].rootSessionId` off the live assignment rows.

> ⚠️ **A malformed `rootSessionId` is accepted.** Nothing validates that it names a real session, so
> a typo produces a successful claim, an assignment attributed to a session that never existed, and
> crew-conflict protection that is silently absent for the whole run. Copy it; do not retype it.

**Check `evicted` on a successful claim.** A non-empty array means you took the item from a holder
that had gone quiet — worth saying out loud rather than passing over. `claim` evicts stale holders
itself, retries exactly once, and never loops; a second refusal is a genuine conflict.

---

## `checkpoint` needs an assignment. `note` does not.

The single most common refusal, and the fix is choosing the right tool **up front**:

|                                                                         | Use it when                                                                              |
| ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| **`note`** (`itemId` + `body`)                                          | You hold nothing. The default for a short dispatch where the orchestrator owns the item. |
| **`checkpoint`** (`itemId` + `sessionId` + `body`, optional `headline`) | You hold a live assignment and want a resume point of your own.                          |

`checkpoint` requires a row on `Assignment` matching **both** `itemId` and `sessionId` with
`releasedAt` unset. That is deliberate: a checkpoint is recorded **per agent**, not per item, so two
sessions on one item keep separate resume points and a stalled builder has its own.

So: `note`, or `claim` first and then `checkpoint`. Either is fine. Deciding mid-task is what costs
you.

**The field is `body`, not `text`.**

---

## Record as you go

Append a short progress line every so often, not only at the end. A long silence is indistinguishable
from a dead session — being absorbed in good work looks identical, from outside, to having died.

A `headline` is the one line a later session reads to pick your work up. Write it for that reader.

---

## Minting work

`create_item` is **deprecated** — it inferred `kind` from whether a parent was passed, so a caller
could not state intent. Use the tool that names it:

- **`create_project`** — a root container. Has no state of its own; its state derives from its
  children, so `transition_item` on a project is refused. **Transition the child, never the project.**
- **`create_task`** — pass `projectId`, or the literal `"inbox"`.
- **`create_subtask`** — pass `taskId`.

All three require **`originType`**. Use `"auto"` unless a person really did ask for it;
`originType: "person"` needs `originPersonId`, and on a fresh database the person table may be empty.

### Work the board never saw

If you did substantial work off-board — the server was down, your token was unset, the task arrived
as a direct instruction — **mint one row afterwards, label it retrospective, and take it straight to
its terminal state.** Use judgement: a ten-minute fix does not earn a row; hours of work with
findings someone will want later does.

**Mint the outcome, never a reconstructed history.** One `create_work`, a body saying what was done
and that it was recorded after the fact, then `complete_item`. Do **not** replay a lifecycle — no
backdated checkpoints, no review artifact for a review nobody performed. An item created and
completed inside a minute while carrying a day's work makes every timestamp a lie, and cycle-time,
staleness detection and run scoring all read that fabricated history as real.

An honest retrospective row is not a fabrication. A replayed lifecycle is.

---

## Artifacts — the evidence the guards read

`record_artifact`, with `kind` one of: `plan` · `plan_review` · `code_review` · `visual_review` ·
`test_run` · `commit` · `historical_verification` · `pull_request` · `check_run` · `screenshot` ·
`merge_override` · `review_evidence_override` · `merge_approval` · `other`.

- Only the three `*_review` kinds take a **`verdict`**: `approved` · `changes_required` · `na` ·
  `lgtm` · `lgtm_with_nits` · `lgtm_with_followups`.
- **`findings` is an array of objects** — `{text, severity?, where?}`, severity
  `info|low|medium|high|critical`. Send the array, not a JSON string.
- A `commit` artifact needs **`commitSha`**. The merge gate reads `commitSha` and **not** `ref`, so a
  sha in the wrong field is evidence that does not count.
- Every artifact records who produced it: pass `createdByType` + `createdById`, or hold a live
  assignment it can be read from. That is what decides whether a _human_ authorised a merge.

**Under `lgtm_with_nits`, a medium/high/critical finding blocks the merge exactly as
`changes_required` would.** `followUpItemId` is what lets a nit survive the merge — the follow-up
guards read it.

### One PR closing several rows

**Record the same `commit` and the same approving `code_review` on every row the PR closes.** There
is no uniqueness constraint on `commitSha` and no duplicate check, so this simply works, and each row
then satisfies the merge gate on its own evidence. You do **not** need a `merge_override` for the
siblings, and you should not write one.

Record them only on rows the PR genuinely closes. A review that examined the whole diff covers every
row in it; a row the PR does not touch gets nothing.

---

## Completing

`complete_item` needs a **structured summary**, and discovering it one field at a time is a waste of
four calls. Send the whole shape first time:

- **`shipped`** — an **array**, 1–5 entries. Not prose.
- **`not_done`**
- **`user_facing`**
- **`how_verified`** — required when `user_facing` is false
- **`branch`**

---

## Reading the board without drowning in it

- **`orientation {itemId}`** is the cheapest useful read: latest checkpoint, what changed, open loops,
  crew.
- **`my_work`** — what your session holds, and in what role.
- **`get_board`** is paginated and defaults to **open work only** (`in_progress` + `waiting`). Filter
  it anyway — `area`, `repo`, `kind`, `state`, `assignee`, `search`, `project`, `level` — because a
  page you did not need is still a page you paid for.
- **`get_item`** returns a slim shape by default. The full record is opt-in via **`full: true`**; pass
  it deliberately and never in a loop. `get_item_body` pages a body too large to return whole.

> **The pagination rule that will bite:** the **cursor is compared against the column you sorted by**,
> so a cursor from one sort must never be passed into another. Pages drawn that way are wrong rather
> than merely odd.

A response may report **`withheld: true`** for a column. That means there may be items you are not
being shown — it is not the same as their absence.

---

## Open loops

One tool, **`loop`**, with an `action`: `add` · `get` · `list` · `edit` · `close` · `delete`. There
are no `loop_add` / `loop_close` tools; the verbs are folded into the one tool.

`kind` is `work` (default), `note`, or `blocked_on_person`; only `work` counts toward the open-work
surfaces. **On `edit`, omitting `kind` leaves it alone** rather than resetting it — the one rule here
you cannot guess from the schema.

Notes and checkpoints remain the right home for narrative. A loop is for something that must survive
the session and be _seen as outstanding_.

---

## The refusals are the product working

A parentless item is a project. `plan_review → executing` needs an approved plan artifact.
Completion needs the structured summary. A claim on a live holder is refused.

These are not obstacles to route around. Each one is a rule that lives in the service layer, which is
why the same refusal arrives whether you came from MCP, the CLI or the API. When one surprises you,
`describe_tool` on that tool is the fastest way to find out what it actually wants.
