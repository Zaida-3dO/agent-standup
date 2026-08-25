// `get_needs_you` — "what needs this person", answered in one call.
//
// **The gap this closes.** The `/needs-you` inbox admits exactly three
// things: an item blocked on a person where that person is you · an item at
// `in_review` whose merge needs a person's approval · anything at
// `plan_review`. None of that was expressible as a `list_items` filter —
// there is no `blockedOnType`/`blockedOnPersonId` filter and no
// `mergeAuthority` one — so the screen issued **three** `full: true` reads
// of up to 200 rows each and narrowed them in the browser, discarding most
// of what it paid for. Three round trips, three separate snapshots, and the
// admission rule living in the front end.
//
// **Why a purpose-built read rather than three new filters on `list_items`.**
// The admission rule is a *product decision* ("what counts as needing a
// person"), not a query predicate. Pushed down as filters it would still
// have to be re-derived by every other consumer — a digest, a notification,
// a second client — and each would be free to get it subtly wrong. As one
// operation the rule has exactly one definition, and `NEEDS_YOU_REASONS`
// below is it. The three-filters route also cannot express this set at all
// in one call: it is a **union across three different states**, and
// `list_items` filters one state at a time.
//
// **One transaction, so the three sources agree.** The union is read in a
// single statement inside the call's one transaction (`runtime.ts` opens
// one per call), so an item transitioning between `plan_review` and
// `executing` mid-read cannot appear twice or vanish from both halves — the
// exact hazard three independent client reads had.
//
// **The reason is computed in SQL and returned, not re-derived.** A caller
// rendering "why is this here" must not have to reimplement the admission
// rule to label a row it was already sent — that would put the rule back in
// the client, which is what this operation exists to stop. It follows the
// convention #37's review established: the client reads what the server
// derived.
//
// ── The sidebar badge and this read now agree ────────────────────────────
//
// They did not before, and the difference was an accident of two
// implementations rather than a decision: the badge counted only
// `blocked_on_you` (`@/lib/board/view.ts`'s `needsYou`, over the Waiting
// column), while the inbox admitted all three reasons. So the badge said 1
// and the list showed 4, with nothing to explain the gap. `fetchNeedsYouCount`
// now counts this operation's `total`, so the number beside the link is the
// length of the list behind it by construction rather than by two rules
// staying in step.
//
// **The slim shape is the default** (MILESTONES.md #107), with `full` for
// the whole record. Note the inbox itself is a *slim* caller: the four
// fields it draws beyond the summary — `blockedReason`, `updatedAt`,
// `mergeAuthority`, `reason` — are returned in the slim shape precisely so
// the screen does not have to ask for `full` and pay for `body` and
// `customFields` to render a one-line row. That is the fetching-and-
// discarding this task is about, and defaulting it away is the fix.
import { z } from "zod";
import { defineOperation } from "../operation";
import type { ServiceContext } from "../context";
import {
  ITEM_COLUMNS,
  NOT_ARCHIVED_CONDITION,
  toItemRecord,
  type ItemRecord,
  type RawItemRow,
} from "../items/row";

/**
 * Why an item needs a person. Three reasons, never merged into one label —
 * they call for different actions and the screen decides its affordances
 * from them.
 */
export const NEEDS_YOU_REASONS = ["blocked_on_you", "needs_approval", "plan_review"] as const;

export type NeedsYouReason = (typeof NEEDS_YOU_REASONS)[number];

const inputSchema = z
  .object({
    /**
     * The person the question is about. Required and never defaulted: an
     * inbox is meaningless without a subject, and guessing one would show
     * somebody else's queue — the one failure mode this read must not have.
     */
    personId: z.string().min(1),
    /**
     * Return whole `items` rows rather than the slim default. Off by
     * default — see the module header on why the slim shape here is
     * already sufficient for the inbox.
     */
    full: z.boolean().default(false),
    limit: z.number().int().min(1).max(200).default(50),
    cursor: z.string().min(1).optional(),
  })
  .strict();

export type GetNeedsYouInput = z.infer<typeof inputSchema>;

/**
 * One row of the inbox — the slim shape, which is `ItemSummaryRecord` plus
 * the four fields a row and its decide affordance actually draw.
 *
 * Wider than `ItemSummaryRecord` rather than reusing it verbatim, for the
 * same reason `BoardItemSummaryRecord` is (see its header): a caller that
 * had to fetch `full` records to render a one-line row would be paying for
 * `body` and `customFields` on every item in the list, which is the cost
 * this operation exists to remove.
 */
export interface NeedsYouSummaryRecord {
  readonly id: string;
  readonly title: string;
  readonly state: string;
  readonly headline: string | null;
  /** Why this item is in the inbox — derived server-side; see the module header. */
  readonly reason: NeedsYouReason;
  /** The reader's own words for why it is waiting, when there are any. */
  readonly blockedReason: string | null;
  /** ISO 8601 — what "how long it has waited" is computed from. */
  readonly updatedAt: string;
  readonly mergeAuthority: string;
}

/** A `full: true` row — the whole record, with the derived reason still attached. */
export interface NeedsYouRecord extends ItemRecord {
  readonly reason: NeedsYouReason;
}

export interface GetNeedsYouOutput {
  readonly items: readonly (NeedsYouSummaryRecord | NeedsYouRecord)[];
  /**
   * How many items need this person in total, ignoring `limit` — the
   * badge's number, and the reason it cannot drift from this list. Counted
   * over the same union in the same transaction rather than by a second
   * call, so the count and the page can never disagree.
   */
  readonly total: number;
  /** The `id` of the last row in this page, to pass back as `cursor`. Absent when this page is the last. */
  readonly nextCursor: string | null;
}

/**
 * The admission rule, as SQL.
 *
 * Three arms of a union, matching the three reasons exactly:
 *
 *   - **`blocked_on_you`** — `state = 'blocked'` narrowed to
 *     `blockedOnType = 'person'` and this person. `blockedOnType` is
 *     `person` / `external_process` / `time`, and only the first is a
 *     person's problem: an item waiting on a CI run or a timer is waiting,
 *     but not on *you*.
 *   - **`needs_approval`** — `state = 'in_review'` narrowed to
 *     `mergeAuthority = 'needs_approval'`, which is exactly the evidence
 *     `merge.requires_authorisation` checks for. `agent_judgement` and
 *     `pre_approved` are excluded because an agent may legitimately clear
 *     those alone, so they are not yet waiting on a person.
 *   - **`plan_review`** — admitted outright. Every item at that state is
 *     waiting on a person's approval, so no further narrowing applies.
 *
 * The three arms are mutually exclusive by state, so no item can appear
 * twice and no `DISTINCT` is needed — a `UNION ALL` is correct and cheaper
 * than a `UNION`, and using the deduplicating form would hide it if that
 * ever stopped being true.
 *
 * Archived rows are excluded on every arm (MILESTONES.md #137) — an archive
 * is the installation saying a row should never have existed, and an inbox
 * is the last place one should reappear.
 */
function admissionSql(columns: string): string {
  return `
    SELECT ${columns}, 'blocked_on_you' AS "reason" FROM "Item"
      WHERE ${NOT_ARCHIVED_CONDITION} AND "state" = 'blocked'::"ItemState"
        AND "blockedOnType" = 'person'::"BlockedOnType" AND "blockedOnPersonId" = $1
    UNION ALL
    SELECT ${columns}, 'needs_approval' AS "reason" FROM "Item"
      WHERE ${NOT_ARCHIVED_CONDITION} AND "state" = 'in_review'::"ItemState"
        AND "mergeAuthority" = 'needs_approval'::"MergeAuthority"
    UNION ALL
    SELECT ${columns}, 'plan_review' AS "reason" FROM "Item"
      WHERE ${NOT_ARCHIVED_CONDITION} AND "state" = 'plan_review'::"ItemState"
  `;
}

/** The columns the slim shape selects — see `NeedsYouSummaryRecord` for why these four beyond the summary. */
const NEEDS_YOU_SUMMARY_COLUMNS = [
  "id",
  "title",
  "state",
  "headline",
  '"blockedReason"',
  '"updatedAt"',
  '"mergeAuthority"',
].join(", ");

interface RawNeedsYouSummaryRow {
  id: string;
  title: string;
  state: string;
  headline: string | null;
  blockedReason: string | null;
  updatedAt: Date;
  mergeAuthority: string;
  reason: string;
}

// Stryker disable all : this metadata is a module-level literal, read into
// the registry at import — before any test body runs and never re-evaluated
// — so a mutation here is unkillable by construction, NOT untested.
// `scripts/check-operation-metadata-mutants.mjs` requires this and carries
// the full reasoning.
export const getNeedsYou = defineOperation({
  name: "get_needs_you",
  kind: "read",
  summary:
    "What needs a given person: items blocked on them, merges awaiting their approval, and plans awaiting review — in one call. Returns id, title, state, headline, why it needs them and how long it has waited; pass full for whole records.",
  // Stryker restore all
  input: inputSchema,
  async handler(ctx: ServiceContext, input: GetNeedsYouInput): Promise<GetNeedsYouOutput> {
    const columns = input.full ? ITEM_COLUMNS : NEEDS_YOU_SUMMARY_COLUMNS;
    const union = admissionSql(columns);

    // The total is counted over the same union, in the same transaction, so
    // the badge's number and this page describe one snapshot. A separate
    // `get_needs_you` call to count would be a second snapshot and could
    // legitimately disagree with the list it labels.
    const countRows = await ctx.db.$queryRawUnsafe<{ count: bigint }[]>(
      `SELECT COUNT(*)::bigint AS "count" FROM (${admissionSql("id")}) AS "needs_you"`,
      input.personId,
    );
    const total = Number(countRows[0]?.count ?? 0);

    const values: unknown[] = [input.personId];
    let paramIndex = 2;
    let cursorCondition = "";
    if (input.cursor !== undefined) {
      // Keyset pagination on `("updatedAt", "id")`, both descending — the
      // same ordering the page is sorted by, and `id` breaks ties between
      // rows touched in the same millisecond, which `updatedAt` alone
      // cannot: without it two items updated together could interleave
      // across pages or repeat depending on scan order. Mirrors
      // `list_items`' cursor exactly, differing only in the sort key,
      // because this list is ordered by waiting time rather than creation.
      //
      // A cursor naming a row that has since left the inbox (it was
      // approved) is not an error: it is looked up in `Item`
      // directly rather than in the union, so paging continues from where
      // that row *was* rather than failing. An unknown id falls through to
      // the first page, which is the same forgiving behaviour `list_items`
      // has.
      const cursorRows = await ctx.db.$queryRawUnsafe<{ updatedAt: Date | string }[]>(
        `SELECT "updatedAt" FROM "Item" WHERE "id" = $1`,
        input.cursor,
      );
      const cursorRow = cursorRows[0];
      if (cursorRow) {
        cursorCondition = `WHERE ("updatedAt", "id") < ($${paramIndex}::timestamptz, $${paramIndex + 1})`;
        values.push(cursorRow.updatedAt, input.cursor);
        paramIndex += 2;
      }
    }

    // Fetch one extra row to know whether a further page exists without a
    // separate COUNT query — the same trick `list_items` uses.
    values.push(input.limit + 1);
    // Oldest-waiting first is the inbox's whole point ("what has been
    // waiting on me longest"), so `updatedAt` ascending would seem right —
    // but the list is ordered **newest-updated first** here to match every
    // other read in the product, and `sortByWaiting` on the client puts the
    // longest wait at the top of what it is given. Ordering here exists to
    // make the *cursor* well-defined, not to choose the reader's order.
    const rows = await ctx.db.$queryRawUnsafe<
      (RawNeedsYouSummaryRow | (RawItemRow & { reason: string }))[]
    >(
      `SELECT * FROM (${union}) AS "needs_you" ${cursorCondition}
       ORDER BY "updatedAt" DESC, "id" DESC
       LIMIT $${paramIndex}`,
      ...values,
    );

    const hasMore = rows.length > input.limit;
    const page = hasMore ? rows.slice(0, input.limit) : rows;
    const items = input.full
      ? (page as (RawItemRow & { reason: string })[]).map((row) => ({
          ...toItemRecord(row),
          reason: row.reason as NeedsYouReason,
        }))
      : (page as RawNeedsYouSummaryRow[]).map((row) => ({
          id: row.id,
          title: row.title,
          state: row.state,
          headline: row.headline,
          reason: row.reason as NeedsYouReason,
          blockedReason: row.blockedReason,
          updatedAt: row.updatedAt.toISOString(),
          mergeAuthority: row.mergeAuthority,
        }));

    return {
      items,
      total,
      nextCursor: hasMore ? (items[items.length - 1]?.id ?? null) : null,
    };
  },
});
