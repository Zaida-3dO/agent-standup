// The item-detail view's load lifecycle — the pure half of the client
// container, split out for the same reason `src/lib/board/state.ts` is:
// this repo's harness runs `environment: "node"` with no DOM, so the fetch
// shaping and the loading/error/loaded branching are only directly testable
// as plain functions. The client component is thin wiring over these.
import type { ItemDetail } from "./types";

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
  const response = await fetchImpl(`/api/items/${encodeURIComponent(id)}/detail`);
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
