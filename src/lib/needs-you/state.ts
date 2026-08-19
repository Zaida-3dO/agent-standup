// `/needs-you`'s load lifecycle — the fetch shaping over `GET /api/items`,
// as plain functions. Split out for the same reason `@/lib/board/state.ts`
// is: this repo's harness runs `environment: "node"` with no DOM, so the
// fetch shaping and the assembly below are only directly testable outside
// a component.
//
// ── Why three reads, not one ─────────────────────────────────────────────
//
// `list_items` filters on one `state` at a time (`../service/operations/
// list-items.ts`'s own schema — `state` is a single enum, not a set), and
// the inbox's three admissions are three different states:
// `blocked` (further narrowed to a person block, client-side, because the
// operation has no `blockedOnType` filter to push that down with),
// `in_review` (further narrowed to `mergeAuthority: needs_approval`, same
// reason), and `plan_review` (admitted outright — every item at that state
// is waiting on a person's approval, no further narrowing needed). Three
// bounded reads composed here is the honest shape for a
// filter the server does not yet expose; a fourth operation built solely
// for this screen would be the kind of gold-plating the task's own brief
// asks NOT to do.
//
// `full: true` on every read, because none of `blockedOnType`,
// `blockedOnPersonId`, `mergeAuthority` or `updatedAt` — the fields this
// screen filters and sorts on — are on the slim `ItemSummaryRecord` shape.
import type { NeedsYouItem, NeedsYouReason } from "./types";
import { uiApiPath } from "@/lib/ui-proxy/path";

export type NeedsYouLoadState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "loaded"; items: readonly NeedsYouItem[] };

/** One `items` row as `GET /api/items?full=true` returns it — only the fields this screen reads. */
interface RawItem {
  readonly id: string;
  readonly title: string;
  readonly headline: string | null;
  readonly state: string;
  readonly blockedReason: string | null;
  readonly blockedOnType: string | null;
  readonly blockedOnPersonId: string | null;
  readonly mergeAuthority: string;
  readonly updatedAt: string;
}

interface ListItemsResponse {
  readonly items?: readonly RawItem[];
}

/** A single bounded state-filtered read of `GET /api/items`, full records. */
async function fetchItemsByState(
  state: string,
  fetchImpl: typeof fetch,
): Promise<readonly RawItem[]> {
  const response = await fetchImpl(
    uiApiPath(`/api/items?state=${encodeURIComponent(state)}&full=true&limit=200`),
  );
  if (!response.ok) {
    throw new Error(`Could not load what needs you (GET /api/items returned ${response.status}).`);
  }
  const body = (await response.json()) as ListItemsResponse;
  return body.items ?? [];
}

/**
 * Blocked on **this person specifically** — the schema distinction the
 * task's brief calls out by name: `blockedOnType` is `person` /
 * `external_process` / `time`, and only the first is a person's problem.
 * Mirrors `needsYou` in `@/lib/board/view.ts`'s rule exactly (same three
 * conditions), applied here to `ItemRecord` rather than `BoardItem` because
 * this screen needs `updatedAt`, which the board's slim shape does not
 * carry.
 */
function admitBlockedOnYou(row: RawItem, personId: string): boolean {
  return row.blockedOnType === "person" && row.blockedOnPersonId === personId;
}

/**
 * `needs_approval` sitting at `in_review` — a merge waiting on exactly the
 * evidence `merge.requires_authorisation` (`../service/guards/merge.ts`)
 * checks for: a person's approving review. `agent_judgement` and
 * `pre_approved` items at `in_review` are not admitted — an agent may
 * legitimately clear those on its own, so they are not genuinely waiting on
 * a person yet.
 */
function admitNeedsApproval(row: RawItem): boolean {
  return row.mergeAuthority === "needs_approval";
}

function toNeedsYouItem(row: RawItem, reason: NeedsYouReason): NeedsYouItem {
  return {
    id: row.id,
    title: row.title,
    headline: row.headline,
    state: row.state,
    reason,
    blockedReason: row.blockedReason,
    updatedAt: row.updatedAt,
    mergeAuthority: row.mergeAuthority as NeedsYouItem["mergeAuthority"],
  };
}

/**
 * The whole inbox: every item genuinely requiring `personId`, from all
 * three sources, unsorted. `sortByWaiting` (`./view.ts`) orders what this
 * returns; this function's job is only to assemble the honest set.
 *
 * The three reads go out in parallel — they are independent bounded reads
 * against different states, and serialising them would make the inbox wait
 * on the slowest of three for no benefit, the same reasoning
 * `fetchBoard`'s parallel column reads already follow.
 */
export async function fetchNeedsYou(
  personId: string | null,
  fetchImpl: typeof fetch = fetch,
): Promise<NeedsYouItem[]> {
  if (personId === null) return [];

  const [blocked, inReview, planReview] = await Promise.all([
    fetchItemsByState("blocked", fetchImpl),
    fetchItemsByState("in_review", fetchImpl),
    fetchItemsByState("plan_review", fetchImpl),
  ]);

  const items: NeedsYouItem[] = [];
  for (const row of blocked) {
    if (admitBlockedOnYou(row, personId)) items.push(toNeedsYouItem(row, "blocked_on_you"));
  }
  for (const row of inReview) {
    if (admitNeedsApproval(row)) items.push(toNeedsYouItem(row, "needs_approval"));
  }
  // Every `plan_review` item is awaiting a person's approval — no further
  // narrowing, unlike the two loops above.
  for (const row of planReview) {
    items.push(toNeedsYouItem(row, "plan_review"));
  }
  return items;
}

/** Turns a caught value into the message the error state shows. */
export function needsYouErrorMessageFrom(err: unknown): string {
  return err instanceof Error ? err.message : "Could not load what needs you.";
}
