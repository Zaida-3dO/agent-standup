# Backfill — loading an existing body of work

Most installations do not start empty. If you already track work somewhere — a directory of files, a
spreadsheet, another tracker — backfill is how that history arrives here: items, their event log,
who worked them, and the artifacts produced against them, in one call.

**You write a converter; this application defines the shape.** The contract below is the whole
interface. Anything that can produce this JSON can load into this application, and the application needs to
know nothing about the shape the data was read from.

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
  "statusAliases": { "in-flight": "executing", "shipped": "merged", "shelved": "paused" },
  "verdictAliases": { "looks-good": "lgtm", "looks-good-with-nits": "lgtm_with_nits" },
  "tasks": [
    {
      "id": "T-19700101-example-one",
      "title": "One line",
      "body": "# The brief\n\nThe durable instruction for whoever picks this up next.\n",
      "status": "in-flight",
      "area": "web",
      "repo": "web-app",
      "priority": "P1",
      "branch": "task/example-one",
      "needsVisualReview": true,
      "sourceRef": "example-one/source.json@0123456789abcdef",
      "createdAt": "1970-01-01T00:00:00Z",
      "updatedAt": "1970-02-01T00:00:00Z",
      "originType": "person",
      "originPersonId": "user-a",
      "mergeAuthority": "needs_approval",
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
          "verdict": "looks-good-with-nits",
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

### `status` — you supply the mapping, this application supplies the states

Every source has its own state machine, so **this application ships its own states and no table
translating anybody else's words into them.** You map your vocabulary onto ours in `statusAliases`,
exactly as you map repos and actors. That is the whole reason this contract is portable: nobody has
to edit application source to import from a system it has never seen.

These are the twelve states you map onto:

| State | Means |
|---|---|
| `someday` | Not scheduled; a pool to re-source from. |
| `on_deck` | Ready to be picked up. |
| `planning` · `plan_review` | A plan is being written, or reviewed. |
| `executing` | Being worked now. |
| `in_review` | Work done, under review or awaiting merge. |
| `paused` | Deliberately not progressing. |
| `blocked` | Waiting on something outside the work. |
| `merged` · `research_done` | Finished. |
| `wont_do` · `cancelled` | Closed without finishing. |

```jsonc
"statusAliases": { "in-flight": "executing", "shipped": "merged", "shelved": "paused" }
```

Several of your statuses may legitimately land on one of ours — a pipeline that distinguishes
"code review", "review approved" and "ready to merge" has one destination here, `in_review`. **That
collapse is lossy in the column and reversible in the row:** put your original status in
`customFields`, and it survives verbatim on the item.

A status with no alias falls back to a small default vocabulary this application uses for its own
command-line surface (`todo`, `in-progress`, `review`, `waiting`, `done`). **A status in neither is
refused**, never defaulted — guessing files somebody's work under a state they never chose.

### `verdict` — you supply the spelling, this application supplies the values

Same shape as `status`, for the same reason. This application stores six verdicts:

| Verdict | Means |
|---|---|
| `lgtm` | Passed. |
| `lgtm_with_nits` | Passed, with cosmetic notes recorded. |
| `lgtm_with_followups` | Passed, with follow-up work recorded. |
| `changes_required` | Did not pass. |
| `approved` | An accepted synonym of `lgtm`. |
| `na` | The artifact carries no verdict. Also what an absent verdict becomes. |

`approved` is kept rather than replaced by `lgtm`: removing a label from a Postgres enum is a type
rebuild rather than an `ALTER`, so every verdict already on record keeps meaning exactly what it
meant.

```jsonc
"verdictAliases": { "looks-good": "lgtm", "looks-good-with-nits": "lgtm_with_nits" }
```

Punctuation counts. If your source writes `lgtm-with-nits`, say so — this application stores
`lgtm_with_nits` and **will not guess that a hyphen was meant to be an underscore**. That is
deliberate: a normalising transform would quietly accept `lgtm-with-nitpicks` too, and fail deep
inside an insert instead of at the mapping. A verdict with no alias is taken literally and refused
if it is not one of ours — refusal is the point, because a verdict decides whether a change passed.

**Verdicts are checked against the database's own enum before anything is written.** A build can
know a verdict whose migration has not been applied to the database you are pointing at; rather
than failing partway through a bulk insert with an opaque enum error, the run refuses up front,
naming every value the database cannot store and what to do about it.

### `repo` — refused, never invented

`repo` is resolved through `repoAliases` onto an **existing** `repos.id`. A label with no entry is
refused and the task that names it does not load. This is deliberate: a repo is what the merge gate
reads to decide which repository a change lands in, so a wrong one aims the gate at the wrong place.
Create your repos first with `standup repo create`, or let the runner mint them with
`--create-missing-repos` (below).

**These are not interchangeable when `repoAliases` is populated.** An alias says "my label `web-app`
means the repo `web` that is already in `repos`" — it asserts one, it does not ask for one — so
`--create-missing-repos`
mints the *unaliased* labels only and never an alias's target. An alias pointing at a repo that does
not exist is refused up front, naming every offending label and target at once, rather than failing
later on a foreign key.

`area`, by contrast, is auto-created and normalised — it is required on every item, and blocking the
most common write in the system is friction nobody should pay.

### `actorAliases` — who an event is attributed to

Every `history[].actor` must resolve. An unmapped actor is refused rather than guessed at: guessing
attributes somebody's history to the wrong row, silently and invisibly. Three actor types:
`person` (`actorId` is a `people.id`), `agent`, and `system` — which takes `actorId: null`, for a row
your store attributed to no one.

The runner below will derive `agent` entries for you on a first pass. **It names nobody**: anything
that should be a `person` has to be stated in the payload.

### `history` — every entry is kept; finished work shares one row

A task whose current state is terminal (`merged`, `research_done`, `wont_do`, `cancelled`) has its
history **folded into one event** rather than one event per entry. Finished work is most of the
volume of an established backlog and the least useful part of it to have spread over thousands of
rows nobody reads one at a time. In-flight and blocked tasks import their full history, one row per
entry.

**The fold is about rows. No text is discarded.** Every entry's prose is kept on the summary event —
as readable, attributed, timestamped lines in `body`, and structured per entry (`legacy_id`, `actor`,
`at`, `note`) in `payload.entries`. A terminal task's history is therefore complete in the database,
at one row instead of many.

This is deliberate rather than incidental, because a caller is often importing *precisely because*
the source it is reading is about to be retired — in which case anything dropped here would be gone
rather than
merely absent. The importer counts what it folded and the runner reads every entry back out and
names any that are missing (§5), so "nothing was lost" is a checked claim and not a promise.

---

## 2. What has no home in the schema

Backfill is faithful, not lossless, and the difference is worth knowing before you rely on it.
Everything below is a real gap, named:

| What | What happens to it |
|---|---|
| **Event timestamps** | Every imported event's `ts` is the **import moment**, not the historical one. The original is preserved in `payload.source_at` (and on every element of `payload.entries`), but sorting `events` by `ts` clusters an import at one instant. This is the largest remaining gap. |
| **One event per finished task** | A terminal task's entries share a single `events` row instead of getting one each, so an entry is not individually addressable as a row. **No text is lost** — see `history` above — and the count is reported as `folded into a terminal task's single event`. Purely a shape difference, but it is a real one and it is why an event count is smaller than an entry count. |
| **`drive_mode`** | Fixed at `autonomous`; no contract slot. Set it afterwards if an imported item should be supervised. |
| **`parent_id` · `difficulty` · `estimated_cost` · `notify` · `completed_at`** | Not in version 1. Everything imports as a flat, unparented `task`. |
| **A second, third, … repo on one task** | `items.repo` holds one. Put the full list in `customFields`. |
| **A pipeline status finer than `items.state`** | Four review-stage statuses collapse onto `in_review`. Preserve yours in `customFields`. |
| **Two passing verdicts** | `Verdict` has one passing value (`approved`). A "passed with notes" verdict lands on `approved`; keep the distinction in the artifact's `body`. |
| **An artifact kind outside the enum** | Lands on `other`. The original label survives in `body`/`ref`. |
| **`pause_reason` · `resume_condition` · `blocked_reason`** | Not populated. A task imported as `paused` carries no reason column, though `customFields` can hold yours. |
| **A person as an item's origin** | `originType: "person"` needs `originPersonId` to name an existing `people.id`. If your source records a name rather than an id, either seed the person first or import as `source` and keep the name in `customFields`. |
| **A role outside the six** | Lands on `custom`, with your own name in `role_custom`. Nothing is lost, but it is not filterable as a first-class role. |
| **A claim with no session, machine, or claim time** | Those columns are NOT NULL. A converter has to supply something deterministic; say what you chose in your converter's own documentation. |

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
> the surface genuinely is exposed and it writes history directly. Treat it as the deliberate, bounded
> operation it is — open it, run the load, verify, close it. The intended lifetime of a window is minutes, not days.

### Three doors

**A shell, against a database you name** — the door used when going live, and the only one that
verifies afterwards:

```bash
node scripts/backfill.mjs --payload payload.json --database-url "$DATABASE_URL" \
  --create-missing-repos --twice
```

`--twice` runs the whole load twice and reports whether the second run inserted anything. It must
insert nothing. This script does not check `ENABLE_BACKFILL` — it is not a served surface; whoever
runs it already has the database URL in hand, which is strictly more access than the gate protects.

**Run it from a source checkout, not from inside the deployed container.** It bundles the runner
with `esbuild`, a development dependency, and the shipped image carries neither that nor `src/`. The
image is the wrong place for it anyway: it needs only a database URL, and a checkout on any machine
that can reach the database will do.

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

The failure mode of a bulk load is "it said it worked", so the runner checks four things after it
writes:

- **A history reconciliation that has to sum.** It starts from the entries *your payload contained*
  and accounts for every one: imported as their own event, or folded into a terminal task's single
  event. If those do not add up to the input, the report says so.
- **History retention, read back out of the database.** Every source entry id is looked up — as an
  event's own `legacy_id`, or inside a summary's `payload.entries` — and anything absent is named.
  **This is the check that can contradict the importer.** A row count cannot: it derives its
  expectation from the same rule the fold uses, so it computes one row for a finished task, finds
  one row, and reports a match no matter how much that row threw away. Retention counts what you
  supplied instead, so the only way to make it clean is to actually keep the data. A run that loses
  history exits non-zero.
- **Row counts**, per table. Note this asserts the database contains *exactly* this payload and
  nothing else: it reports any imported row absent from your payload as unexpected. That is right
  for the intended single load into an empty database and will report a false failure if you split
  one import across several payloads.
- **A spot check**, field by field, on a sample spread across the whole payload rather than the
  first N — and **idempotency** (`--twice`), where the second run must insert zero rows.

The state comparison is made against an **independently written** table of this application's own
vocabulary (`src/lib/import-verify.ts`), never by calling the function the importer used to write
it. If both sides derived "expected" from one table, a bug in that table would corrupt both halves
identically and the check would report clean against a genuinely wrong database. A caller-supplied
`statusAliases` is read on both sides, which is not the same hazard — that is input data, exactly
like a title.
