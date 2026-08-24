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
import {
  FINDING_SEVERITIES,
  InvalidFindingError,
  findingsShapeRefusal,
  parseFindings,
} from "@/lib/findings";
import { PULL_REQUEST_STATUSES, isLinkableUrl, isPullRequestStatus } from "@/lib/pull-requests";
import { currentReviewRound } from "../guards/merge-review-round";
import { MERGE_OVERRIDE_KIND, MIN_REASON_LENGTH } from "../guards/merge-override";

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
  "historical_verification",
  "pull_request",
  "screenshot",
  "merge_override",
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
    /**
     * On a `commit` artifact, the sha this commit is a REWRITE OF — set when
     * it carries already-reviewed work under a new identity rather than new
     * work (§6d). A squash merge, a rebase, an amend.
     *
     * This is what makes the merge gate satisfiable under a squash-merge
     * workflow. The gate wants an approving review at the tip; a squash
     * produces a sha that did not exist when the review happened and cannot
     * have been reviewed. Recording "this landed sha is that reviewed sha,
     * rewritten" lets the approval carry forward onto the commit it actually
     * became, without inventing an approval that was never given.
     *
     * Supplied by the caller because only the caller that performed the
     * merge knows both shas — the service has no clone to ask, and ancestry
     * would not answer it anyway, since a squash commit is not a descendant
     * of the branch it squashed.
     */
    supersedesSha: z.string().trim().min(1).nullable().optional(),
    body: z.string().nullable().optional(),
    ref: z.string().trim().min(1).nullable().optional(),
    /** Which browser session a visual review ran in (§6) — an opaque string to the core. */
    browserSession: z.string().trim().min(1).nullable().optional(),
    /**
     * The review's individual findings, each with a severity (§6a).
     *
     * **Typed here as well as validated by `parseFindings`, and the
     * duplication is the point.** This field was `z.unknown()`, which meant
     * the only statement of its shape lived inside `parseFindings` — a
     * runtime function neither `describe_tool` nor a `tools/list` client can
     * see. So the field rendered as `"type": "unknown"` with no rules, on a
     * tool where every other field is typed concretely, and a caller had
     * nothing to copy: the one field requiring a guess was the one field
     * with no contract. Declaring it as a schema is what makes the shape
     * *visible* — `describeFields` reads exactly this node, and MCP
     * advertises it — and an untyped field cannot be documented into
     * existence.
     *
     * `parseFindings` still runs and still owns the verdict. It is the
     * shared validator the import path uses too, and it refuses things this
     * schema cannot express as cleanly (an all-whitespace `text`); keeping
     * both means the two doors agree. Deliberately NOT `.strict()`: an
     * unrecognised key on a finding is dropped by `parseFindings` rather
     * than refused, and tightening that here would start rejecting calls
     * that the import path accepts.
     */
    findings: z
      .array(
        z.object({
          /** What was found. The one required field — a finding with no text is not a finding. */
          text: z.string().min(1),
          /** How severe. Optional and NOT defaulted: absent reads as "ungraded", not "low". */
          severity: z.enum(FINDING_SEVERITIES).optional(),
          /** Optional free-form location — a file, a line, a route. Never parsed. */
          where: z.string().optional(),
        }),
        {
          // **Zod refuses this field before `parseFindings` ever runs, so
          // the worked-shape message has to live here too.** `ServiceRuntime`
          // calls `input.safeParse` ahead of the handler body, which means an
          // MCP or HTTP caller who sends a JSON-encoded string — the exact
          // near-miss `describeReceived` was written to name — used to read
          // Zod's generic "Expected array, received string" and never see the
          // sentence telling them to `JSON.parse` it first.
          //
          // The message is borrowed from the shared constant rather than
          // restated, so the two doors cannot drift apart.
          //
          // An `errorMap` and NOT `invalid_type_error`, because the latter is
          // a fixed string and this message has to describe *what arrived* —
          // "a JSON-encoded string" versus "a number" is the entire value of
          // it, and a static string could only say one of them. `ctx.data`
          // carries the real value, so `describeReceived` can name it.
          //
          // Scoped to the wrong-type issue on this node alone. An issue
          // *inside* a well-formed array — a bad `severity`, an empty `text`
          // — keeps Zod's own text and its precise `findings.0.severity`
          // path, which is more useful to a caller than this whole-field
          // sentence would be; only the "the field itself is not an array"
          // case is rewritten.
          errorMap: (issue, ctx) =>
            issue.code === z.ZodIssueCode.invalid_type && issue.expected === "array"
              ? { message: findingsShapeRefusal(ctx.data) }
              : { message: ctx.defaultError },
        },
      )
      .nullable()
      .optional(),
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
  readonly supersedesSha: string | null;
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

/**
 * The conditional rules and worked example `describe_tool` serves for this
 * operation.
 *
 * Hoisted to module scope rather than written inline in the declaration so
 * that the `Stryker disable all` / `restore all` range around the metadata
 * stays short enough for `scripts/check-operation-metadata-mutants.mjs` to
 * see both ends of it — the checker requires the closing comment within a
 * bounded window below the declaration, which a rules list this long would
 * push past.
 */
const RECORD_ARTIFACT_CONTRACT = {
  rules: [
    {
      fields: ["findings"],
      rule:
        "`findings` is a list of the review's individual findings — an array of objects, each " +
        "with `text` (required, non-empty), an optional `severity` from " +
        `${FINDING_SEVERITIES.join(", ")}, and an optional free-form \`where\`. Send the array ` +
        "itself, not a JSON string of it. An absent `severity` records an UNGRADED finding, " +
        "which is a different claim from `info` and is never defaulted. Example: " +
        '[{"text": "N+1 query in the board loader", "severity": "medium", "where": "src/lib/board.ts:88"}]',
    },
    {
      fields: ["findings"],
      rule:
        "`findings: []` and omitting the field are stored identically (as NULL) — an empty " +
        "list is not a distinguishable claim. Findings are recorded for the record and for " +
        "display; no merge guard reads a severity, so a `critical` finding under an approving " +
        "verdict does NOT by itself block a merge. The verdict is what gates.",
    },
    {
      fields: ["createdByType", "createdById"],
      rule:
        "An artifact must record who produced it: pass both, or a `sessionId` holding a live " +
        "assignment on the item to be credited from. Never guessed — `createdByType` is what " +
        "`merge.requires_authorisation` reads to decide a human authorised the merge.",
    },
    {
      fields: ["commitSha", "kind"],
      rule: "A `commit` artifact must carry `commitSha`; a `historical_verification` must carry both `commitSha` and a `body` saying what was inspected.",
    },
    {
      fields: ["ref", "kind"],
      rule: "A `pull_request` artifact must carry the PR's http(s) URL in `ref`, and its `body`, when set, must be one of the pull-request statuses.",
    },
    {
      fields: ["verdict", "kind"],
      rule: "Only `plan_review`, `code_review` and `visual_review` take a verdict; any other kind must leave it unset or `na`.",
    },
  ],
  example: {
    itemId: "b1f0c3d2-0000-4000-8000-000000000000",
    kind: "code_review",
    verdict: "lgtm_with_nits",
    body: "Reads well. Two things worth fixing before the next round.",
    findings: [
      { text: "N+1 query in the board loader", severity: "medium", where: "src/lib/board.ts:88" },
      { text: "Stray console.log", severity: "info", where: "src/app/page.tsx:12" },
    ],
    createdByType: "agent",
    createdById: "reviewer-7b2",
  },
};

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
  contract: RECORD_ARTIFACT_CONTRACT,
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

    // A `pull_request` artifact exists to be turned into a link, so one that
    // names no URL is the same shape of useless as a `commit` with no
    // `commitSha` above: `progress_report` reads `ref` off the newest
    // `pull_request` row, and a null one would make the item look as though
    // it has a PR while rendering nothing to click.
    //
    // This is the write that makes the report's "never a dead link" promise
    // structural rather than aspirational. The report will not compose a URL
    // it was not given, so the only way a link reaches a reader is a caller
    // having recorded one here — and the only way to record one is to supply
    // it. `ref` is already `.trim().min(1)`, so a whitespace-only URL is
    // refused by the schema before this runs.
    if (input.kind === "pull_request") {
      if (input.ref === undefined || input.ref === null) {
        throw new InvalidInputError(
          "A pull_request artifact must record the PR's URL in `ref` — the report renders it as " +
            "a link, and a PR row with no URL would advertise a link there is nothing behind.",
          { fields: ["ref"] },
        );
      }
      if (!isLinkableUrl(input.ref)) {
        throw new InvalidInputError(
          "A pull_request artifact's `ref` must be an http(s) URL — the report renders it as a " +
            "markdown link, so anything else is either unclickable or an injection into whatever " +
            "displays the report.",
          { fields: ["ref"] },
        );
      }
      // `body` carries the PR's status, and the vocabulary is two words. It
      // is refused rather than coerced because the alternative — treating
      // unrecognised prose as `open` — is how a closed PR keeps rendering as
      // a live link: a caller recording "closed by review" would be read as
      // open. The read path is deliberately more forgiving (see
      // `pullRequestStatusOf`), because rows written before this vocabulary
      // existed cannot be refused retrospectively.
      if (input.body != null && !isPullRequestStatus(input.body.trim())) {
        throw new InvalidInputError(
          `A pull_request artifact's \`body\` records its status and must be one of: ${PULL_REQUEST_STATUSES.join(", ")}. ` +
            "Record a PR that has closed as a NEW pull_request row with status `closed` — artifacts " +
            "are append-only, so the row that opened it is never edited.",
          { fields: ["body"] },
        );
      }
    }

    // A `historical_verification` must carry the evidence that makes it
    // checkable — SCHEMA.md §6b. This is the requirement the whole kind rests
    // on, so it is enforced at the write rather than described in a doc.
    //
    // The distinction it protects: an approving verdict is a *judgement*, and
    // a judgement cannot be audited after the fact — there is nothing in it
    // to be right or wrong about. An inspection is a set of *facts*: which
    // commit was read, and what was checked in it. Recorded, those can be
    // confirmed or refuted by the next person to look. A
    // `historical_verification` with no commit and no account of what was
    // inspected would be an unfalsifiable approval wearing a different name,
    // which is precisely the thing this kind exists to be an alternative to.
    if (input.kind === "historical_verification") {
      if (input.commitSha === undefined || input.commitSha === null) {
        throw new InvalidInputError(
          "A historical_verification must record the commitSha it was checked against — an " +
            "inspection that does not say which code it read cannot be confirmed by anyone else.",
          { fields: ["commitSha"] },
        );
      }
      if (input.body === undefined || input.body === null || input.body.trim().length === 0) {
        throw new InvalidInputError(
          "A historical_verification must record in `body` what was inspected and how it was " +
            "confirmed — the evidence is the entire difference between this and an approval " +
            "nobody can check.",
          { fields: ["body"] },
        );
      }
    }

    // A `merge_override` must carry the two things that make it an override
    // rather than a bypass — SCHEMA.md §6c: the commit it excuses, and a
    // reason someone can read.
    //
    // **Enforced at the write, not at the merge.** The alternative — let the
    // artifact be recorded and refuse the merge later — would leave a row on
    // the item asserting an override that never qualified, which is exactly
    // the sort of thing a later reader counts as an override. The row should
    // not exist unless it means something.
    //
    // The length floor is a crude proxy and is not pretending otherwise (see
    // `MIN_REASON_LENGTH`): it cannot distinguish a considered sentence from
    // forty characters of keyboard. What it removes is the one-character
    // reason, which is the shape a mandatory field collapses into the moment
    // nothing checks its content. A field satisfiable by "x" is an optional
    // field with extra keystrokes, and this one is the entire difference
    // between an audited override and a silent one.
    if (input.kind === MERGE_OVERRIDE_KIND) {
      if (input.commitSha === undefined || input.commitSha === null) {
        throw new InvalidInputError(
          "A merge_override must record the commitSha it applies to — an override is a " +
            "judgement about one specific state of the code, not standing permission to skip " +
            "review.",
          { fields: ["commitSha"] },
        );
      }
      const reason = input.body?.trim() ?? "";
      if (reason.length === 0) {
        throw new InvalidInputError(
          "A merge_override must record in `body` why the merge should proceed without an " +
            "approving review at this commit. The stated reason is the whole difference between " +
            "an override and a silent bypass.",
          { fields: ["body"] },
        );
      }
      if (reason.length < MIN_REASON_LENGTH) {
        throw new InvalidInputError(
          `A merge_override's reason is ${reason.length} characters; it must be at least ` +
            `${MIN_REASON_LENGTH}. Say what changed since the review and why it does not ` +
            "invalidate it — this row is kept permanently and is what a later reader has to " +
            "judge the merge by.",
          { fields: ["body"] },
        );
      }
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
         "supersedesSha", "body", "ref", "browserSession", "findings", "followUpItemId",
         "createdByType", "createdById"
       )
       VALUES (
         gen_random_uuid(), $1, $2::"ArtifactKind", $3::"Verdict", $4, $5,
         $6, $7, $8, $9, $10::jsonb, $11, $12::"HolderType", $13
       )
       RETURNING "id", "itemId", "kind"::text AS "kind", "verdict"::text AS "verdict",
                 "reviewRound", "commitSha", "supersedesSha", "ref", "browserSession",
                 "followUpItemId",
                 "createdByType"::text AS "createdByType", "createdById", "createdAt"`,
      input.itemId,
      input.kind,
      input.verdict ?? null,
      reviewRound,
      input.commitSha ?? null,
      input.supersedesSha ?? null,
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
