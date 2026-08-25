// The item-detail view's load lifecycle — the pure half of the client
// container, split out for the same reason `src/lib/board/state.ts` is:
// this repo's harness runs `environment: "node"` with no DOM, so the fetch
// shaping and the loading/error/loaded branching are only directly testable
// as plain functions. The client component is thin wiring over these.
import type { DetailHistoryEntry, ItemDetail } from "./types";
import { uiApiPath } from "@/lib/ui-proxy/path";

export type DetailLoadState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "loaded"; detail: ItemDetail };

/**
 * One item's detail from `GET /api/items/{id}/detail`. Throws a message fit
 * to show directly — never a raw `Response` or a JSON-parse error, matching
 * `fetchBoard`.
 *
 * **A missing collection is filled in, not trusted.** The server always
 * returns all of them, but a component that maps over `detail.subtasks` on
 * a response missing it would crash on `undefined.map`. Defaulting each to
 * empty makes a partial response render as an empty section instead of a
 * blank page — the same reasoning `fetchBoard` gives for merging over
 * `emptyBoard()`.
 */
export async function fetchItemDetail(
  id: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ItemDetail> {
  const response = await fetchImpl(uiApiPath(`/api/items/${encodeURIComponent(id)}/detail`));
  if (!response.ok) {
    if (response.status === 404) {
      throw new Error(`No such item: ${id}.`);
    }
    throw new Error(
      `Could not load this item (GET /api/items/${id}/detail returned ${response.status}).`,
    );
  }
  const body = (await response.json()) as { detail?: Partial<ItemDetail> };
  const detail = body.detail ?? {};
  if (!detail.item) {
    throw new Error(`Could not load this item (the response carried no item).`);
  }
  return {
    item: detail.item,
    column: detail.column ?? "backlog",
    subtasks: detail.subtasks ?? [],
    artifacts: detail.artifacts ?? [],
    history: detail.history ?? [],
    historyTruncated: detail.historyTruncated ?? false,
    summary: detail.summary ?? null,
    assignments: detail.assignments ?? [],
    previousHolders: detail.previousHolders ?? [],
  };
}

/** Turns a caught value into the message the error state shows — never a raw, possibly-unhelpful object. */
export function detailErrorMessageFrom(err: unknown): string {
  return err instanceof Error ? err.message : "Could not load this item.";
}

// ── Paged history (T24) ──────────────────────────────────────────────────
//
// The Activity tab used to page **in the browser**: `get_item_detail`
// returns history under a cap with no cursor, so the 25-a-page control was
// slicing an array the page already held, and an item with more entries
// than the cap simply could not show its older ones. `get_item_history` is
// the server-side read that fixes that; see its own header for why it is a
// separate operation with a per-page snapshot rather than an offset
// threaded through the detail payload.
//
// Page one still comes from the detail response — it arrives inside the
// whole-screen snapshot, which is the paint most worth keeping coherent —
// so this is only called when a reader moves *past* it.

/** One page of an item's history, as `GET /api/items/{id}/history` returns it. */
export interface HistoryPage {
  readonly entries: readonly DetailHistoryEntry[];
  /** How many entries the ledger holds in all — what makes "page 3 of 40" sayable. */
  readonly total: number;
  /** Pass back as `cursor` for the next page. Null when this page is the last. */
  readonly nextCursor: string | null;
}

/**
 * One page of history, newest first, starting after `cursor`.
 *
 * Asks for the **slim** shape: the timeline renders a type, a timestamp, an
 * actor and a headline, and `payload`/`body` are ~95% of an event's size.
 * Fetching them to not render them is exactly the fetching-and-discarding
 * this change removes.
 *
 * Throws a message fit to show directly, matching `fetchItemDetail`.
 */
export async function fetchItemHistory(
  id: string,
  options: { readonly cursor?: string; readonly limit?: number } = {},
  fetchImpl: typeof fetch = fetch,
): Promise<HistoryPage> {
  const params = new URLSearchParams();
  if (options.limit !== undefined) params.set("limit", String(options.limit));
  if (options.cursor !== undefined) params.set("cursor", options.cursor);
  const query = params.toString();
  const response = await fetchImpl(
    uiApiPath(`/api/items/${encodeURIComponent(id)}/history${query === "" ? "" : `?${query}`}`),
  );
  if (!response.ok) {
    throw new Error(
      `Could not load this item's history (GET /api/items/${id}/history returned ${response.status}).`,
    );
  }
  const body = (await response.json()) as Partial<HistoryPage>;
  return {
    entries: body.entries ?? [],
    total: body.total ?? 0,
    // Normalised to null rather than left `undefined`, so "there is no next
    // page" has one representation the caller can test with `=== null`.
    nextCursor: body.nextCursor ?? null,
  };
}
