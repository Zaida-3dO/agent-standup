// Import verification (MILESTONES.md #13, DECISIONS.md §13h "Import
// verification (#13) is the differential test that does still make sense —
// the same inputs, and the resulting item states compared row by row").
//
// This module adds NO new import logic — #10/#11/#12 (import-items.ts,
// import-events.ts, import-assignments-artifacts.ts) already own writing to
// `items`/`events`/`assignments`/`artifacts`. What's missing after those
// three land is a way to answer, about a run that already happened:
//
//   1. Did every source row that should have landed actually land, and
//      nothing more? (row counts)
//   2. For a sample of tasks, does what's IN the database actually match
//      what the source said, field by field? (spot-check)
//
// Idempotency itself is proved by a TEST that calls the existing importers
// twice and asserts the second run is a no-op (see
// tests/import-verify.test.ts) — #10/#11/#12 already built that property in
// (each is keyed on a stable id and skips what's already there); this
// module's job is only to make the comparison so that property, and simple
// under/over-import bugs, are checkable without a human reading raw SQL.
//
// Reads only. Never writes to `items`/`events`/`assignments`/`artifacts` or
// to the source tree — a verification pass that could itself corrupt state
// would defeat its own purpose.
import type { ItemState, PrismaClient } from "@prisma/client";
import { normalizeAreaKey } from "./areas";
import { TERMINAL_STATES } from "./import-events";
import type { SourceTask } from "./import-items";
import type { SourceTaskAssignmentsArtifacts } from "./import-assignments-artifacts";

/** The minimal client surface this module needs — read-only, mirrors the importers' own narrowing. */
export type VerifyClient = Pick<PrismaClient, "item" | "$queryRawUnsafe">;

// ---------------------------------------------------------------------------
// 1. Row counts
// ---------------------------------------------------------------------------

export interface RowCountReport {
  /** Number of tasks read from the source (`readSourceTasks`'s output length). */
  readonly sourceTaskCount: number;
  /** `items` rows in the database whose `custom_fields.legacy_id` matches one of `tasks`' ids. */
  readonly importedItemCount: number;
  /**
   * Source task ids with no matching `items` row — every one of these is
   * either a genuine import failure or a task the importer was never run
   * against. Empty is the expected, healthy result.
   */
  readonly missingFromDb: string[];
  /**
   * `items` rows matched by `legacy_id` that do not correspond to any id in
   * `tasks` — only possible if the source list handed to this function is
   * itself incomplete relative to what was actually imported (e.g. verifying
   * against a partial re-export). Reported rather than assumed impossible.
   */
  readonly unexpectedInDb: string[];
  /** True iff `sourceTaskCount === importedItemCount` and both lists above are empty. */
  readonly matches: boolean;
}

/**
 * Compares the source task list against what actually landed in `items`,
 * matched by `custom_fields.legacy_id` — the same identity #10's importer
 * keys its own idempotency on. Every source task is expected to have
 * exactly one matching `items` row; #10 imports every task it reads
 * (SCHEMA.md — finished items collapse to a summary row, they are not
 * dropped), so a task present in `tasks` and absent from `items` is always
 * worth investigating, never an expected outcome.
 */
export async function verifyItemRowCounts(
  client: VerifyClient,
  tasks: readonly SourceTask[],
): Promise<RowCountReport> {
  const sourceIds = new Set(tasks.map((t) => t.id));

  const rows = await client.$queryRawUnsafe<{ legacyId: string }[]>(
    `SELECT "customFields"->>'legacy_id' AS "legacyId"
     FROM "Item"
     WHERE "customFields" ? 'legacy_id'`,
  );
  const dbIds = new Set(rows.map((r) => r.legacyId).filter((id): id is string => id !== null));

  const missingFromDb = [...sourceIds].filter((id) => !dbIds.has(id)).sort();
  const unexpectedInDb = [...dbIds].filter((id) => !sourceIds.has(id)).sort();

  return {
    sourceTaskCount: tasks.length,
    importedItemCount: dbIds.size,
    missingFromDb,
    unexpectedInDb,
    matches: missingFromDb.length === 0 && unexpectedInDb.length === 0,
  };
}

export interface EventRowCountReport {
  /**
   * Per source task: how many `events` rows are EXPECTED — 1 for a
   * terminal-state task (collapsed summary, DECISIONS.md §13c) regardless of
   * how many history entries it had, or the raw entry count for an
   * in-flight/blocked task. 0 for a task with no history at all.
   */
  readonly expectedTotal: number;
  /** Actual count of `events` rows carrying `payload.legacy_id` for these tasks' `items` rows. */
  readonly actualTotal: number;
  /** Source task ids whose expected event count does not match what's in the database. */
  readonly mismatched: string[];
  readonly matches: boolean;
}

/**
 * Compares the source history logs against `events`, applying the SAME
 * collapsed-vs-full rule import-events.ts uses (DECISIONS.md §13c) so the
 * "expected" side of the comparison is computed the same way the importer
 * decided what to write — a verification pass that used a different rule
 * than the importer would just be checking the importer agrees with itself
 * restated, not checking the database is right.
 */
export async function verifyEventRowCounts(
  client: VerifyClient,
  tasks: readonly SourceTask[],
): Promise<EventRowCountReport> {
  const mismatched: string[] = [];
  let expectedTotal = 0;
  let actualTotal = 0;

  for (const task of tasks) {
    const history = task.history ?? [];
    if (history.length === 0) continue;

    const item = await client.item.findFirst({
      where: { customFields: { path: ["legacy_id"], equals: task.id } },
      select: { id: true, state: true },
    });
    if (!item) {
      // Already reported by verifyItemRowCounts's missingFromDb — don't
      // double-count it as an event mismatch too.
      continue;
    }

    const expected = TERMINAL_STATES.has(item.state) ? 1 : history.length;
    expectedTotal += expected;

    const rows = await client.$queryRawUnsafe<{ count: string }[]>(
      `SELECT COUNT(*)::text AS "count"
       FROM "Event"
       WHERE "itemId" = $1 AND "type" = 'note' AND "payload" ? 'legacy_id'`,
      item.id,
    );
    const actual = Number(rows[0]?.count ?? "0");
    actualTotal += actual;

    if (actual !== expected) {
      mismatched.push(task.id);
    }
  }

  return {
    expectedTotal,
    actualTotal,
    mismatched,
    matches: mismatched.length === 0,
  };
}

// ---------------------------------------------------------------------------
// 2. Spot-check
// ---------------------------------------------------------------------------

export interface SpotCheckField {
  readonly field: string;
  readonly expected: unknown;
  readonly actual: unknown;
  readonly matches: boolean;
}

export interface SpotCheckResult {
  readonly taskId: string;
  /** False when no `items` row was found at all — `fields` is empty in that case. */
  readonly found: boolean;
  readonly fields: SpotCheckField[];
  /** True iff `found` and every field in `fields` matches. */
  readonly matches: boolean;
}

export interface SpotCheckReport {
  readonly sampled: number;
  readonly results: SpotCheckResult[];
  /** True iff every sampled task was found and every field matched. */
  readonly allMatch: boolean;
}

/**
 * Deterministically samples up to `sampleSize` tasks from `tasks` — every
 * Nth task, N chosen so the sample spreads across the whole list rather than
 * clustering at the start, which matters for a source store where later
 * tasks might have been added in a different batch/format. Deterministic
 * (no randomness) so a spot-check report is reproducible between runs
 * verifying the SAME source snapshot.
 */
export function sampleTasks<T extends { id: string }>(
  tasks: readonly T[],
  sampleSize: number,
): T[] {
  if (tasks.length <= sampleSize || sampleSize <= 0) {
    return [...tasks];
  }
  const stride = tasks.length / sampleSize;
  const sample: T[] = [];
  for (let i = 0; i < sampleSize; i++) {
    // Provably in range: i < sampleSize < tasks.length (the early return
    // above handles sampleSize >= tasks.length), and Math.min caps the
    // upper bound at tasks.length - 1 — so `index` is always a valid
    // existing index, never out of bounds. Non-null assertion, not a
    // defensive `if`, matching import-events.ts's own convention
    // (`history[0]!`) for the same "provably in range" situation.
    const index = Math.min(tasks.length - 1, Math.floor(i * stride));
    sample.push(tasks[index]!);
  }
  return sample;
}

/**
 * An INDEPENDENT restatement of `import-items.ts`'s `STATUS_REMAP` (source
 * status -> `items.state`) — a second copy, maintained by hand, rather than
 * this module calling `import-items.ts`'s own `mapSourceStatus`. That is
 * deliberate, not an oversight or duplication-for-its-own-sake.
 *
 * If `spotCheckTask` computed its "expected" state by calling the SAME
 * function the importer uses to WRITE that state, a regression in that
 * remap table would corrupt both sides of the comparison identically: the
 * importer would write the wrong state, and this module's "expected" value
 * would be derived the same wrong way from the same broken table — so the
 * two would still agree, and a spot-check built that way would report a
 * clean match against a genuinely corrupted database. That failure mode was
 * demonstrated for real (not just argued) against an earlier version of
 * this file, by mutating `import-items.ts`'s exported `STATUS_REMAP` object
 * at runtime and confirming every check here still reported clean — see
 * "spotCheckTask catches a STATUS_REMAP regression" in
 * tests/import-verify.test.ts, which now asserts the OPPOSITE: this table
 * still disagrees with a corrupted `STATUS_REMAP`, because it never reads
 * from it.
 *
 * This is the differential test DECISIONS.md §13h #2 names as the reason
 * #13 exists at all — two independently-stated sources of truth that must
 * agree, not one function checked against its own output.
 *
 * **The cost is real and is stated plainly**, not hidden: this table must
 * be kept in sync by hand if `import-items.ts`'s `STATUS_REMAP` ever gains
 * a new source status value. A missed update surfaces loudly, though — see
 * `spotCheckTask`'s handling of a status with no entry here, which reports
 * a visible unrecognised-status mismatch rather than silently skipping the
 * field.
 */
const EXPECTED_STATUS_REMAP: Record<string, ItemState> = {
  todo: "on_deck",
  "in-progress": "executing",
  review: "in_review",
  waiting: "paused",
  done: "merged",

  // The pipeline-shaped source vocabulary (`PIPELINE_STATUS_REMAP` in
  // import-items.ts), restated here by hand for the same reason as the five
  // above: this table must be able to DISAGREE with the importer's own, or
  // it cannot catch the importer being wrong. Every entry was written from
  // the source store's documented state machine, not copied from it.
  //
  // Both vocabularies live in ONE table here even though the importer keeps
  // two, because this side only ever performs a lookup — it has no
  // equivalent of the compatibility surface whose vocabulary is defined as
  // "exactly the keys of the first table", which is the reason the importer
  // has to keep them apart.
  backlog: "someday",
  "not-started": "on_deck",
  planning: "planning",
  "plan-review": "plan_review",
  "plan-approved": "on_deck",
  parked: "paused",
  staged: "on_deck",
  executing: "executing",
  "code-review": "in_review",
  "review-approved": "in_review",
  "visual-review": "in_review",
  "visual-approved": "in_review",
  "ready-for-merge": "in_review",
  "awaiting-merge-auth": "paused",
  merged: "merged",
  cancelled: "cancelled",
};

/**
 * Field-by-field comparison of one imported task against what actually
 * landed in `items`. Checks title, body, state, area, `mergeAuthority`,
 * `custom_fields.legacy_id`, and repo (when the source task named one) —
 * every field `import-items.ts`'s `importItems` sets deliberately.
 *
 * **state is checked against `EXPECTED_STATUS_REMAP` (above), an
 * INDEPENDENT table — never by calling `mapSourceStatus`.** See that
 * constant's own doc comment for why: calling the same function the
 * importer used to WRITE the state would let a bug in that function corrupt
 * both sides of the comparison identically, and this check exists
 * specifically to catch that class of bug, not just a corrupted row.
 *
 * **area is checked via `normalizeAreaKey`** (areas.ts) — the SAME pure
 * normalisation function the importer's `ensureArea` calls. Unlike state's
 * remap table (a lookup with several independently-wrong-able entries),
 * area's transform is one mechanical string operation with no table for one
 * value to go silently wrong in isolation; reusing it here is a narrower,
 * deliberate choice than state's independent table, not an inconsistency.
 *
 * **`mergeAuthority` is checked against the literal `"needs_approval"`** —
 * `importItems` writes this as a hardcoded constant on every row, never
 * derived from any source field (see that function's own doc comment), so
 * there is no "remap under test" to be tautological about: comparing
 * against the literal value is exactly as independent as a lookup table
 * would be, because nothing here calls back into the importer's own code.
 *
 * `repoAliases` is optional and only needed to compute repo's EXPECTED
 * value identically to how the importer resolved it (via `repoAliases`,
 * never auto-created — repos are deliberate-create only, `repos.ts`); when
 * a caller doesn't supply it, the repo field is skipped for that task
 * rather than guessed at. There is no equivalent option for state or area —
 * neither needs anything but the raw source task to compute its expected
 * value.
 */
export async function spotCheckTask(
  client: VerifyClient,
  task: SourceTask,
  options: { repoAliases?: Record<string, string> } = {},
): Promise<SpotCheckResult> {
  const item = await client.item.findFirst({
    where: { customFields: { path: ["legacy_id"], equals: task.id } },
  });

  if (!item) {
    return { taskId: task.id, found: false, fields: [], matches: false };
  }

  const fields: SpotCheckField[] = [];

  fields.push({
    field: "title",
    expected: task.title,
    actual: item.title,
    matches: item.title === task.title,
  });
  fields.push({
    field: "body",
    expected: task.body,
    actual: item.body,
    matches: item.body === task.body,
  });

  // Independent table, not mapSourceStatus — see EXPECTED_STATUS_REMAP's
  // doc comment. A status with no entry here (importer gained a status this
  // table was never updated for) reports a labelled, visible mismatch
  // rather than silently skipping the state field.
  const expectedState = EXPECTED_STATUS_REMAP[task.status];
  fields.push({
    field: "state",
    expected: expectedState ?? `<unrecognised source status ${JSON.stringify(task.status)}>`,
    actual: item.state,
    matches: expectedState !== undefined && item.state === expectedState,
  });

  const expectedArea = normalizeAreaKey(task.area);
  fields.push({
    field: "area",
    expected: expectedArea,
    actual: item.area,
    matches: item.area === expectedArea,
  });

  fields.push({
    field: "mergeAuthority",
    expected: "needs_approval",
    actual: item.mergeAuthority,
    matches: item.mergeAuthority === "needs_approval",
  });

  const customFields = item.customFields as { legacy_id?: string } | null;
  fields.push({
    field: "custom_fields.legacy_id",
    expected: task.id,
    actual: customFields?.legacy_id,
    matches: customFields?.legacy_id === task.id,
  });

  // The optional typed columns, checked only when the source supplied one —
  // a source with no notion of priority leaves the column's own default in
  // place, and comparing against a default the source never expressed would
  // report a mismatch on a correct import. Each is a straight literal
  // comparison against the source value, so nothing here calls back into
  // the importer's own code (same independence property as state's table).
  if (task.priority !== undefined) {
    fields.push({
      field: "priority",
      expected: task.priority,
      actual: item.priority,
      matches: item.priority === task.priority,
    });
  }
  if (task.branch !== undefined) {
    fields.push({
      field: "branch",
      expected: task.branch,
      actual: item.branch,
      matches: item.branch === task.branch,
    });
  }
  if (task.needsVisualReview !== undefined) {
    fields.push({
      field: "needsVisualReview",
      expected: task.needsVisualReview,
      actual: item.needsVisualReview,
      matches: item.needsVisualReview === task.needsVisualReview,
    });
  }
  if (task.sourceRef !== undefined) {
    fields.push({
      field: "sourceRef",
      expected: task.sourceRef,
      actual: item.sourceRef,
      matches: item.sourceRef === task.sourceRef,
    });
  }

  if (task.repo && options.repoAliases) {
    const expectedRepo = options.repoAliases[task.repo] ?? null;
    fields.push({
      field: "repo",
      expected: expectedRepo,
      actual: item.repo,
      matches: item.repo === expectedRepo,
    });
  }

  return {
    taskId: task.id,
    found: true,
    fields,
    matches: fields.every((f) => f.matches),
  };
}

/**
 * Runs `spotCheckTask` over a deterministic sample of `tasks` (see
 * `sampleTasks`) and returns the combined report. `sampleSize` defaults to
 * 20 — enough to catch a systematic mapping bug without reading every row in
 * a backlog that could run to thousands of tasks.
 */
export async function spotCheckItems(
  client: VerifyClient,
  tasks: readonly SourceTask[],
  options: { repoAliases?: Record<string, string>; sampleSize?: number } = {},
): Promise<SpotCheckReport> {
  const sample = sampleTasks(tasks, options.sampleSize ?? 20);
  const results: SpotCheckResult[] = [];
  for (const task of sample) {
    results.push(await spotCheckTask(client, task, { repoAliases: options.repoAliases }));
  }
  return {
    sampled: results.length,
    results,
    allMatch: results.every((r) => r.matches),
  };
}

// ---------------------------------------------------------------------------
// 3. Assignments / artifacts row counts (#12's tables)
// ---------------------------------------------------------------------------

export interface AssignmentArtifactCountReport {
  readonly expectedClaims: number;
  readonly actualClaims: number;
  readonly expectedReviews: number;
  readonly actualReviews: number;
  readonly matches: boolean;
}

/**
 * Sums `claims`/`reviews` array lengths across `tasks` (the expected side —
 * #12's importer writes exactly one row per array entry when nothing
 * conflicts, see import-assignments-artifacts.ts) and compares against the
 * actual `assignments`/`artifacts` row counts for those tasks' items.
 *
 * **Known limit, stated plainly:** this counts EXPECTED as "one row per
 * source entry" and does not account for `claimsConflicted` (a source claim
 * that lost to a partial-unique-index conflict, per import-assignments-
 * artifacts.ts's own doc comment) — a source history with a genuine
 * same-item-same-session-or-orchestrator conflict will show fewer actual
 * rows than expected here, correctly, because that's the conflict being
 * surfaced rather than a counting bug. A caller comparing this report's
 * `actualClaims` against the conflict-aware result `importAssignments`
 * itself returns (`claimsImported`) gets the full picture; this function
 * only answers "how many landed", not "why any didn't".
 */
export async function verifyAssignmentArtifactRowCounts(
  client: VerifyClient,
  tasks: readonly SourceTaskAssignmentsArtifacts[],
): Promise<AssignmentArtifactCountReport> {
  let expectedClaims = 0;
  let expectedReviews = 0;
  let actualClaims = 0;
  let actualReviews = 0;

  for (const task of tasks) {
    const claims = task.claims ?? [];
    const reviews = task.reviews ?? [];
    expectedClaims += claims.length;
    expectedReviews += reviews.length;
    if (claims.length === 0 && reviews.length === 0) continue;

    const item = await client.item.findFirst({
      where: { customFields: { path: ["legacy_id"], equals: task.id } },
      select: { id: true },
    });
    if (!item) continue;

    const assignmentRows = await client.$queryRawUnsafe<{ count: string }[]>(
      `SELECT COUNT(*)::text AS "count" FROM "Assignment" WHERE "itemId" = $1`,
      item.id,
    );
    actualClaims += Number(assignmentRows[0]?.count ?? "0");

    const artifactRows = await client.$queryRawUnsafe<{ count: string }[]>(
      `SELECT COUNT(*)::text AS "count" FROM "Artifact" WHERE "itemId" = $1`,
      item.id,
    );
    actualReviews += Number(artifactRows[0]?.count ?? "0");
  }

  return {
    expectedClaims,
    actualClaims,
    expectedReviews,
    actualReviews,
    // Deliberately >= not ===: actualClaims can be LESS than expected when a
    // source conflict was correctly refused (see doc comment above), which
    // is not itself a verification failure. What this DOES catch is the bug
    // this row exists to catch — MORE rows landing than the source
    // described, i.e. duplication on re-run.
    matches: actualClaims <= expectedClaims && actualReviews <= expectedReviews,
  };
}
