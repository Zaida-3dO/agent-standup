// `my_work` — SCHEMA.md §18 (`my_work`: "What you hold right this moment,
// and in what role"), MILESTONES.md #28's second half.
//
// This is a session-scoped read over `assignments` (row #23) joined to
// `events` for a lightweight per-item "last happened" marker, **not** a
// filter on `list_items`. That distinction is the row's own point, and it
// is structural, not just a difference in query shape:
//
//   - `list_items` (row #26) answers "which items match these criteria" —
//     it has no concept of a session or a role at all; its rows are
//     `ItemRecord`s with none of `assignments`' columns.
//   - `my_work` answers "what does THIS session hold, and as what" — a
//     question `list_items` cannot express because the *role* a caller
//     holds on an item is not a property of the item. Two different
//     sessions can hold the same item in two different roles at once
//     (SCHEMA.md §2: "orchestrator *plus* a builder *plus* two reviewers");
//     an item-list filter, however parameterised, returns the same row for
//     both callers, because the row *is* the item and the item has no
//     "role" column to filter on. `my_work` returns one row **per live
//     assignment for this session**, each carrying that assignment's own
//     `role`/`roleCustom` — information that exists only on `assignments`,
//     never on `items`, and so is categorically outside what any item
//     filter could produce no matter how it were parameterised.
//
// See `tests/my-work-operation.test.ts` for the two-sessions-different-roles
// case that proves this in practice.
import { z } from "zod";
import { defineOperation } from "../operation";
import type { ServiceContext } from "../context";
import {
  NOT_ARCHIVED_CONDITION,
  toItemRecord,
  type ItemRecord,
  type RawItemRow,
} from "../items/row";
import type { HolderType, Liveness, Role } from "../../claims";
import {
  APPROVING_VERDICT_VALUES,
  findStalledWork,
  type ApprovalFacts,
  type StalledWorkFinding,
} from "./stalled-work";

const inputSchema = z
  .object({
    sessionId: z.string().min(1),
  })
  .strict();

export type MyWorkInput = z.infer<typeof inputSchema>;

export interface MyWorkEntry {
  readonly item: ItemRecord;
  /** This session's own live assignment on `item` — the role information no item-list filter carries. */
  readonly assignment: {
    readonly id: string;
    readonly role: Role;
    readonly roleCustom: string | null;
    readonly holderType: HolderType;
    readonly holderId: string;
    readonly liveness: Liveness;
    readonly claimedAt: string;
    readonly lastActive: string;
  };
}

export interface MyWorkOutput {
  readonly sessionId: string;
  readonly items: readonly MyWorkEntry[];
  /**
   * Whether a hook has ever reported a protocol version for this session.
   *
   * A session with no hook can claim and do work — the version being
   * unreported is information, not a reason to refuse ownership. What that
   * leaves is a reader unable to tell **"no rule could have fired here,
   * because nothing was watching"** from **"a rule fired and found nothing
   * wrong"**, and the two look identical in a session's history. It matters
   * most at review: trusting that policy was enforced on a session that ran
   * no hook at all is trusting something that was never true.
   *
   * `false` is therefore the honest answer for a session that has never
   * registered at all, not just one that registered without a version.
   * Neither has a hook this installation has heard from, and a reader asking
   * "was anything watching" is owed the same answer for both.
   *
   * It says nothing about whether a rule *did* fire — only whether one
   * could have. That is deliberately the narrower claim: what fired is in
   * the ledger, and a summary field that implied otherwise would be a new
   * way of being wrong about the same question.
   */
  readonly hooked: boolean;
  /**
   * `true` when this session declared a hook version and this installation
   * has never received a single tool call from it.
   *
   * **`hooked` answers what the session said; this answers whether anything
   * bore it out.** They are different questions and only look like one
   * question while every registration is honest. A session that declares a
   * hook it does not run reports `hooked: true` — the declaration is real —
   * and a reader taking that as "something was watching" is trusting the
   * same thing `hooked` exists to stop them trusting, one level up.
   *
   * That configuration is reachable rather than theoretical here: the hook
   * is provisioned per machine, and it **fails open**, so a session on a
   * machine without it declares a version, emits nothing, and nothing
   * anywhere reports the discrepancy. This is that report.
   *
   * **It is evidence of a misreporting registration, not of an idle
   * session**, and the distinction is what keeps it from crying wolf: a
   * hooked session reports its tool calls, and a session calling `my_work`
   * has by definition made at least one call — so for a genuinely hooked
   * session this is `false` as soon as its first flush lands. It stays
   * `true` only while the hook is silent for a session that promised one.
   *
   * Necessarily `false` when `hooked` is `false`: a session that declared
   * nothing has made no claim to contradict.
   */
  readonly declaredHookSilent: boolean;
  /**
   * Work this session holds that was approved and never merged.
   *
   * **The board records state transitions faithfully and never notices that
   * a state has stopped changing.** Those are different capabilities and
   * only the second one carries work to merge; this field is the second
   * one, for the single situation this schema can answer without guessing.
   * See `./stalled-work.ts` for why this predicate and not the three
   * neighbouring ones in `docs/plans/INTERVENTIONS.md`.
   *
   * **Here rather than on the board read**, and the distinction is not
   * arbitrary. `86a0930` declined to put `get_stale_candidates`' citation
   * signal on `get_board`, for two reasons: a cross-row text scan "cannot
   * back a filter that provably agrees with its marking", and it "would put
   * an unbounded scan on the hottest read in the product". Neither applies
   * here, but the second is worth being explicit about: this read is
   * already scoped by `WHERE a."sessionId" = $1 AND a."releasedAt" IS
   * NULL`, so the lookup is bounded by **what one session holds** rather
   * than by the size of the board. `my_work` is also the read that already
   * answers "what do I hold", which makes "and which of it is waiting on
   * me" the same question one clause further on.
   *
   * **Empty is the ordinary answer**, and keeping it that way is the whole
   * design. An approval younger than
   * `interventions.approved_unmerged_after_seconds` produces nothing, a
   * session holding unreviewed work produces nothing, and a merged item
   * produces nothing. A signal that fires on everything is worse than no
   * signal, because a reader learns to skip it.
   *
   * **It is a report, not a judgement** — the posture `orientation`'s
   * `silentCrew` and `get_stale_candidates` both take deliberately. Nothing
   * here transitions, merges, evicts or escalates anything; it states a
   * fact and a duration and leaves the decision to the reader.
   */
  readonly stalledWork: readonly StalledWorkFinding[];
}

interface RawSessionAssignmentRow extends RawItemRow {
  assignmentId: string;
  assignmentRole: Role;
  assignmentRoleCustom: string | null;
  assignmentHolderType: HolderType;
  assignmentHolderId: string;
  assignmentLiveness: Liveness;
  assignmentClaimedAt: Date | string;
  assignmentLastActive: Date | string;
}

// Exported (rather than kept file-private, like `isoOrNull` in items/row.ts)
// specifically so `claimedAt`/`lastActive`'s mapping can be unit-tested
// directly: `$queryRawUnsafe` always deserializes `Assignment.claimedAt`/
// `lastActive` (Postgres `timestamptz`) as a JS `Date`, so the DB-backed
// tests in my-work-operation.test.ts can only ever exercise the `Date`
// branch — the string-passthrough branch needs a direct call to be reached
// honestly at all. See tests/my-work-operation.test.ts's "isoOrString"
// describe block.
export function isoOrString(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : value;
}

// Stryker disable all : this metadata is a module-level literal, read into
// the registry at import — before any test body runs and never re-evaluated
// — so a mutation here is unkillable by construction, NOT untested.
// `scripts/check-operation-metadata-mutants.mjs` requires this and carries
// the full reasoning, including why moving the assertions into a test body
// does not help.
export const myWork = defineOperation({
  name: "my_work",
  kind: "read",
  summary: "What this session holds right now, and in what role, per SCHEMA.md §18.",
  // Stryker restore all
  input: inputSchema,
  async handler(ctx: ServiceContext, input: MyWorkInput): Promise<MyWorkOutput> {
    // One statement: every item this session holds a *live* assignment on
    // (`releasedAt IS NULL` — the same predicate `liveAssignments` in
    // claims.ts reads, so "what my_work reports" and "what the claim/release
    // machinery enforces" cannot disagree about which rows count), joined
    // to that assignment's own role columns. A raw join rather than two
    // round-trips (assignments, then items by id) because the row this
    // returns genuinely is one item paired with one assignment — the same
    // reasoning `toItemRecord` already applies to keep one mapping instead
    // of one per caller.
    // `i.*` rather than the shared `ITEM_COLUMNS` list: that constant is a
    // flat, pre-joined string built for an unqualified `SELECT ... FROM
    // "Item"` (get-item.ts, list-items.ts), and re-deriving a per-column
    // `i."column"` alias list from it would need to parse its own quoting
    // rather than just ask Postgres for every column on the aliased table —
    // which is exactly what `i.*` does, with no name collision here because
    // every assignment column below is aliased under an `assignment`-
    // prefixed name.
    const rows = await ctx.db.$queryRawUnsafe<RawSessionAssignmentRow[]>(
      `SELECT
         i.*,
         a."id" AS "assignmentId",
         a."role" AS "assignmentRole",
         a."roleCustom" AS "assignmentRoleCustom",
         a."holderType" AS "assignmentHolderType",
         a."holderId" AS "assignmentHolderId",
         a."liveness" AS "assignmentLiveness",
         a."claimedAt" AS "assignmentClaimedAt",
         a."lastActive" AS "assignmentLastActive"
       FROM "Assignment" a
       -- An archived item is not work in hand, even while an assignment on
       -- it is still open (MILESTONES.md #137). Archiving does not release
       -- claims — a claim is a fact about who took the row, and rewriting it
       -- would falsify that history — so without this condition a session
       -- would be shown holding a row that every other read denies it, with
       -- nothing in the response to explain the contradiction.
       JOIN "Item" i ON i."id" = a."itemId"
       WHERE a."sessionId" = $1 AND a."releasedAt" IS NULL AND i.${NOT_ARCHIVED_CONDITION}
       ORDER BY a."claimedAt" ASC`,
      input.sessionId,
    );

    // A second statement rather than a join onto the first: this answers a
    // question about the *session*, and there is exactly one answer to it
    // however many assignments come back — including **none**, which is
    // precisely the case a join would lose. A session holding nothing still
    // has a hook, or still does not, and that is worth knowing about the
    // session a reviewer is looking at, held work or not.
    // `EXISTS` rather than a count or a MAX: the question is only whether
    // this installation has ever heard from this session's hook, and an
    // existence test lets Postgres stop at the first row instead of walking
    // a busy session's whole telemetry history to compute a number nothing
    // reads. Correlated on `sessionId` alone — deliberately not scoped to
    // the claim or to a time window, because a hook reports every tool call
    // whether or not the session holds anything, so ANY row is proof the
    // hook runs, and that is exactly the claim being checked.
    const sessionRows = await ctx.db.$queryRawUnsafe<
      { hookVersion: number | null; hasToolCall: boolean }[]
    >(
      `SELECT s."hookVersion",
              EXISTS (SELECT 1 FROM "ToolCall" t WHERE t."sessionId" = s."id") AS "hasToolCall"
         FROM "Session" s WHERE s."id" = $1`,
      input.sessionId,
    );

    // No row and a null version collapse to the same answer on purpose —
    // see `hooked`'s own comment. `?? null` rather than optional chaining
    // alone so an absent row and a present-but-null column take the same
    // path instead of one being `undefined` and the other `null`.
    const hooked = (sessionRows[0]?.hookVersion ?? null) !== null;

    // Only meaningful for a session that declared something. An absent row
    // yields `hooked: false` above and must yield `false` here too — there
    // is no declaration for the missing telemetry to contradict — so the
    // `hooked &&` is load-bearing rather than defensive.
    const declaredHookSilent = hooked && sessionRows[0]?.hasToolCall !== true;

    const items: MyWorkEntry[] = rows.map((row) => ({
      item: toItemRecord(row),
      assignment: {
        id: row.assignmentId,
        role: row.assignmentRole,
        roleCustom: row.assignmentRoleCustom,
        holderType: row.assignmentHolderType,
        holderId: row.assignmentHolderId,
        liveness: row.assignmentLiveness,
        claimedAt: isoOrString(row.assignmentClaimedAt),
        lastActive: isoOrString(row.assignmentLastActive),
      },
    }));

    // A third statement, and like the second it answers a question the
    // join above cannot: "which of these did a reviewer already approve,
    // and when". It is skipped entirely when the session holds nothing —
    // there is no item to have been approved, so the query would be a
    // round trip guaranteed to return no rows.
    //
    // **Bounded by the ids already in hand**, never by a scan of `Item` or
    // `Artifact`: `WHERE a."itemId" = ANY($1)` over the exact list this
    // session holds, which is what keeps the cost proportional to one
    // session's work rather than to the board. It reads the
    // `[itemId, kind, reviewRound]` index on its leading column.
    //
    // `MAX("createdAt")` per item rather than every approving row, because
    // the finding needs one fact — how long the newest approval has waited.
    // Re-review is normal and a second approving round is *newer*
    // evidence, so taking the max is what makes a re-approved item read as
    // freshly approved rather than as having waited since round one.
    const approvalRows =
      rows.length === 0
        ? []
        : await ctx.db.$queryRawUnsafe<{ itemId: string; approvedAt: Date | null }[]>(
            `SELECT a."itemId", MAX(a."createdAt") AS "approvedAt"
               FROM "Artifact" a
              WHERE a."itemId" = ANY($1::text[])
                AND a."verdict" = ANY($2::"Verdict"[])
              GROUP BY a."itemId"`,
            rows.map((row) => row.id),
            APPROVING_VERDICT_VALUES,
          );

    const approvedAtByItem = new Map(approvalRows.map((row) => [row.itemId, row.approvedAt]));

    // `now` is read once and passed in, rather than each finding calling
    // `Date.now()` for itself: two items approved at the same instant must
    // report the same age, and a clock read per row cannot promise that.
    const facts: ApprovalFacts[] = rows.map((row) => ({
      itemId: row.id,
      title: row.title,
      state: row.state,
      approvedAt: approvedAtByItem.get(row.id) ?? null,
    }));

    const stalledWork = findStalledWork(
      facts,
      ctx.settings.values["interventions.approved_unmerged_after_seconds"],
      new Date(),
    );

    return { sessionId: input.sessionId, items, hooked, declaredHookSilent, stalledWork };
  },
});
