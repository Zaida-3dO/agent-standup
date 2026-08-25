// `/needs-you`'s load lifecycle — the fetch shaping over
// `GET /api/needs-you`, as plain functions. Split out for the same reason
// `@/lib/board/state.ts` is: this repo's harness runs `environment: "node"`
// with no DOM, so the fetch shaping and the assembly below are only
// directly testable outside a component.
//
// ── One read, not three (T24) ────────────────────────────────────────────
//
// This screen used to issue **three** `GET /api/items?state=…&full=true`
// calls — `blocked`, `in_review`, `plan_review` — and narrow each one in the
// browser, because `list_items` filters a single state at a time and has no
// `blockedOnType`, `blockedOnPersonId` or `mergeAuthority` filter to push
// the narrowing down with. It therefore fetched up to 200 **full** records
// per state to render a handful of one-line rows, and the rule deciding
// which rows those were lived here, in the front end.
//
// `get_needs_you` is that rule, server-side, in one call: the union of the
// three admissions, each row labelled with the `reason` it was admitted
// under, in one transaction. Three consequences worth naming:
//
//   - **The three sources agree.** They were three independent snapshots
//     before, so an item transitioning mid-load could appear twice or
//     vanish from both halves.
//   - **The sidebar badge cannot drift from this list.** Both now read the
//     same operation — see `@/lib/nav/counts.ts`.
//   - **Nothing is fetched and discarded.** The response is the admitted
//     set, in the slim shape, carrying exactly the fields a row draws.
//
// The screen is still a single page of the inbox: `get_needs_you` is paged
// (`limit`/`cursor`) and this asks for one bounded page, which is what an
// inbox is. `total` says how many there are in all, so a page that does not
// show everything can say so rather than imply completeness.
import type { NeedsYouItem, NeedsYouReason } from "./types";
import { uiApiPath } from "@/lib/ui-proxy/path";

export type NeedsYouLoadState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "loaded"; items: readonly NeedsYouItem[]; total: number };

/** One row as `GET /api/needs-you` returns it in the slim shape — every field this screen draws. */
interface RawNeedsYouRow {
  readonly id: string;
  readonly title: string;
  readonly headline: string | null;
  readonly state: string;
  readonly reason: string;
  readonly blockedReason: string | null;
  readonly updatedAt: string;
  readonly mergeAuthority: string;
}

interface NeedsYouResponse {
  readonly items?: readonly RawNeedsYouRow[];
  readonly total?: number;
}

/**
 * How many rows one load of the inbox asks for.
 *
 * Bounded rather than unbounded for the reason every read in this product
 * is: an inbox is a screen, and a person with four hundred things waiting
 * on them is not helped by receiving all four hundred at once. `total`
 * still reports the true count, so the screen can say what it is not
 * showing instead of quietly showing less.
 */
export const NEEDS_YOU_PAGE_SIZE = 50;

/**
 * The whole inbox for `personId`, in one read, unsorted — `sortByWaiting`
 * (`./view.ts`) orders what this returns.
 *
 * Returns nothing at all, without issuing a request, when there is no
 * active profile: nothing can need you when the app does not know who you
 * are, and issuing the read anyway would show a stranger's queue. (The
 * operation requires `personId` and would refuse, but not making the call
 * is the honest expression of "there is no question to ask yet".)
 */
export async function fetchNeedsYou(
  personId: string | null,
  fetchImpl: typeof fetch = fetch,
): Promise<{ items: NeedsYouItem[]; total: number }> {
  if (personId === null) return { items: [], total: 0 };

  const response = await fetchImpl(
    uiApiPath(
      `/api/needs-you?personId=${encodeURIComponent(personId)}&limit=${NEEDS_YOU_PAGE_SIZE}`,
    ),
  );
  if (!response.ok) {
    throw new Error(
      `Could not load what needs you (GET /api/needs-you returned ${response.status}).`,
    );
  }
  const body = (await response.json()) as NeedsYouResponse;
  const rows = body.items ?? [];
  return {
    items: rows.map(toNeedsYouItem),
    // Falls back to the page's own length rather than 0 when the field is
    // absent, so a response missing it under-reports nothing — a count of 0
    // beside a visibly non-empty list is the one reading that is certainly
    // wrong.
    total: body.total ?? rows.length,
  };
}

/**
 * One wire row as the screen's own type.
 *
 * The `reason` is taken as the server sent it, not re-derived: the whole
 * point of `get_needs_you` is that the admission rule has one definition,
 * and a client recomputing the label here would put a second one back.
 */
function toNeedsYouItem(row: RawNeedsYouRow): NeedsYouItem {
  return {
    id: row.id,
    title: row.title,
    headline: row.headline,
    state: row.state,
    reason: row.reason as NeedsYouReason,
    blockedReason: row.blockedReason,
    updatedAt: row.updatedAt,
    mergeAuthority: row.mergeAuthority as NeedsYouItem["mergeAuthority"],
  };
}

/**
 * Just the count — how many items need this person, ignoring the page.
 *
 * The sidebar badge's read (`@/lib/nav/counts.ts`). `limit: 1` because the
 * rows are not rendered: `total` is computed server-side over the whole
 * union, so the number does not depend on how many rows come back, and
 * asking for one row keeps a badge's request from pulling a page nothing
 * draws. Asking for zero is not an option the operation offers (`limit` is
 * `min(1)`), and a dedicated count-only read would be a second definition
 * of the same rule for one integer.
 */
export async function fetchNeedsYouTotal(
  personId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<number> {
  const response = await fetchImpl(
    uiApiPath(`/api/needs-you?personId=${encodeURIComponent(personId)}&limit=1`),
  );
  if (!response.ok) {
    throw new Error(
      `Could not load what needs you (GET /api/needs-you returned ${response.status}).`,
    );
  }
  const body = (await response.json()) as NeedsYouResponse;
  return body.total ?? 0;
}

/** Turns a caught value into the message the error state shows. */
export function needsYouErrorMessageFrom(err: unknown): string {
  return err instanceof Error ? err.message : "Could not load what needs you.";
}
