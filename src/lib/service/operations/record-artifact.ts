// `record_artifact` — SCHEMA.md §6, §16, §19. Records a thing that was
// produced: a plan, a review of one, a commit, a screenshot.
//
// This is the write side of the `artifacts` table. Until it existed the table
// had exactly one writer — the one-time import from an external file-based
// store — so every guard in §16 that points at an artifact was unsatisfiable
// for anything created through the product itself. Three of them
// (`artifact.plan_approval`, `artifact.evidence_at_tip` and the `merge.*`
// cluster) refuse a transition until the right artifact exists, and there was
// no way to make one. An item minted here could not reach `executing`, and
// could not reach `merged`.
//
// **One operation clears all three**, because what the guards actually
// disagree about is which row they are looking for, not how it got there:
//
//   - `plan_review` → `executing` wants an approving `plan_review` artifact.
//   - entering `merged` wants a `commit` artifact and an approving
//     `code_review` at the same round and the same commit.
//   - entering `in_review` wants a `review_requested` **event**, not an
//     artifact at all (see `requestReview` below, and the long note in
//     guards/review-requested.ts about why §16's wording misleads here).
//
// So this file writes one artifact row and nothing else decides anything. The
// guards keep owning the question of what is sufficient; recording a fact is
// deliberately not the same act as passing a gate, and this operation is not
// allowed to become a way to move an item.
import { z } from "zod";
import { InvalidInputError, NotFoundError } from "../errors";
import { defineOperation } from "../operation";
import type { ServiceContext } from "../context";
import { appendEvent } from "@/lib/events";
import { InvalidFindingError, parseFindings } from "@/lib/findings";
import { currentReviewRound } from "../guards/merge-review-round";

/**
 * `ArtifactKind` in schema.prisma, mirrored. Written out rather than derived
 * from the generated Prisma enum so that a value added to the database
 * without a decision about what it means here is a compile-time mismatch in
 * the tests, not a silently-accepted string.
 */
const ARTIFACT_KINDS = [
  "plan",
  "plan_review",
  "code_review",
  "visual_review",
  "test_run",
  "commit",
  "screenshot",
  "other",
] as const;

/** `Verdict` in schema.prisma, mirrored — the same list `src/lib/verdicts.ts` reasons over. */
const VERDICT_VALUES = [
  "approved",
  "changes_required",
  "na",
  "lgtm",
  "lgtm_with_nits",
  "lgtm_with_followups",
] as const;

/** `HolderType` — who produced the artifact. §6: "A review by a person and one by a reviewer agent are both evidence." */
const HOLDER_TYPES = ["person", "agent"] as const;

const inputSchema = z
  .object({
    itemId: z.string().min(1),
    kind: z.enum(ARTIFACT_KINDS),
    verdict: z.enum(VERDICT_VALUES).nullable().optional(),
    /**
     * Which review round this belongs to. Coerced, because every flag
     * arriving from the command line is a string and the CLI adapter passes
     * flags through by name without knowing any operation's types — `--review-round 2`
     * would otherwise be rejected as "expected number, received string" for
     * a value the caller spelled correctly.
     *
     * Defaulted in the handler rather than here, to the item's *current*
     * round — see `resolveReviewRound`. A static `.default(1)` would be
     * actively wrong: it silently pins every artifact to round 1 while the
     * merge gate reads `max(review_round)` across the item.
     */
    reviewRound: z.coerce.number().int().min(1).optional(),
    commitSha: z.string().trim().min(1).nullable().optional(),
    body: z.string().nullable().optional(),
    ref: z.string().trim().min(1).nullable().optional(),
    /** Which browser session a visual review ran in (§6) — an opaque string to the core. */
    browserSession: z.string().trim().min(1).nullable().optional(),
    /** The review's individual findings, each with a severity (§6a). Validated by `parseFindings`. */
    findings: z.unknown().optional(),
    /** The follow-up item a `lgtm_with_followups` review's findings were deferred into. */
    followUpItemId: z.string().min(1).nullable().optional(),
    createdByType: z.enum(HOLDER_TYPES).optional(),
    createdById: z.string().min(1).optional(),
    sessionId: z.string().min(1).nullable().optional(),
  })
  .strict();

export type RecordArtifactInput = z.infer<typeof inputSchema>;

export interface RecordedArtifact {
  readonly id: string;
  readonly itemId: string;
  readonly kind: string;
  readonly verdict: string | null;
  readonly reviewRound: number;
  readonly commitSha: string | null;
  readonly ref: string | null;
  readonly browserSession: string | null;
  readonly followUpItemId: string | null;
  readonly createdByType: string;
  readonly createdById: string;
  readonly createdAt: Date;
}

/** The kinds that are a review of something, and so are the kinds a verdict belongs on. */
const REVIEW_KINDS: ReadonlySet<string> = new Set(["plan_review", "code_review", "visual_review"]);

interface LiveAssignmentRow {
  id: string;
  holderType: "person" | "agent";
  holderId: string;
}

/**
 * Who to credit the artifact to.
 *
 * Resolved from the caller's live assignment when it holds one — the same
 * attribution `checkpoint` gets structurally — and otherwise from what the
 * caller states outright. An explicit `createdByType`/`createdById` always
 * wins over the assignment, because a person can perfectly well record a
 * review from a session an agent is holding, and the artifact should say so.
 *
 * This is not a formality. `merge.requires_authorisation` reads
 * `created_by_type` to decide whether a human authorised the merge on an item
 * whose `merge_authority` is `needs_approval` — so a wrong answer here is the
 * difference between a merge gate that means something and one that does not.
 * That is exactly why this operation will not *guess* a `person`: with no
 * assignment and nothing stated, it refuses rather than defaulting.
 */
async function resolveCreator(
  ctx: ServiceContext,
  input: RecordArtifactInput,
): Promise<{
  createdByType: "person" | "agent";
  createdById: string;
  assignmentId: string | null;
}> {
  let assignment: LiveAssignmentRow | undefined;
  if (input.sessionId) {
    const rows = await ctx.db.$queryRawUnsafe<LiveAssignmentRow[]>(
      `SELECT "id", "holderType", "holderId" FROM "Assignment"
        WHERE "itemId" = $1 AND "sessionId" = $2 AND "releasedAt" IS NULL
        LIMIT 1`,
      input.itemId,
      input.sessionId,
    );
    assignment = rows[0];
  }

  const createdByType = input.createdByType ?? assignment?.holderType;
  const createdById = input.createdById ?? assignment?.holderId;

  if (!createdByType || !createdById) {
    // Deliberately a refusal rather than a default. `created_by_type` is a
    // merge-gate input, and a default of `agent` would quietly under-credit a
    // person's review while a default of `person` would let an agent's review
    // satisfy the one clause that exists to require a human.
    throw new InvalidInputError(
      "An artifact must record who produced it — pass createdByType and createdById, " +
        "or a sessionId that holds a live assignment on the item.",
      { fields: ["createdByType", "createdById"] },
    );
  }

  // **A person reference has to name a real person.** Without this, a caller
  // could pass `createdByType: "person"` with any string at all and satisfy
  // `merge.requires_authorisation` — the clause whose entire purpose is that a
  // *human* authorised a merge on a `needs_approval` item. A gate whose
  // subject need not exist is weaker than it reads, and it reads as strong.
  //
  // Checked only for `person`: an agent id is not a foreign key to anything,
  // so there is no table to check it against, and refusing an unknown agent
  // would mean refusing every agent.
  //
  // The same shape `create_item` uses for `originPersonId`, deliberately —
  // two operations disagreeing about whether a person reference must resolve
  // is worse than either answer, and this is the answer that already exists.
  //
  // **Not a foreign key on `Artifact.createdById`**, which would be stronger:
  // artifacts are also written by the importer, which replays a corpus whose
  // people it does not necessarily carry, and a constraint would reject those
  // rows outright. The operation-level check binds the path a caller reaches
  // and leaves the import path alone.
  if (createdByType === "person") {
    const personRows = await ctx.db.$queryRawUnsafe<{ id: string }[]>(
      `SELECT "id" FROM "Person" WHERE "id" = $1`,
      createdById,
    );
    if (personRows.length === 0) {
      throw new NotFoundError(`No such person: ${createdById}.`, {
        fields: ["createdById"],
      });
    }
  }

  return { createdByType, createdById, assignmentId: assignment?.id ?? null };
}

/**
 * The round to file this artifact under when the caller does not say.
 *
 * The item's **current** round (`max(review_round)`), not the column default
 * of 1. The merge gate requires an approving `code_review` at
 * `max(review_round)` *and* at the tip commit, and that maximum is taken
 * across every kind — so defaulting to 1 would mean that on any item already
 * at round 2, a commit recorded without an explicit round lands at round 1,
 * the review at round 2, and the merge is refused for a reason the caller
 * never chose and cannot see. Defaulting to the current round keeps a
 * sequence of artifacts on the same round unless someone deliberately opens a
 * new one, which is the behaviour the gate is written against.
 */
async function resolveReviewRound(
  ctx: ServiceContext,
  input: RecordArtifactInput,
): Promise<number> {
  if (input.reviewRound !== undefined) {
    return input.reviewRound;
  }
  return currentReviewRound(ctx.db, input.itemId);
}

// Stryker disable all : this metadata is a module-level literal, read into
// the registry at import — before any test body runs and never re-evaluated
// — so a mutation here is unkillable by construction, NOT untested.
// `scripts/check-operation-metadata-mutants.mjs` requires this and carries
// the full reasoning, including why moving the assertions into a test body
// does not help.
export const recordArtifact = defineOperation({
  name: "record_artifact",
  kind: "write",
  summary: "Records an artifact — a plan, a review, a commit, a screenshot — against an item.",
  // Stryker restore all
  input: inputSchema,
  async handler(ctx: ServiceContext, input: RecordArtifactInput): Promise<RecordedArtifact> {
    const itemRows = await ctx.db.$queryRawUnsafe<{ id: string }[]>(
      `SELECT "id" FROM "Item" WHERE "id" = $1`,
      input.itemId,
    );
    if (itemRows.length === 0) {
      throw new NotFoundError(`No such item: ${input.itemId}.`, { fields: ["itemId"] });
    }

    // A commit artifact whose whole purpose is to name a commit, that names
    // none, is the one shape guaranteed to be useless: `currentTipCommitSha`
    // reads `commitSha` off the newest `commit` artifact, so a null one makes
    // the item's tip null and refuses the merge with a message about there
    // being no commit at all — while a `commit` row plainly exists. Refusing
    // at the write turns that into an error the caller can act on.
    if (input.kind === "commit" && (input.commitSha === undefined || input.commitSha === null)) {
      throw new InvalidInputError("A commit artifact must record its commitSha.", {
        fields: ["commitSha"],
      });
    }

    // §6: "Null on artifacts that aren't reviews — a plan document has no
    // verdict; its `plan-review` does." Enforced rather than merely
    // documented, because a verdict on a non-review is not inert: `hasApproval`
    // matches on kind and verdict alone, so a `plan` row carrying `approved`
    // would be invisible to it but a `test_run` carrying `lgtm` is exactly the
    // sort of thing that reads as a passed gate to a human skimming the table.
    if (input.verdict != null && !REVIEW_KINDS.has(input.kind) && input.verdict !== "na") {
      throw new InvalidInputError(
        `A ${input.kind} artifact is not a review, so it takes no verdict (or 'na').`,
        { fields: ["verdict", "kind"] },
      );
    }

    if (input.followUpItemId) {
      const followUpRows = await ctx.db.$queryRawUnsafe<{ id: string }[]>(
        `SELECT "id" FROM "Item" WHERE "id" = $1`,
        input.followUpItemId,
      );
      if (followUpRows.length === 0) {
        throw new NotFoundError(`No such follow-up item: ${input.followUpItemId}.`, {
          fields: ["followUpItemId"],
        });
      }
    }

    // Validated here rather than by the column: Postgres cannot apply an enum
    // type to a value nested inside jsonb (schema.prisma's own note on
    // `findings`), so the severity vocabulary is only ever enforced in code.
    // `parseFindings` refuses anything that is not an array, so "no findings
    // at all" is checked here rather than handed to it — omitting the field
    // is not the same claim as sending an empty list, and only the latter is
    // a findings list. An empty list is stored as NULL, matching the import
    // path: `findings: []` and `findings: null` are the same fact, and two
    // spellings of it in the column would make every later reader handle both.
    //
    // `InvalidFindingError` is translated rather than left to propagate.
    // It is not a `ServiceError`, so the runtime would wrap it as `internal`
    // — reporting a caller's bad severity value as a server fault, with a
    // 500 and a message that says nothing about what to fix. The severity
    // ladder is validated in code because Postgres cannot apply an enum type
    // inside jsonb (schema.prisma's note on `findings`), so this is the only
    // place that translation can happen. Its message already names the index
    // and the allowed values, so it is carried through as-is.
    let findings;
    try {
      findings =
        input.findings === undefined || input.findings === null
          ? null
          : parseFindings(input.findings);
    } catch (error) {
      if (error instanceof InvalidFindingError) {
        throw new InvalidInputError(error.message, { fields: ["findings"], cause: error });
      }
      throw error;
    }

    const { createdByType, createdById, assignmentId } = await resolveCreator(ctx, input);
    const reviewRound = await resolveReviewRound(ctx, input);

    const rows = await ctx.db.$queryRawUnsafe<RecordedArtifact[]>(
      // Every enum bind is cast explicitly. Postgres infers an enum type for a
      // *literal* but refuses to for a bind parameter, so an uncast `"kind" = $2`
      // fails with "operator does not exist" rather than comparing as text —
      // the same rule `artifact-tip.ts` documents, and one only a DB-backed
      // test can catch.
      `INSERT INTO "Artifact" (
         "id", "itemId", "kind", "verdict", "reviewRound", "commitSha",
         "body", "ref", "browserSession", "findings", "followUpItemId",
         "createdByType", "createdById"
       )
       VALUES (
         gen_random_uuid(), $1, $2::"ArtifactKind", $3::"Verdict", $4, $5,
         $6, $7, $8, $9::jsonb, $10, $11::"HolderType", $12
       )
       RETURNING "id", "itemId", "kind"::text AS "kind", "verdict"::text AS "verdict",
                 "reviewRound", "commitSha", "ref", "browserSession", "followUpItemId",
                 "createdByType"::text AS "createdByType", "createdById", "createdAt"`,
      input.itemId,
      input.kind,
      input.verdict ?? null,
      reviewRound,
      input.commitSha ?? null,
      input.body ?? null,
      input.ref ?? null,
      input.browserSession ?? null,
      findings === null || findings.length === 0 ? null : JSON.stringify(findings),
      input.followUpItemId ?? null,
      createdByType,
      createdById,
    );

    const artifact = rows[0];
    if (!artifact) {
      // Unreachable — `INSERT ... RETURNING` returns its row or throws.
      // Guarded rather than asserted with `!` so a driver that ever changed
      // that contract fails here instead of on the first property access.
      throw new Error("record_artifact: INSERT ... RETURNING produced no row.");
    }

    // A review artifact is a review *happening*, which is the fact the ledger
    // is meant to carry — SCHEMA.md §3's `review` event. `assignmentId` is
    // attached when the caller holds one, for the same "which agent said
    // this" attribution `note` gives.
    if (REVIEW_KINDS.has(input.kind)) {
      await appendEvent(ctx.db, {
        itemId: input.itemId,
        actor: {
          actorType: createdByType,
          actorId: createdById,
          sessionId: input.sessionId ?? null,
        },
        assignmentId,
        type: "review",
        payload: { kind: input.kind, verdict: artifact.verdict, round: artifact.reviewRound },
      });
    }

    return artifact;
  },
});

const requestReviewInput = z
  .object({
    itemId: z.string().min(1),
    /** Which round is being requested. Defaults to the item's current round, for `record_artifact`'s reason. */
    round: z.coerce.number().int().min(1).optional(),
    actorType: z.enum(["person", "agent", "system"]).optional(),
    actorId: z.string().min(1).nullable().optional(),
    sessionId: z.string().min(1).nullable().optional(),
  })
  .strict();

export type RequestReviewInput = z.infer<typeof requestReviewInput>;

/**
 * `request_review` — emits the `review_requested` event that
 * `artifact.review_requested` gates `in_review` on.
 *
 * **A separate operation from `record_artifact`, on purpose.** Requesting a
 * review and recording one are opposite ends of the same exchange: the
 * request is an act with no deliverable, made by whoever wants the review;
 * the record is the deliverable, produced by whoever did it. They are made by
 * different parties at different times, and `review_requested` is an event
 * with no artifact row precisely because there is nothing yet to point at
 * (guards/review-requested.ts documents at length why §16's wording, which
 * calls it an artifact kind, does not match the schema — `ArtifactKind` has
 * no such value).
 *
 * Folding it into `record_artifact` would have meant recording a review in
 * order to ask for one, which inverts the direction of the whole thing.
 */
// Stryker disable all : this metadata is a module-level literal, read into
// the registry at import — before any test body runs and never re-evaluated
// — so a mutation here is unkillable by construction, NOT untested.
// `scripts/check-operation-metadata-mutants.mjs` requires this and carries
// the full reasoning, including why moving the assertions into a test body
// does not help.
export const requestReview = defineOperation({
  name: "request_review",
  kind: "write",
  summary: "Requests a review of an item, recording that one was asked for.",
  // Stryker restore all
  input: requestReviewInput,
  async handler(ctx: ServiceContext, input: RequestReviewInput) {
    const itemRows = await ctx.db.$queryRawUnsafe<{ id: string }[]>(
      `SELECT "id" FROM "Item" WHERE "id" = $1`,
      input.itemId,
    );
    if (itemRows.length === 0) {
      throw new NotFoundError(`No such item: ${input.itemId}.`, { fields: ["itemId"] });
    }

    let assignmentId: string | null = null;
    let actorType: "person" | "agent" | "system" = input.actorType ?? "system";
    let actorId: string | null = input.actorId ?? null;

    if (input.sessionId) {
      const rows = await ctx.db.$queryRawUnsafe<LiveAssignmentRow[]>(
        `SELECT "id", "holderType", "holderId" FROM "Assignment"
          WHERE "itemId" = $1 AND "sessionId" = $2 AND "releasedAt" IS NULL
          LIMIT 1`,
        input.itemId,
        input.sessionId,
      );
      const live = rows[0];
      if (live) {
        assignmentId = live.id;
        if (input.actorType === undefined) actorType = live.holderType;
        if (input.actorId == null) actorId = live.holderId;
      }
    }

    const round = input.round ?? (await currentReviewRound(ctx.db, input.itemId));

    // `{round}` — the payload shape SCHEMA.md §3 gives for this type. The
    // guard reads existence only, but a round-less request would make the
    // ledger unable to answer which round was being asked about, which is the
    // one thing the payload is for.
    return appendEvent(ctx.db, {
      itemId: input.itemId,
      actor: { actorType, actorId, sessionId: input.sessionId ?? null },
      assignmentId,
      type: "review_requested",
      payload: { round },
    });
  },
});
