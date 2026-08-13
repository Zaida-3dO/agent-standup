// Importer — assignments and artifacts: claims, roles, review files
// (MILESTONES.md #12, SCHEMA.md §2, §6, DECISIONS.md §13c/§13d/§11 "Import,
// and going live").
//
// Reads the SAME directory-per-task source store `import-items.ts` (#10)
// defined — one `task.json` per task directory — extended here with two
// OPTIONAL arrays a task's JSON may also carry: `claims` (who worked it, and
// in what role — landing in `assignments`) and `reviews` (review files
// produced against it — landing in `artifacts`). A task with neither array,
// or with an empty one, is untouched by this importer; #10 already imported
// it and this module has nothing to add.
//
// This importer never writes to its source, and it never touches `items`
// (#10 owns that table) or `events` (#11, built in parallel, owns the
// history-log import) — it writes `assignments` and `artifacts` only, and it
// resolves the item a claim/review belongs to via the SAME `custom_fields
// .legacy_id` lookup #10's idempotency check uses, so it never needs its own
// notion of which items exist.
import type { PrismaClient } from "@prisma/client";
import { parseFindings, type Finding } from "./findings";

/**
 * The literal values `assignments.role` can hold in the DATABASE — mirrors
 * `Role` in schema.prisma exactly, underscore spelling included. This is
 * deliberately a distinct type from `SourceClaim.role` (a free `string`):
 * the source store spells the visual-reviewer role with a hyphen
 * (`visual-reviewer`), the schema enum uses an underscore
 * (`visual_reviewer`) — the two vocabularies disagree on exactly this one
 * value, which is why `ROLE_REMAP` exists at all rather than a direct pass
 * through.
 */
export type DbRole =
  "orchestrator" | "builder" | "reviewer" | "visual_reviewer" | "scout" | "custom";

/**
 * Maps a source role string onto `assignments.role` (SCHEMA.md §2). Every
 * value but one passes through unchanged; `visual-reviewer` is rewritten to
 * `visual_reviewer` to match the database enum. An unrecognised source role
 * is a data problem to raise, not a silent default — see `mapSourceRole`,
 * mirroring `mapSourceStatus` in import-items.ts.
 */
export const ROLE_REMAP: Record<string, DbRole> = {
  orchestrator: "orchestrator",
  builder: "builder",
  reviewer: "reviewer",
  "visual-reviewer": "visual_reviewer",
  scout: "scout",
  custom: "custom",
};

export class UnknownSourceRoleError extends Error {
  constructor(role: string, taskId: string) {
    super(`unrecognised source role ${JSON.stringify(role)} on task ${JSON.stringify(taskId)}`);
    this.name = "UnknownSourceRoleError";
  }
}

export function mapSourceRole(role: string, taskId: string): DbRole {
  const mapped = ROLE_REMAP[role];
  if (!mapped) {
    throw new UnknownSourceRoleError(role, taskId);
  }
  return mapped;
}

/**
 * One historical claim on a task, as the source store records it. Deliberately
 * the smallest shape a file-based backlog needs to reconstruct "who worked
 * this, in what role": a session id, a role, a holder, and when it was
 * claimed/released. A claim the source never marked released imports as
 * still LIVE (`releasedAt: undefined`) — see `importAssignments` for what that
 * means against the two partial unique indexes.
 */
export interface SourceClaim {
  /** The source's own identifier for this claim — unique within the task. Used for idempotency. */
  id: string;
  sessionId: string;
  /** Free-text role in the SOURCE vocabulary — see `ROLE_REMAP`. */
  role: string;
  roleCustom?: string | null;
  holderType: "person" | "agent";
  holderId: string;
  /** Top of this claim's session tree. Omitted means "this session is a root" — same convention as claims.ts. */
  rootSessionId?: string | null;
  parentSessionId?: string | null;
  machine: string;
  claimedAt: string;
  /** ISO timestamp, or absent/null for a claim the source never marked released (still live). */
  releasedAt?: string | null;
}

/**
 * One review file produced against a task, as the source store records it.
 * `kind`/`verdict` are the source's own vocabulary and pass straight through
 * to `ArtifactKind`/`Verdict` — unlike claims' role vocabulary, the source
 * store used the schema's own enum spellings for these (both already
 * underscore-separated, `plan_review`/`code_review`/... and
 * `approved`/`changes_required`/`na`), so there is no remap table here, only
 * validation that the value is one of the closed set (`mapSourceArtifactKind`
 * / `mapSourceVerdict`) — an unrecognised value is a data problem to raise,
 * the same posture as every other closed-vocabulary field in this importer.
 */
export interface SourceReview {
  /** The source's own identifier for this review — unique within the task. Used for idempotency. */
  id: string;
  kind: string;
  verdict?: string | null;
  reviewRound?: number;
  commitSha?: string | null;
  body?: string | null;
  ref?: string | null;
  createdByType: "person" | "agent";
  createdById: string;
  createdAt: string;
  /**
   * The review's individual findings, already in this application's own
   * vocabulary (`findings.ts`) — `{ text, severity?, where? }`, severities
   * lowercase.
   *
   * A caller whose source grades findings `HIGH`/`MEDIUM` maps them on its
   * own side, exactly as it maps statuses and verdicts; this module ships
   * the ladder and no table translating anybody's spelling into it. An
   * entry that cannot be represented is refused by `parseFindings` rather
   * than repaired, because a coerced findings list looks complete and is
   * not, and no later reader could tell.
   */
  findings?: unknown;
}

const ARTIFACT_KINDS = new Set([
  "plan",
  "plan_review",
  "code_review",
  "visual_review",
  "test_run",
  "commit",
  "screenshot",
  "other",
]);

/**
 * **This application's own verdict vocabulary** (SCHEMA.md §6) — the values
 * an `artifacts.verdict` may hold, and the set a caller maps onto.
 *
 * Six values, not three, because a review outcome is tiered: a plain pass,
 * a pass that records cosmetic notes, and a pass that records follow-up
 * work are genuinely different answers, and collapsing them onto one label
 * loses the distinction at the column that is queried for it.
 *
 * `approved` is retained alongside `lgtm` as an accepted synonym rather
 * than replaced. Removing a label from a Postgres enum is a type rebuild,
 * not an `ALTER`, so every verdict already on record keeps deciding
 * identically — which is the point: a migration must never silently change
 * what a stored row means.
 *
 * As with statuses, this application ships ITS vocabulary and no table
 * translating anybody else's spellings into it. A caller whose source
 * writes `lgtm-with-nits` supplies that mapping in `verdictAliases`.
 */
export const VERDICTS = new Set([
  "approved",
  "changes_required",
  "na",
  "lgtm",
  "lgtm_with_nits",
  "lgtm_with_followups",
]);

export class UnknownArtifactKindError extends Error {
  constructor(kind: string, reviewId: string) {
    super(
      `unrecognised artifact kind ${JSON.stringify(kind)} on review ${JSON.stringify(reviewId)}`,
    );
    this.name = "UnknownArtifactKindError";
  }
}

export class UnknownVerdictError extends Error {
  constructor(verdict: string, reviewId: string) {
    super(`unrecognised verdict ${JSON.stringify(verdict)} on review ${JSON.stringify(reviewId)}`);
    this.name = "UnknownVerdictError";
  }
}

export function mapSourceArtifactKind(kind: string, reviewId: string): string {
  if (!ARTIFACT_KINDS.has(kind)) {
    throw new UnknownArtifactKindError(kind, reviewId);
  }
  return kind;
}

/**
 * Resolves a source verdict onto one of this application's own.
 *
 * A caller-supplied `verdictAliases` wins, then the application's own set;
 * anything in neither is **refused**. Widening the accepted set must never
 * become a pass-through — the whole value of this check is that it refuses
 * a verdict nobody taught it, and a review outcome is exactly the field
 * where guessing is most expensive: it decides whether a change was passed.
 *
 * An explicit alias map rather than a normalising transform (hyphen ->
 * underscore, lowercase) even though a transform would handle the common
 * spellings in one line. A transform quietly accepts anything shaped
 * right — `lgtm-with-nitpicks` would normalise to a value that does not
 * exist and fail deep inside an insert, and `changes-required` and
 * `changes_required` would stop being distinguishable from a typo. The map
 * says exactly which foreign spellings are recognised and refuses the rest,
 * which is the same posture `repoAliases` and `actorAliases` already take
 * for the same reason.
 */
export function mapSourceVerdict(
  verdict: string,
  reviewId: string,
  verdictAliases: Record<string, string> = {},
): string {
  // An alias's TARGET is validated too, not trusted. A caller-supplied map
  // is input, and an entry pointing at something this application does not
  // store is the same data problem as an unmapped verdict — caught here
  // rather than deep inside an insert. (The payload schema also constrains
  // it; this is the check for every other caller of this function.)
  const mapped = verdictAliases[verdict] ?? verdict;
  if (!VERDICTS.has(mapped)) {
    throw new UnknownVerdictError(verdict, reviewId);
  }
  return mapped;
}

export class VerdictNotStorableError extends Error {
  constructor(missing: readonly string[], available: readonly string[]) {
    super(
      `the database's Verdict type cannot store ${missing.length} verdict(s) this import would ` +
        `write: ${missing.join(", ")}. It accepts: ${available.join(", ")}. Apply the ` +
        "migration that adds them, or map them onto a value it does accept in verdictAliases.",
    );
    this.name = "VerdictNotStorableError";
  }
}

interface EnumLabelRow {
  label: string;
}

/**
 * Refuses, up front, any verdict the database's own `Verdict` type cannot
 * hold.
 *
 * This exists because the application's accepted set and the database's
 * enum labels are versioned separately: a build that knows about tiered
 * verdicts can be pointed at a database whose migration adding them has not
 * been applied yet. Without this the mismatch surfaces partway through a
 * bulk insert as `invalid input value for enum "Verdict"` — naming no task,
 * no artifact and no remedy, after some of the import has already run.
 *
 * Checked against `pg_enum` rather than against a constant, because the
 * question is not "what does this build believe" but "what will this
 * database actually accept", and only the database can answer that. Every
 * offender is reported at once, so one run tells the operator the whole
 * story instead of one failure at a time.
 */
export async function assertVerdictsStorable(
  client: Pick<PrismaClient, "$queryRawUnsafe">,
  verdicts: readonly string[],
): Promise<void> {
  const wanted = [...new Set(verdicts)].sort();
  if (wanted.length === 0) return;

  const rows = await client.$queryRawUnsafe<EnumLabelRow[]>(
    `SELECT e.enumlabel AS label
       FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
      WHERE t.typname = 'Verdict'`,
  );
  const available = rows.map((row) => row.label);
  // No rows means the type is not there at all — a database this importer
  // was never migrated against. Leave that to the insert's own error
  // rather than reporting every verdict as individually unstorable.
  if (available.length === 0) return;

  const missing = wanted.filter((verdict) => !available.includes(verdict));
  if (missing.length > 0) {
    throw new VerdictNotStorableError(missing, available.sort());
  }
}

/** A `task.json` entry as this importer reads it — the fields #10's `SourceTask` doesn't need. */
export interface SourceTaskAssignmentsArtifacts {
  /** The source's own identifier for this task — must match what #10 imported under `custom_fields.legacy_id`. */
  id: string;
  claims?: SourceClaim[];
  reviews?: SourceReview[];
}

export interface ImportAssignmentsArtifactsResult {
  claimsImported: number;
  claimsSkippedExisting: number;
  claimsConflicted: number;
  reviewsImported: number;
  reviewsSkippedExisting: number;
  /** Findings across every artifact in the source — what a reconciliation must account for. */
  findingsIn: number;
  /** Findings actually written, summed over the artifact rows this run inserted. */
  findingsWritten: number;
  /** Findings on artifacts skipped as already present. Not lost — already on the existing row. */
  findingsOnSkippedArtifacts: number;
  /**
   * Findings the source recorded WITHOUT a severity, counted rather than
   * defaulted. A review that never graded a finding did not grade it, and
   * inventing a level would put a number nobody chose into the one field
   * the column exists to preserve — "ungraded" is a different claim from
   * "graded low" (`findings.ts`).
   */
  findingsWithoutSeverity: number;
}

/** The minimal client surface this module needs — narrowed the same way import-items.ts narrows its own. */
export type ImportClient = Pick<PrismaClient, "item" | "$executeRawUnsafe" | "$queryRawUnsafe">;

interface AssignmentIdRow {
  id: string;
}

/**
 * Resolves a task's app-generated `items.id` from the source id #10 imported
 * it under (`custom_fields.legacy_id`), or returns `null` if #10 never
 * imported that task (or it was skipped, e.g. it yielded nothing). A claim
 * or review whose task cannot be resolved is a data problem, surfaced by the
 * caller rather than silently dropped — see `importAssignmentsAndArtifacts`.
 */
async function resolveItemId(client: ImportClient, sourceTaskId: string): Promise<string | null> {
  const item = await client.item.findFirst({
    where: { customFields: { path: ["legacy_id"], equals: sourceTaskId } },
    select: { id: true },
  });
  return item?.id ?? null;
}

export class UnresolvedTaskError extends Error {
  constructor(sourceTaskId: string) {
    super(
      `task ${JSON.stringify(sourceTaskId)} has claims/reviews to import but no matching ` +
        "items row (custom_fields.legacy_id) was found — run the items importer (#10) first",
    );
    this.name = "UnresolvedTaskError";
  }
}

/**
 * Imports every `claims` entry across `tasks` into `assignments`.
 *
 * **Idempotent on `custom_fields`-equivalent identity for assignments**:
 * `assignments` has no `custom_fields` column (SCHEMA.md §2 lists none), so
 * re-run safety instead keys on the natural tuple the source claim already
 * carries and that a real claim's own uniqueness rules range over —
 * `(itemId, sessionId, claimedAt)`. A second run presenting the exact same
 * claim resolves to the exact same row and is skipped; the count is what
 * `--dry-run` style verification (#13) reads to confirm nothing duplicated.
 *
 * **Respects the two partial unique indexes DELIBERATELY, not by crashing.**
 * The insert is `INSERT ... ON CONFLICT DO NOTHING RETURNING *`, the same
 * shape `claims.ts`'s `claimItem` uses and for the same documented reason
 * (see this module's header comment and claims.ts's own header): a raised
 * unique violation aborts the enclosing Postgres transaction, so a bare
 * `INSERT` inside a loop importing many claims would abort every claim after
 * the first violation, not just the one that lost. `ON CONFLICT DO NOTHING`
 * absorbs the loss into an empty result instead, and this function counts it
 * as `claimsConflicted` — a source recording two "live" claims that violate
 * the same-item-same-session-or-orchestrator rules is a genuine data
 * conflict in the source history (most commonly: the source never marked an
 * earlier claim released, and a later claim on the same item looks live at
 * the same time), and it is surfaced as a count rather than silently
 * dropped or allowed to corrupt the invariant the index exists to hold.
 *
 * **Deliberately does NOT call `claims.ts`'s `claimItem`.** That function is
 * built for a live claim happening now: it runs the root-session crew check
 * (`assertSameCrew`) and appends a `claim` event. Import data is historical
 * — most rows arrive already `releasedAt`-set — and #11 (built in parallel)
 * owns importing history into `events`, not this module; calling `claimItem`
 * here would both re-derive the crew check against import order that has no
 * relationship to real arrival order (an import can list an orchestrator's
 * claim after its builder's, which `claimItem`'s "first claim on an item"
 * carve-out does not anticipate) and double up on event writes #11 already
 * produces from the source's own history log. Writing directly, with the
 * same conflict-absorption shape `claimItem` uses, gets the database
 * constraint enforcement without the live-claim semantics that don't apply
 * to a historical import.
 */
export async function importAssignments(
  client: ImportClient,
  tasks: SourceTaskAssignmentsArtifacts[],
): Promise<
  Pick<
    ImportAssignmentsArtifactsResult,
    "claimsImported" | "claimsSkippedExisting" | "claimsConflicted"
  >
> {
  let claimsImported = 0;
  let claimsSkippedExisting = 0;
  let claimsConflicted = 0;

  for (const task of tasks) {
    const claims = task.claims ?? [];
    if (claims.length === 0) continue;

    const itemId = await resolveItemId(client, task.id);
    if (!itemId) {
      throw new UnresolvedTaskError(task.id);
    }

    for (const claim of claims) {
      const role = mapSourceRole(claim.role, task.id);
      const rootSessionId = claim.rootSessionId ?? claim.sessionId;

      const existing = await client.$queryRawUnsafe<AssignmentIdRow[]>(
        `SELECT "id" FROM "Assignment"
          WHERE "itemId" = $1 AND "sessionId" = $2 AND "claimedAt" = $3::timestamptz`,
        itemId,
        claim.sessionId,
        claim.claimedAt,
      );
      if (existing.length > 0) {
        claimsSkippedExisting++;
        continue;
      }

      // Untargeted ON CONFLICT DO NOTHING — see the function doc for why:
      // it conflicts on EITHER partial unique index without naming one,
      // which is what keeps the transaction alive to report the loss as a
      // count instead of aborting the whole import run.
      const inserted = await client.$queryRawUnsafe<AssignmentIdRow[]>(
        `INSERT INTO "Assignment" (
           "id", "itemId", "role", "roleCustom", "holderType", "holderId",
           "sessionId", "parentSessionId", "rootSessionId", "machine",
           "claimedAt", "releasedAt"
         )
         VALUES (
           gen_random_uuid(), $1, $2::"Role", $3, $4::"HolderType", $5,
           $6, $7, $8, $9, $10::timestamptz, $11::timestamptz
         )
         ON CONFLICT DO NOTHING
         RETURNING "id"`,
        itemId,
        role,
        claim.roleCustom ?? null,
        claim.holderType,
        claim.holderId,
        claim.sessionId,
        claim.parentSessionId ?? null,
        rootSessionId,
        claim.machine,
        claim.claimedAt,
        claim.releasedAt ?? null,
      );

      if (inserted.length > 0) {
        claimsImported++;
      } else {
        claimsConflicted++;
      }
    }
  }

  return { claimsImported, claimsSkippedExisting, claimsConflicted };
}

interface ArtifactIdRow {
  id: string;
}

/**
 * Imports every `reviews` entry across `tasks` into `artifacts`.
 *
 * **Idempotent on `(itemId, kind, reviewRound, createdById, createdAt)`** —
 * `artifacts` has no natural source-id column either (SCHEMA.md §6 lists
 * none), so re-run safety keys on the tuple that identifies "the same review
 * file" without needing one. A second run presenting the identical review is
 * skipped, not re-inserted.
 *
 * `artifacts` carries no unique DATABASE constraint the way `assignments`
 * does (§6 defines none, and this module adds none — a hand-written
 * migration for a constraint SCHEMA.md never asked for would be scope this
 * importer wasn't given), so idempotency here is purely the check-then-write
 * this function performs, not an index Postgres enforces. That is a
 * narrower guarantee than AC4's assignments path and is stated as such
 * rather than presented as equivalent.
 */
export async function importArtifacts(
  client: ImportClient,
  tasks: SourceTaskAssignmentsArtifacts[],
  options: { readonly verdictAliases?: Record<string, string> } = {},
): Promise<
  Pick<
    ImportAssignmentsArtifactsResult,
    | "reviewsImported"
    | "reviewsSkippedExisting"
    | "findingsIn"
    | "findingsWritten"
    | "findingsOnSkippedArtifacts"
    | "findingsWithoutSeverity"
  >
> {
  let reviewsImported = 0;
  let reviewsSkippedExisting = 0;
  let findingsIn = 0;
  let findingsWritten = 0;
  let findingsOnSkippedArtifacts = 0;
  let findingsWithoutSeverity = 0;

  for (const task of tasks) {
    const reviews = task.reviews ?? [];
    if (reviews.length === 0) continue;

    const itemId = await resolveItemId(client, task.id);
    if (!itemId) {
      throw new UnresolvedTaskError(task.id);
    }

    for (const review of reviews) {
      const kind = mapSourceArtifactKind(review.kind, review.id);
      // Validated BEFORE the existence check, so a malformed findings list
      // is refused whether or not the artifact happens to be present
      // already — a re-run must not start silently accepting data a first
      // run would have rejected.
      const findings: Finding[] =
        review.findings === undefined || review.findings === null
          ? []
          : parseFindings(review.findings);
      findingsIn += findings.length;
      findingsWithoutSeverity += findings.filter((f) => f.severity === undefined).length;
      const verdict =
        review.verdict != null
          ? mapSourceVerdict(review.verdict, review.id, options.verdictAliases)
          : null;
      const reviewRound = review.reviewRound ?? 1;

      const existing = await client.$queryRawUnsafe<ArtifactIdRow[]>(
        `SELECT "id" FROM "Artifact"
          WHERE "itemId" = $1 AND "kind" = $2::"ArtifactKind" AND "reviewRound" = $3
            AND "createdById" = $4 AND "createdAt" = $5::timestamptz`,
        itemId,
        kind,
        reviewRound,
        review.createdById,
        review.createdAt,
      );
      if (existing.length > 0) {
        reviewsSkippedExisting++;
        findingsOnSkippedArtifacts += findings.length;
        continue;
      }

      // `findings` is stored as NULL rather than `[]` when the review had
      // none, so "this review recorded no findings" and "this row predates
      // findings being stored at all" stay distinguishable — the same
      // absent-is-not-zero reasoning the severity field itself follows.
      await client.$executeRawUnsafe(
        `INSERT INTO "Artifact" (
           "id", "itemId", "kind", "verdict", "reviewRound", "commitSha",
           "body", "ref", "createdByType", "createdById", "createdAt", "findings"
         )
         VALUES (
           gen_random_uuid(), $1, $2::"ArtifactKind", $3::"Verdict", $4, $5,
           $6, $7, $8::"HolderType", $9, $10::timestamptz, $11::jsonb
         )`,
        itemId,
        kind,
        verdict,
        reviewRound,
        review.commitSha ?? null,
        review.body ?? null,
        review.ref ?? null,
        review.createdByType,
        review.createdById,
        review.createdAt,
        findings.length > 0 ? JSON.stringify(findings) : null,
      );
      reviewsImported++;
      findingsWritten += findings.length;
    }
  }

  return {
    reviewsImported,
    reviewsSkippedExisting,
    findingsIn,
    findingsWritten,
    findingsOnSkippedArtifacts,
    findingsWithoutSeverity,
  };
}

/**
 * Runs both imports in sequence and returns the combined counts. The one
 * entry point a caller (a CLI script, or #13's verification pass) actually
 * needs — `importAssignments` and `importArtifacts` stay exported separately
 * because their tests, and #13's per-table verification, want to run them
 * independently.
 */
export async function importAssignmentsAndArtifacts(
  client: ImportClient,
  tasks: SourceTaskAssignmentsArtifacts[],
  options: { readonly verdictAliases?: Record<string, string> } = {},
): Promise<ImportAssignmentsArtifactsResult> {
  const assignments = await importAssignments(client, tasks);
  const artifacts = await importArtifacts(client, tasks, options);
  return { ...assignments, ...artifacts };
}
