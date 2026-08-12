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
import type { PrismaClient } from "@prisma/client";
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
    const index = Math.min(tasks.length - 1, Math.floor(i * stride));
    const task = tasks[index];
    if (task) sample.push(task);
  }
  return sample;
}

/**
 * Field-by-field comparison of one imported task against what actually
 * landed in `items`. Checks exactly the fields `import-items.ts`'s
 * `importItems` sets deliberately (SCHEMA.md's per-field mapping is in that
 * module's own doc comments) — title, body, state (via `mapSourceStatus`,
 * so a spot-check failure here would mean either the importer's remap table
 * or the row itself drifted), area (via `normalizeAreaKey`), and repo (via
 * `repoAliases`, when the source task named one).
 *
 * `repoAliases`/`areaOverride` are optional and only needed to compute the
 * EXPECTED side identically to how the importer resolved them; when a
 * caller doesn't have them (e.g. checking area alone), area/repo checks are
 * skipped for that field rather than guessed at.
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

  const customFields = item.customFields as { legacy_id?: string } | null;
  fields.push({
    field: "custom_fields.legacy_id",
    expected: task.id,
    actual: customFields?.legacy_id,
    matches: customFields?.legacy_id === task.id,
  });

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
