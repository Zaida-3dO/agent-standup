// Guard — deferral proof: a `not_done` entry that names a `follow-up` or
// `needs-approval` reason must point at a real item that is genuinely
// blocked (or paused, for `follow-up`), not merely asserted to be. See
// docs/plans/MILESTONES.md #22, SCHEMA.md §5a.
//
// SCHEMA.md §5a states the mechanism directly:
//
//   | `reason`         | Requires                                        | Rejected when                                    |
//   |-------------------|--------------------------------------------------|---------------------------------------------------|
//   | `follow-up`       | A minted `item_id`                              | That item is actionable — not blocked, not paused |
//   | `needs-approval`  | A minted `item_id` that is `blocked` with `blocked_on_type = person` | The linked item isn't actually blocked on someone |
//   | `descoped`        | Nothing — no work is being deferred             | —                                                  |
//
// Row #21's `validateSummaryShape` (`../summaries/validate.ts`) already
// enforces the closed set of `reason` values (`NOT_DONE_REASONS`) and
// refuses anything else — that is AC1's "typed reasons" half, already
// shipped. What that pure, synchronous validator *cannot* do is check that
// a linked `item_id` genuinely exists in the state SCHEMA.md §5a demands:
// it has no database access (its own header: "needs nothing from the
// database"). This guard is the other half — the part of "prove it's
// actually blocked" that can only be answered by reading the linked row.
//
// **The obvious way to game this self-surfaces** (SCHEMA.md §5a's own
// framing): an agent could mark the follow-up `blocked` to satisfy this
// guard's `follow-up` check — but `blocked` demands `blocked_reason` and
// `blocked_on_type` (row #16's guard), and if the type is `person` the item
// lands on that person's needs-you list. A false block makes the deferred
// work MORE visible, not less. This guard does not need to detect gaming;
// the mechanism it is built on top of already converts gaming into
// visibility.
import { guardOk, guardRejected, type Guard, type GuardInput } from "../state-machine/guard";
import type { NotDoneEntry } from "../summaries/validate";

/** The four completed states (SCHEMA.md §1.1's "Completed" column). Matches `summaries.ts`'s own set. */
const COMPLETED_STATES = new Set(["merged", "research_done", "wont_do", "cancelled"]);

/** States SCHEMA.md §5a's `follow-up` row calls "not actionable" — a linked item may sit in either without being rejected. */
const NON_ACTIONABLE_STATES = new Set(["blocked", "paused"]);

interface LinkedItemRow {
  id: string;
  state: string;
  blockedOnType: string | null;
}

/**
 * Reads `fields.summary.not_done` as a `NotDoneEntry[]`, or `[]` if the
 * field is missing or not shaped like an array. Mirrors `summaries.ts`'s
 * `readCandidate` posture: an absent or malformed summary is not this
 * guard's rejection to raise — `summaryRequiredGuard` already owns "a
 * summary is required at all" and "each `not_done` entry has a recognised
 * reason". This guard only ever has something to say about an entry that
 * already parses as one of the three typed reasons.
 */
function readNotDone(fields: Readonly<Record<string, unknown>>): NotDoneEntry[] {
  const raw = fields.summary;
  if (raw === null || raw === undefined || typeof raw !== "object") return [];
  const notDone = (raw as Record<string, unknown>).not_done;
  return Array.isArray(notDone) ? (notDone as NotDoneEntry[]) : [];
}

/**
 * Entries this guard has anything to say about — `reason` is `follow-up` or
 * `needs-approval`, which SCHEMA.md §5a requires a minted `item_id` for.
 * `descoped` needs nothing and an unlisted reason is already
 * `validateSummaryShape`'s rejection to raise, not this guard's — so both
 * are left alone here, and only these two reasons are dereferenced against
 * the database at all.
 */
const REASONS_REQUIRING_ITEM: ReadonlySet<string> = new Set(["follow-up", "needs-approval"]);

/**
 * Registered as `deferral.follow_up_must_be_blocked`.
 *
 * `appliesTo` fires on entering any completed state — the same trigger
 * `summaryRequiredGuard` uses, because a `not_done` entry only exists inside
 * a `summaries` row, which is only ever submitted alongside that same
 * transition (SCHEMA.md §5, "1:1 with an item. Required to enter any
 * `completed` state.").
 *
 * Runs entirely inside `input.db` — the same transaction handle every other
 * guard in this directory reads through — so a linked item created earlier
 * in the same call (however unlikely that ordering is in practice) is still
 * visible, and this guard never opens a second connection.
 */
export const deferralFollowUpGuard: Guard = {
  id: "deferral.follow_up_must_be_blocked",
  description:
    "A not_done entry reasoned 'follow-up' or 'needs-approval' must name a real item that is " +
    "genuinely blocked (or paused, for follow-up) — not merely asserted to be (SCHEMA.md §5a).",
  appliesTo: (_from, to) => COMPLETED_STATES.has(to),
  async check(input: GuardInput) {
    const entries = readNotDone(input.fields);

    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      if (!entry) continue;
      const reason = entry.reason;
      if (!REASONS_REQUIRING_ITEM.has(reason)) continue; // descoped, or an unlisted reason — not this guard's concern

      const itemId = entry.item_id;
      if (typeof itemId !== "string" || itemId.trim().length === 0) {
        return guardRejected(
          `not_done[${i}] is reasoned "${reason}", which requires a minted item_id — none was supplied.`,
          { fields: [`not_done[${i}].item_id`] },
        );
      }

      // Checked one entry at a time, awaited in sequence — each rejection
      // must identify which specific not_done entry failed, so this is
      // deliberately not batched into one IN() query that would blur that
      // back together. `not_done` is capped at 5 entries (SCHEMA.md §5,
      // NOT_DONE_MAX), so the sequential round trips are bounded.
      const rows = await input.db.$queryRawUnsafe<LinkedItemRow[]>(
        `SELECT "id", "state", "blockedOnType" FROM "Item" WHERE "id" = $1`,
        itemId,
      );
      const linked = rows[0];

      if (!linked) {
        return guardRejected(`not_done[${i}] names item_id "${itemId}", but no such item exists.`, {
          fields: [`not_done[${i}].item_id`],
        });
      }

      if (reason === "follow-up") {
        if (!NON_ACTIONABLE_STATES.has(linked.state)) {
          return guardRejected(
            `You're deferring this, but nothing is blocking it. not_done[${i}]'s follow-up ` +
              `(${itemId}) is "${linked.state}" — not blocked and not paused. Is there a good ` +
              "reason you didn't just do it now? If not, go back to executing and finish it.",
            { fields: [`not_done[${i}].item_id`] },
          );
        }
      } else {
        // reason === "needs-approval"
        if (linked.state !== "blocked" || linked.blockedOnType !== "person") {
          return guardRejected(
            `not_done[${i}] is reasoned "needs-approval", but item_id "${itemId}" isn't actually ` +
              "blocked on someone — it must be blocked with blocked_on_type=person.",
            { fields: [`not_done[${i}].item_id`] },
          );
        }
      }
    }

    return guardOk;
  },
};

/** `deferralFollowUpGuard.id`, named for callers that want the id without importing the guard object. */
export const DEFERRAL_FOLLOW_UP_GUARD_ID = deferralFollowUpGuard.id;

/** Every reason this guard recognises as requiring a linked item — re-exported so a test can assert this stays a subset of `NOT_DONE_REASONS` (`../summaries/validate.ts`, the one place the closed set is declared). */
export const DEFERRAL_REASONS_REQUIRING_ITEM = REASONS_REQUIRING_ITEM;
