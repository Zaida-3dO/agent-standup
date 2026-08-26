// The two numbers the sidebar puts beside a destination.
//
// **Both are fetched, neither is a constant.** A badge is a claim that
// something is waiting, so a hardcoded one is not a placeholder, it is a
// lie that looks exactly like a working feature — and the reader who
// stopped trusting the number will not start again when it becomes real.
//
// The pure half of the sidebar's data loading, split out for the reason
// `src/lib/board/state.ts` is: the harness runs `environment: "node"` with
// no DOM, so the request shaping and the counting are only directly
// testable as plain functions.
//
// **No database access, and none possible.** Both reads go through the
// HTTP adapter, each a thin shell over one `service.call`; nothing here
// imports the service layer or the database client.
import { fetchNeedsYouTotal } from "@/lib/needs-you/state";
import { fetchFeed } from "@/lib/since/state";

export interface NavCounts {
  /** Events this profile has not marked seen — the Standup badge. */
  readonly unseen: number;
  /** What needs this person — blocked on them, a merge awaiting their approval, or a plan awaiting their review. The Needs you badge. */
  readonly needsYou: number;
}

export function emptyCounts(): NavCounts {
  return { unseen: 0, needsYou: 0 };
}

/**
 * How many items need this person — the number beside the Needs-you link.
 *
 * **Reads the same operation the inbox itself reads (T24).** It used to
 * fetch the board's whole Waiting column and count the entries matching
 * `needsYou` — which was both a fetch-and-discard (a page of cards, to
 * produce one integer) and, more seriously, a *different rule*: that
 * counted only items blocked on this person, while the list behind the link
 * admits three reasons. The badge said one number and the screen showed
 * another, with nothing to explain the gap.
 *
 * `get_needs_you` returns `total` computed over the same union that
 * produces the list, in the same transaction, so the badge is now the
 * length of the list behind it **by construction** rather than by two
 * implementations staying in step. `limit: 1` because the rows are not
 * rendered here — `total` does not depend on how many come back, and asking
 * for one keeps a badge's request from pulling a page nothing draws.
 *
 * With no active profile the count is zero without a request at all:
 * nothing can need you when the app does not know who you are, and issuing
 * the read anyway would show a stranger's queue.
 */
export async function fetchNeedsYouCount(
  personId: string | null,
  fetchImpl: typeof fetch = fetch,
): Promise<number> {
  if (personId === null) return 0;
  return fetchNeedsYouTotal(personId, fetchImpl);
}

/**
 * How many events this profile has not seen.
 *
 * `unseenCount` is computed server-side over the whole ledger, so the
 * `limit: 1` is not a sample — the number does not depend on how many
 * events come back, and asking for one keeps the badge's request from
 * pulling a page of event bodies nothing renders.
 */
export async function fetchUnseenCount(
  personId: string | null,
  fetchImpl: typeof fetch = fetch,
): Promise<number> {
  const feed = await fetchFeed({ personId, limit: 1 }, fetchImpl);
  return feed.unseenCount;
}

/**
 * Both counts, fetched together.
 *
 * **A failure resolves to zero rather than rejecting**, and each side fails
 * independently. The sidebar is chrome on every page in the app: a rejected
 * badge fetch that propagated would take down navigation on a screen whose
 * own content had loaded perfectly, to report that a number is unavailable.
 * Zero renders as no badge at all (see `NavBadge`), so the failure mode is
 * a missing badge, which is honest — it is not a badge showing a wrong
 * number.
 */
export async function fetchNavCounts(
  personId: string | null,
  fetchImpl: typeof fetch = fetch,
): Promise<NavCounts> {
  const [unseen, needsYouTotal] = await Promise.all([
    fetchUnseenCount(personId, fetchImpl).catch(() => 0),
    fetchNeedsYouCount(personId, fetchImpl).catch(() => 0),
  ]);
  return { unseen, needsYou: needsYouTotal };
}

/** The count a nav entry shows, or `null` when it carries no badge. */
export function countForBadge(
  badge: "unseen" | "needsYou" | undefined,
  counts: NavCounts,
): number | null {
  if (badge === undefined) return null;
  return badge === "unseen" ? counts.unseen : counts.needsYou;
}
