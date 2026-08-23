// Asking the server to move an item — MILESTONES.md #73's other half.
//
// Split from `drag.ts` for the same reason `state.ts` is split from
// `view.ts`: this is the part that talks to the network, and keeping it a
// plain function taking a `fetch` makes it directly testable with a stub,
// with no DOM and no server.
//
// **The result is a discriminated union, not a thrown error.** A refusal is
// an ordinary outcome here — the state machine is real and guards refuse
// moves as a matter of course — so the caller has to handle it on the
// normal path rather than in a catch block. Modelling it as an exception
// would make the *expected* case the exceptional one, and a caller that
// forgot the catch would leave a card showing a move the server rejected.
import type { BoardColumnId, BoardEntry, BoardItem } from "./types";
import { TARGET_STATE, networkRefusalMessage, refusalMessage } from "./drag";
import { uiApiPath } from "@/lib/ui-proxy/path";

export type MoveResult =
  | { readonly ok: true; readonly entry: BoardEntry }
  | { readonly ok: false; readonly message: string };

/** The error envelope every items route answers with (`src/app/api/items/respond.ts`). */
interface ErrorBody {
  readonly error?: { readonly message?: unknown };
}

/** The successful transition body — `{ item, outcome }` from `transition_item`. */
interface TransitionBody {
  readonly item?: BoardItem;
}

/**
 * Move one item into a column, by transitioning it to that column's state.
 *
 * Returns the entry the board should settle on, built from **the server's**
 * item and the column asked for — not from the optimistic guess. If a guard
 * ever lands the item somewhere other than the requested state, the item it
 * returns says so, and the card reconciles to that.
 */
export async function requestMove(
  itemId: string,
  column: BoardColumnId,
  fetchImpl: typeof fetch = fetch,
): Promise<MoveResult> {
  const to = TARGET_STATE[column];
  if (to === null) {
    // A column with no reachable target state (Waiting — see
    // `TARGET_STATE`). The drop should never have got this far, so refusing
    // here rather than sending `to: null` keeps a wiring mistake from
    // reaching the server as a malformed request.
    return { ok: false, message: "That column cannot be reached by dragging." };
  }

  let response: Response;
  try {
    response = await fetchImpl(uiApiPath(`/api/items/${encodeURIComponent(itemId)}/transition`), {
      method: "POST",
      headers: { "content-type": "application/json" },
      // `full: true` on purpose. A successful write returns the slim shape
      // by default (MILESTONES.md #107, carried to the writes), and slim is
      // `{id, title, state, headline, updatedAt}` — but the card this
      // reconciles to is a `BoardItem`, which also draws `kind`, `priority`,
      // `area`, `repo` and the blocked/paused fields. Settling a card on
      // the slim shape would blank all of those until the next board read.
      // This is the caller the `full` flag exists for.
      body: JSON.stringify({ to, full: true }),
    });
  } catch {
    // The request never reached the server — a refusal all the same, and
    // the card still has to go back.
    return { ok: false, message: networkRefusalMessage() };
  }

  if (!response.ok) {
    // A guard's own rejection text names the field it wants, so it is worth
    // far more than anything invented here. A body that cannot be read at
    // all falls back to the status.
    let serverMessage: string | null = null;
    try {
      const body = (await response.json()) as ErrorBody;
      const message = body.error?.message;
      if (typeof message === "string") serverMessage = message;
    } catch {
      serverMessage = null;
    }
    return { ok: false, message: refusalMessage(response.status, serverMessage) };
  }

  let item: BoardItem | undefined;
  try {
    item = ((await response.json()) as TransitionBody).item;
  } catch {
    item = undefined;
  }
  if (!item) {
    // A 200 with no item is not something to celebrate: the board has
    // nothing truthful to settle on, so treat it as a refusal and put the
    // card back rather than leaving the guess in place.
    return { ok: false, message: "That move could not be confirmed." };
  }

  // No assignments, no trust: the transition response carries the item, not
  // its ownership or its verification history, and a settled card re-renders
  // from the next board read. An empty array/`null` are the honest values
  // for "this response did not say" — the same reason the API never omits
  // either key.
  return { ok: true, entry: { item, column, assignments: [], trust: null } };
}
