// Guard: entering `in_review` requires a review to actually have been
// requested. See docs/plans/MILESTONES.md #17, SCHEMA.md §16
// ("`in-review` | ≥1 `artifacts` row of kind `review-requested`.").
//
// **Reads `SCHEMA.md` §16's literal wording as an artifact lookup, and it
// is not one.** `artifacts.kind` (§6, and `ArtifactKind` in schema.prisma)
// has no `review-requested` value — `plan · plan-review · code-review ·
// visual-review · test-run · commit · screenshot · other` is the whole set.
// `review-requested` exists exactly once in this schema: as an **event
// type** (§3's `events.type` enum, `EventType.review_requested` in
// schema.prisma, already modelled by row #20's `src/lib/events.ts`), with
// payload `{round}`. The two enums drifted apart from one prose sentence in
// §16 that still describes the pre-split shape — the same kind of lag the
// state-machine test file already documents for "eleven states" vs the
// twelve the schema actually enforces. Requesting a review is an act, not a
// deliverable: the deliverable a reviewer eventually produces (the review
// itself, with a verdict) is what lands in `artifacts` as `code_review` /
// `plan_review` / `visual_review` — see review-approval-at-tip.ts, which is
// exactly that artifact-side check. This guard enforces the request half:
// an `Event` row of type `review_requested` for the item.
import type { Guard, GuardInput } from "../state-machine/guard";
import { guardOk, guardRejected } from "../state-machine/guard";
import type { TransactionHandle } from "../context";

interface CountRow {
  count: bigint;
}

async function hasReviewRequested(db: TransactionHandle, itemId: string): Promise<boolean> {
  const rows = await db.$queryRawUnsafe<CountRow[]>(
    `SELECT count(*)::bigint AS count
       FROM "Event"
      WHERE "itemId" = $1 AND "type" = 'review_requested'`,
    itemId,
  );
  return (rows[0]?.count ?? 0n) > 0n;
}

/**
 * `appliesTo` is **entering** `in_review` regardless of where the move
 * started, matching SCHEMA.md §16's "Entering" column literally — this is a
 * required-field check, not a check on the specific pair.
 */
export const reviewRequestedGuard: Guard = {
  id: "artifact.review_requested",
  description: "Entering in_review requires a review_requested event to have been recorded.",
  appliesTo: (_from, to) => to === "in_review",
  async check(input: GuardInput) {
    const ok = await hasReviewRequested(input.db, input.item.id);
    if (!ok) {
      return guardRejected(
        "No review has been requested yet — record a review_requested event before moving to in_review.",
        { fields: ["state"] },
      );
    }
    return guardOk;
  },
};
