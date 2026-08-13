# Backfill — loading an existing body of work

Most installations do not start empty. If you already track work somewhere — a directory of files, a
spreadsheet, another tracker — backfill is how that history arrives here: items, their event log,
who worked them, and the artifacts produced against them, in one call.

**You write a converter; this application defines the shape.** The contract below is the whole
interface. Anything that can produce this JSON can load into this application, and nothing about the
application knows or cares what your existing store looks like.

---

## 1. The shape

```jsonc
{
  "version": 1,
  "defaultArea": "imported",
  "repoAliases": { "web-app": "web" },
  "actorAliases": {
    "system": { "actorType": "system", "actorId": null },
    "worker-a": { "actorType": "agent", "actorId": "worker-a" },
    "someone": { "actorType": "person", "actorId": "user-a" }
  },
  "tasks": [
    {
      "id": "T-19700101-example-one",
      "title": "One line",
      "body": "# The brief\n\nThe durable instruction for whoever picks this up next.\n",
      "status": "executing",
      "area": "web",
      "repo": "web-app",
      "priority": "P1",
      "branch": "task/example-one",
      "needsVisualReview": true,
      "sourceRef": "example-one/status.json@0123456789abcdef",
      "customFields": { "source_status": "executing" },
      "history": [
        { "id": "example-one:h:1", "actor": "system", "at": "1970-01-01T00:00:00Z", "note": "created" }
      ],
      "claims": [
        {
          "id": "example-one:role:lead",
          "sessionId": "session-1",
          "role": "orchestrator",
          "holderType": "agent",
          "holderId": "worker-a",
          "machine": "laptop",
          "claimedAt": "1970-01-01T00:01:00Z",
          "releasedAt": null
        }
      ],
      "reviews": [
        {
          "id": "example-one:artifact:r01",
          "kind": "code_review",
          "verdict": "approved",
          "reviewRound": 1,
          "commitSha": "abc1234",
          "body": "{\"verdict\":\"lgtm\"}",
          "ref": "example-one/reviews/r01.json",
          "createdByType": "agent",
          "createdById": "worker-a",
          "createdAt": "1970-01-02T00:00:00Z"
        }
      ]
    }
  ]
}
```

The authoritative definition is `src/lib/backfill/contract.ts`. It is **strict**: an unrecognised key
is refused rather than ignored, so a typo in a converter surfaces immediately instead of silently
dropping the data it meant to send. `version` is checked against the literal above — a converter
written for one version is never half-accepted by another.

### Required per task

`id` · `title` · `body` · `status`. Everything else is optional.

`id` is **your** identifier. It is preserved as `custom_fields.legacy_id` and it is what makes the
load re-runnable: a task whose id is already present is skipped, never re-inserted or overwritten.

### `status` — the vocabulary

`status` is remapped onto `items.state`. Two vocabularies are recognised (`STATUS_REMAP` and
`PIPELINE_STATUS_REMAP`, `src/lib/import-items.ts`). **A status in neither is refused**, not
defaulted — an unrecognised status is a mapping gap to fix, and guessing would silently misfile work.

| Your status | Lands on |
|---|---|
| `todo` · `not-started` · `plan-approved` · `staged` | `on_deck` |
| `backlog` | `someday` |
| `planning` | `planning` |
| `plan-review` | `plan_review` |
| `in-progress` · `executing` | `executing` |
| `review` · `code-review` · `review-approved` · `visual-review` · `visual-approved` · `ready-for-merge` | `in_review` |
| `waiting` · `parked` · `awaiting-merge-auth` | `paused` |
| `done` · `merged` | `merged` |
| `cancelled` | `cancelled` |

Several statuses collapse onto `in_review`, because `items.state` has one value for "finished, not
yet merged" and a pipeline-shaped source may have four. **Put your original status in
`customFields`** (the examples use `source_status`) and the collapse stays reversible.

### `repo` — refused, never invented

`repo` is resolved through `repoAliases` onto an **existing** `repos.id`. A label with no entry is
refused and the task that names it does not load. This is deliberate: a repo is what the merge gate
reads to decide which repository a change lands in, so a wrong one aims the gate at the wrong place.
Create your repos first (`standup repo create`, or `--create-missing-repos` on the runner below).

`area`, by contrast, is auto-created and normalised — it is required on every item, and blocking the
most common write in the system is friction nobody should pay.

### `actorAliases` — who an event is attributed to

Every `history[].actor` must resolve. An unmapped actor is refused rather than guessed at: guessing
attributes somebody's history to the wrong row, silently and invisibly. Three actor types:
`person` (`actorId` is a `people.id`), `agent`, and `system` — which takes `actorId: null`, for a row
your store attributed to no one.

The runner below will derive `agent` entries for you on a first pass. **It names nobody**: anything
that should be a `person` has to be stated in the payload.

### `history` — full or collapsed

A task whose current state is terminal (`merged`, `research_done`, `wont_do`, `cancelled`) has its
history collapsed into **one** summary event rather than one row per entry. Finished work is most of
the volume of an established backlog and the least-queried part of it. In-flight and blocked tasks
import their full history, one row per entry.

---

## 2. What has no home in the schema

Backfill is faithful, not lossless, and the difference is worth knowing before you rely on it.
Everything below is a real gap, named:

| What | What happens to it |
|---|---|
| **Event timestamps** | Every imported event's `ts` is the **import moment**, not the historical one. The original is preserved in `payload.source_at`, but sorting `events` by `ts` clusters an import at one instant. This is the largest single gap. |
| **A second, third, … repo on one task** | `items.repo` holds one. Put the full list in `customFields`. |
| **A pipeline status finer than `items.state`** | Four review-stage statuses collapse onto `in_review`. Preserve yours in `customFields`. |
| **Two passing verdicts** | `Verdict` has one passing value (`approved`). A "passed with notes" verdict lands on `approved`; keep the distinction in the artifact's `body`. |
| **An artifact kind outside the enum** | Lands on `other`. The original label survives in `body`/`ref`. |
| **`pause_reason` · `resume_condition` · `blocked_reason`** | Not populated. A task imported as `paused` carries no reason column, though `customFields` can hold yours. |
| **A role outside the six** | Lands on `custom`, with your own name in `role_custom`. Nothing is lost, but it is not filterable as a first-class role. |
| **A claim with no session, machine, or claim time** | Those columns are NOT NULL. A converter has to supply something deterministic; say what you chose in your converter's own documentation. |
| **`completed_at` · `difficulty` · `estimated_cost` · `notify` · `parent_id`** | Not part of version 1 of the contract. Everything imports as a flat, unparented `task`. |

If a gap matters to you, `customFields` is the escape hatch — an untyped bag, opaque to the
application, that keeps anything the columns cannot. Its own rule applies: **if a key recurs across
installations, it should become a column**, not live there forever.

---

## 3. Running it

### The gate — `ENABLE_BACKFILL`

**Backfill is off by default and the surface does not exist until it is deliberately opened.**

```
ENABLE_BACKFILL=true
```

Exactly that string. **Anything else — unset, empty, `1`, `yes`, `TRUE`, `false` — leaves it
closed.** The gate fails closed on purpose: a gate that is open for every value its author did not
think of is not a gate.

It is an environment variable rather than a stored setting for two reasons. It decides whether an
endpoint exists at all, which is bootstrap by the usual test; and the toggle lives in the deployment
layer, so nothing reachable over HTTP, MCP or the command line can turn it on for itself.

When it is open the process says so, loudly, at startup, and `GET /api/health` reports
`backfillEnabled: true`. Nothing is logged when it is closed, so that line means something.

> **Operational rule: run a backfill window when nothing else is running.** While the window is open
> the surface genuinely is exposed and it writes history directly. Treat it like the cutover it is —
> open it, run the load, verify, close it. The intended lifetime of a window is minutes, not days.

### Three doors

**A shell, against a database you name** — the door used during a cutover, and the only one that
verifies afterwards:

```bash
node scripts/backfill.mjs --payload payload.json --database-url "$DATABASE_URL" \
  --create-missing-repos --twice
```

`--twice` runs the whole load twice and reports whether the second run inserted anything. It must
insert nothing. This script does not check `ENABLE_BACKFILL` — it is not a served surface; whoever
runs it already has the database URL in hand, which is strictly more access than the gate protects.

**The command line, against a running server:**

```bash
standup backfill run --file payload.json
```

**HTTP:**

```bash
curl -X POST http://<host>/api/backfill -H 'content-type: application/json' \
  -d '{"payload": { ... }}'
```

**Not MCP.** An MCP tool list is sent to the model on every session, so every registered tool costs
context permanently. A one-shot bulk load that is disabled during normal operation is the wrong thing
to pay that for. It is a recorded waiver, with its reasoning, in `src/lib/adapters/waivers.ts`.

---

## 4. It bypasses the state machine — what bounds that

Backfill writes `items.state` directly, so it can produce an item in a state the transition guards
would never have allowed it to reach. That is the point of an import — an item that finished last
March cannot be created and then walked through eleven transitions — but it is worth being plain
about what keeps it from becoming a hole:

1. **The surface does not exist unless deliberately opened**, and cannot open itself.
2. **It cannot reach a state the state machine does not have.** The state is not taken from the
   caller; it is remapped through a table that refuses an unrecognised status.
3. **It creates; it never updates.** A task already present is skipped. So it cannot be used to move
   an *existing* item into a state a guard would have refused — which is the escalation that would
   actually matter.
4. **It is transactional.** Everything lands or nothing does, so a failure partway through cannot
   leave a half-imported graph behind.

The residual, stated rather than hidden: while the window is open, a caller who can reach the API can
insert history. That is why the window is short, announced, visible on the health endpoint, and
opened when nothing else is running.

---

## 5. Verifying the load

The runner checks three things after it writes, because the failure mode of a bulk load is "it said
it worked":

- **Row counts**, per table, against what the payload contained.
- **A spot check** — field by field, on a sample spread across the whole payload rather than the
  first N.
- **Idempotency** (`--twice`) — the second run must insert zero rows.

The state comparison is made against an **independently written** remap table
(`src/lib/import-verify.ts`), not by calling the same function the importer used to write it. If both
sides derived "expected" from one table, a bug in that table would corrupt both halves identically
and the check would report clean against a genuinely wrong database.
