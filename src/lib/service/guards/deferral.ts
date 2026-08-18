// Guard — deferral proof: a `not_done` entry that names a reason requiring a
// linked item must point at a real item whose state actually bears that
// reason out, not merely asserted to. See docs/plans/MILESTONES.md #22, #139,
// SCHEMA.md §5a, DECISIONS.md §17.
//
// SCHEMA.md §5a states the mechanism directly:
//
//   | `reason`              | Requires                                        | Rejected when                                    |
//   |-----------------------|--------------------------------------------------|---------------------------------------------------|
//   | `follow-up`           | A minted `item_id`                              | That item is actionable — not blocked, not paused |
//   | `follow-up-scheduled` | A minted `item_id` that is scheduled and a sibling | That item is closed, `someday`, `blocked`/`paused`, or a descendant of the completing item |
//   | `needs-approval`      | A minted `item_id` that is `blocked` with `blocked_on_type = person` | The linked item isn't actually blocked on someone |
//   | `descoped`            | Nothing — no work is being deferred             | —                                                  |
//
// ── Why `follow-up` alone could not express a review follow-up ──────────
//
// `follow-up` proves deferral by requiring the linked item to be NOT
// actionable: if the work were startable, nothing would be stopping you
// doing it. That is the right proof for "I could not get to this because
// something is in the way", and it must stay exactly as strict.
//
// It is the wrong proof — unsatisfiable, in fact — for the outcome
// DECISIONS.md §17 endorses as *correct*: a review returns findings that are
// real but not blocking, the change merges, and the findings become a
// **sibling** item that is open and ready to pick up. Open and ready is
// `on_deck`, which is actionable, which `follow-up` refuses. So the endorsed
// shape was the one shape that could not be recorded, and the observed
// response was to drop `not_done` entirely and write the deferral into
// `watch_for` as prose — losing the machine-readable link that `not_done`
// exists to preserve, and quietly making the record worse.
//
// `follow-up-scheduled` is the mirror obligation rather than a weaker one.
// Where `follow-up` demands the linked item be stopped, this demands it be
// genuinely **scheduled**: not closed, not parked on the someday pile, and a
// sibling rather than a descendant. The two reasons accept disjoint sets of
// linked states, so neither is a way around the other.
//
// That disjointness is necessary and not sufficient, and the distinction
// matters enough to state: what has to hold is that their UNION does not
// cover "I will get to it later". The `someday` exclusion is what buys that
// — without it, minting a row and parking it would be a costless path
// requiring no false statement anywhere. See `../summaries/validate.ts`'s
// `NOT_DONE_REASONS` for the vocabulary-level statement of the same trade,
// including what it does and does not preserve.
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

/**
 * The states in which a linked item has stopped being a commitment to do the
 * work — finished one way or another, or abandoned. `follow-up-scheduled`
 * claims the work is *scheduled*, so pointing it at one of these is the one
 * thing that claim cannot survive: nothing is queued.
 *
 * Deliberately the same set, and the same reasoning, as
 * `guards/merge.ts`'s `CLOSED_ITEM_STATES` for `lgtm_with_followups` — the
 * two rules are the same rule seen from the summary side and the artifact
 * side, and letting them drift would mean a follow-up that satisfies the
 * merge gate is refused by the summary, or the reverse.
 */
const CLOSED_ITEM_STATES = new Set(["merged", "research_done", "wont_do", "cancelled"]);

/**
 * The states in which a linked item is not **scheduled** — the claim
 * `follow-up-scheduled` actually makes, as against merely existing.
 *
 * `someday` is the whole reason this set exists, and the reason is semantic
 * rather than procedural. `someday` is the one state whose meaning is
 * literally *"not scheduled"*, so accepting it would make this reason's own
 * name false and let *"I will get to it"* complete cleanly — the class
 * SCHEMA.md §5a exists to keep unsayable. Refusing it forces the closer to
 * make a positive claim about the work being real and queued, which is a
 * claim someone can disagree with.
 *
 * **The honest limit of this, stated because overstating it would be worse
 * than the gap.** The remaining accepted states are `on_deck`, `planning`,
 * `plan_review`, `executing` and `in_review`, and a freshly minted item lands
 * in `on_deck` with no extra step — so the price is a positive assertion, not
 * a laborious one, and `someday` and `on_deck` both render in the same board
 * column. This is a weaker cost than the one `follow-up` charges, where a
 * false `blocked` needs a reason and a `blocked_on_type` and lands the item
 * on somebody's needs-you list. It is not nothing — a determined evader has
 * to state that unscheduled work is scheduled, in a permanent record, rather
 * than merely selecting the state that says otherwise — but a design that
 * claimed parity here would be claiming more than it delivers.
 *
 * Also excluded are the two states that say the work is stopped. They are
 * `follow-up`'s territory — a linked item that is `blocked` or `paused` is
 * evidence for that reason and refutes this one — so leaving them out is what
 * keeps the two reasons from becoming interchangeable, each usable whenever
 * the other's proof happens to be at hand.
 */
const UNSCHEDULED_ITEM_STATES = new Set(["someday", "blocked", "paused"]);

interface LinkedItemRow {
  id: string;
  state: string;
  blockedOnType: string | null;
  parentId: string | null;
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
 * Entries this guard has anything to say about — every reason SCHEMA.md §5a
 * requires a minted `item_id` for. `descoped` needs nothing and an unlisted
 * reason is already `validateSummaryShape`'s rejection to raise, not this
 * guard's — so both are left alone here, and only these reasons are
 * dereferenced against the database at all.
 */
const REASONS_REQUIRING_ITEM: ReadonlySet<string> = new Set([
  "follow-up",
  "follow-up-scheduled",
  "needs-approval",
]);

/**
 * Whether `candidateId` sits anywhere in the subtree rooted at
 * `ancestorId` — walking up from the candidate rather than down from the
 * ancestor, because the upward path is bounded by `items.max_depth` while
 * the downward one is bounded only by how many children the item has.
 *
 * Written here rather than reusing `items/reparent-core.ts`'s `subtreeOf`
 * or `depthOf`: those take a `ServiceContext`, and a guard is handed only a
 * `TransactionHandle` (`state-machine/guard.ts`) so that every read it makes
 * is inside the transition's own transaction. Reaching for a
 * `ServiceContext` here would mean reading outside it, which is the one
 * thing that would let this guard decide on a row the transition is about
 * to change.
 *
 * `WHERE "id" <> $2` on the seed excludes the trivial case where the two
 * ids are equal: an item is not its own descendant, and an entry that links
 * an item to itself is a different mistake (`hierarchy`'s own concern), not
 * a misparented follow-up.
 */
async function isDescendantOf(
  db: GuardInput["db"],
  candidateId: string,
  ancestorId: string,
): Promise<boolean> {
  if (candidateId === ancestorId) return false;
  const rows = await db.$queryRawUnsafe<{ id: string }[]>(
    // The same recursive-ancestors shape `items/create-core.ts`'s
    // `ancestorDepthOf` uses, narrowed to a single membership question so
    // the walk stops at the first hit rather than materialising the path.
    `WITH RECURSIVE ancestors AS (
       SELECT "id", "parentId" FROM "Item" WHERE "id" = $1
       UNION ALL
       SELECT i."id", i."parentId"
       FROM "Item" i JOIN ancestors a ON i."id" = a."parentId"
     )
     SELECT "id" FROM ancestors WHERE "id" = $2 AND "id" <> $1 LIMIT 1`,
    candidateId,
    ancestorId,
  );
  return rows.length > 0;
}

/** One entry's failure to prove its reason — the shape both callers below turn into their own error type. */
export interface NotDoneProofIssue {
  /** The `not_done[i].item_id`-style path of the entry at fault. */
  readonly field: string;
  readonly message: string;
}

/**
 * SCHEMA.md §5a's per-entry proof, over every entry in one `not_done` array.
 *
 * **Exported because this rule has exactly two callers and must not have two
 * implementations.** `complete_item` runs it up front so a caller gets every
 * problem in one rejection round rather than one guard-rejection at a time,
 * and `deferralFollowUpGuard` runs it inside the transition, where it is what
 * actually gates. Those are different jobs — a better error, and the
 * enforcement — but they are not different *rules*, and when they were written
 * separately they drifted: one treated a `merged` linked item as acceptable
 * proof of a `follow-up` and the other did not, so the same summary was
 * accepted or refused depending on which entry point saw it first. One
 * function, two callers, no way for them to disagree.
 *
 * Returns every issue it finds rather than stopping at the first, for the same
 * reason `complete_item` batches its validators: `not_done` is capped at 5
 * entries (SCHEMA.md §5, `NOT_DONE_MAX`), so reporting all of them costs at
 * most five bounded reads and saves the caller a round trip per mistake.
 */
export async function findNotDoneProofIssues(
  db: GuardInput["db"],
  completingItemId: string,
  entries: readonly NotDoneEntry[],
): Promise<NotDoneProofIssue[]> {
  const issues: NotDoneProofIssue[] = [];

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];
    if (!entry) continue;
    const reason = entry.reason;
    if (!REASONS_REQUIRING_ITEM.has(reason)) continue; // descoped, or an unlisted reason — not this guard's concern

    const field = `not_done[${i}].item_id`;
    const itemId = entry.item_id;
    if (typeof itemId !== "string" || itemId.trim().length === 0) {
      issues.push({
        field,
        message: `not_done[${i}] is reasoned "${reason}", which requires a minted item_id — none was supplied.`,
      });
      continue;
    }

    // Checked one entry at a time, awaited in sequence — each issue must
    // identify which specific not_done entry failed, so this is deliberately
    // not batched into one IN() query that would blur that back together.
    // `not_done` is capped at 5 entries, so the round trips are bounded.
    const rows = await db.$queryRawUnsafe<LinkedItemRow[]>(
      `SELECT "id", "state", "blockedOnType", "parentId" FROM "Item" WHERE "id" = $1`,
      itemId,
    );
    const linked = rows[0];

    if (!linked) {
      issues.push({
        field,
        message: `not_done[${i}] names item_id "${itemId}", but no such item exists.`,
      });
      continue;
    }

    if (reason === "follow-up") {
      if (!NON_ACTIONABLE_STATES.has(linked.state)) {
        issues.push({
          field,
          message:
            `You're deferring this, but nothing is blocking it. not_done[${i}]'s follow-up ` +
            `(${itemId}) is "${linked.state}" — not blocked and not paused. If something is ` +
            'genuinely in the way, put that item in "blocked" or "paused" and say what is ' +
            "stopping it. If instead this is separate work you have already committed to as " +
            'its own queue row, that is a different claim: use reason "follow-up-scheduled", ' +
            "which asks for a live sibling rather than a blocked one. If neither is true, " +
            "finish the work rather than recording it as not done.",
        });
      }
    } else if (reason === "follow-up-scheduled") {
      // Claim: this work is scheduled, not stuck. Two things have to hold,
      // and they are checked separately because they fail for different
      // reasons and need different fixes.
      //
      // 1. It is still open. A closed item carries nothing forward, so
      //    pointing at one would satisfy the letter of "there is a row for
      //    it" while the work it names has already stopped existing as a
      //    commitment.
      if (CLOSED_ITEM_STATES.has(linked.state)) {
        issues.push({
          field,
          message:
            `not_done[${i}] is reasoned "follow-up-scheduled", which claims the work is queued ` +
            `as its own item — but item "${itemId}" is already "${linked.state}". A closed ` +
            "item is not a schedule. Link one that is still open, or say what actually " +
            "happened to this work.",
        });
        continue;
      }

      // Open is not the same as scheduled, and this reason claims the
      // stronger of the two. See `UNSCHEDULED_ITEM_STATES` for why the price
      // has to be real: a row parked on the someday pile would let "I ran out
      // of time" complete cleanly, which is the one thing §5a exists to stop.
      if (UNSCHEDULED_ITEM_STATES.has(linked.state)) {
        issues.push({
          field,
          message:
            `not_done[${i}] is reasoned "follow-up-scheduled", which says this work is committed ` +
            `to as its own queue row — but item "${itemId}" is "${linked.state}", which is not ` +
            "scheduled. Put it somewhere it will actually be picked up, or, if something is " +
            'genuinely stopping it, record it as "follow-up" instead and say what the blocker is.',
        });
        continue;
      }

      // 2. It is a sibling, not a descendant — DECISIONS.md §17's rule,
      //    enforced rather than advised. A descendant is precisely the shape
      //    that deadlocks: `hierarchy.no_finish_with_actionable_child`
      //    refuses to let a parent finish while an actionable child is open,
      //    so an item recorded this way would be refused by that guard in
      //    the same call. Catching it here names the real mistake — the
      //    follow-up is parented under the work instead of beside it —
      //    rather than leaving the caller to infer it from a hierarchy
      //    rejection that never mentions `not_done`.
      if (await isDescendantOf(db, linked.id, completingItemId)) {
        issues.push({
          field,
          message:
            `not_done[${i}] links follow-up "${itemId}", which sits underneath this item in the ` +
            "tree. A follow-up belongs beside the work, not inside it: parenting it here says " +
            "this item is not finished without it, which contradicts completing it now — and " +
            "an open descendant blocks this completion on its own. Move it to the same parent " +
            "as this item.",
        });
      }
    } else {
      // reason === "needs-approval"
      if (linked.state !== "blocked" || linked.blockedOnType !== "person") {
        issues.push({
          field,
          message:
            `not_done[${i}] is reasoned "needs-approval", but item_id "${itemId}" isn't actually ` +
            "blocked on someone — it must be blocked with blocked_on_type=person.",
        });
      }
    }
  }

  return issues;
}

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
 *
 * Reports only the **first** issue, where `findNotDoneProofIssues` collects
 * them all: a `GuardRejected` carries one message, and this guard's job is to
 * stop the transition rather than to itemise everything wrong with the
 * submission. `complete_item` is the path that shows the caller all of them at
 * once, which is why it calls the shared function directly.
 */
export const deferralFollowUpGuard: Guard = {
  id: "deferral.follow_up_must_be_blocked",
  description:
    "A not_done entry whose reason requires a linked item must name a real item whose state bears " +
    "that reason out: blocked or paused for 'follow-up', open and a sibling for " +
    "'follow-up-scheduled', blocked on a person for 'needs-approval' (SCHEMA.md §5a).",
  appliesTo: (_from, to) => COMPLETED_STATES.has(to),
  async check(input: GuardInput) {
    const issues = await findNotDoneProofIssues(input.db, input.item.id, readNotDone(input.fields));
    const first = issues[0];
    if (first) {
      return guardRejected(first.message, { fields: [first.field] });
    }
    return guardOk;
  },
};

/** `deferralFollowUpGuard.id`, named for callers that want the id without importing the guard object. */
export const DEFERRAL_FOLLOW_UP_GUARD_ID = deferralFollowUpGuard.id;

/** Every reason this guard recognises as requiring a linked item — re-exported so a test can assert this stays a subset of `NOT_DONE_REASONS` (`../summaries/validate.ts`, the one place the closed set is declared). */
export const DEFERRAL_REASONS_REQUIRING_ITEM = REASONS_REQUIRING_ITEM;
