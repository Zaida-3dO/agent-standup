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
import { conflictDetailsFrom, type ConflictDetails } from "@/lib/live/conflict";

export type MoveResult =
  | { readonly ok: true; readonly entry: BoardEntry }
  | {
      readonly ok: false;
      readonly message: string;
      /**
       * Present only when the server refused with a 409 whose `details` this
       * client could read — i.e. someone else moved the item first (T17).
       *
       * **A separate field rather than a flag on the message**, because the
       * two refusals call for opposite treatment of the card. An ordinary
       * refusal means the move did not happen and the card belongs where it
       * was, so it reverts. A conflict means the item genuinely moved — just
       * not by this person — so reverting would put the card somewhere that
       * is *also* wrong, and would do it while the board's own live feed is
       * about to correct it. `currentState` is what the card settles on
       * instead.
       */
      readonly conflict?: ConflictDetails;
    };

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
    //
    // **The body is read once and used twice.** `response.json()` can only be
    // consumed once, so the parsed value feeds both the message and the
    // conflict details — reading it a second time would throw and silently
    // lose the attribution this row exists to provide.
    let serverMessage: string | null = null;
    let body: unknown = null;
    try {
      body = await response.json();
      const message = (body as ErrorBody).error?.message;
      if (typeof message === "string") serverMessage = message;
    } catch {
      serverMessage = null;
      body = null;
    }

    // A 409 is the multiplayer refusal: someone else moved the item between
    // this client reading it and this request landing. `conflictDetailsFrom`
    // returns null for a 409 whose details cannot be read, which falls back
    // to the ordinary refusal — a confidently wrong conflict message would
    // be worse than a generic one.
    if (response.status === 409) {
      const conflict = conflictDetailsFrom(body);
      if (conflict !== null) {
        // The message is deliberately left to the caller, which is the only
        // layer holding the live feed's recent events and therefore the only
        // one that can name who moved it. `refusalMessage` remains the
        // fallback when there is nothing to attribute it to.
        return {
          ok: false,
          message: refusalMessage(response.status, serverMessage),
          conflict,
        };
      }
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

  // No assignments, no trust, no subtask rollup: the transition response
  // carries the item, not its ownership, its verification history or its
  // subtree, and a settled card re-renders from the next board read. An
  // empty array/`null` are the honest values for "this response did not
  // say" — the same reason the API never omits any of the keys.
  //
  // Note this makes a moved card's badge disappear until the next board
  // read rather than showing a stale count. That is the right way round:
  // the count is a fact about the subtree, and inventing one from the
  // pre-move entry would state it as current when nothing here checked.
  return { ok: true, entry: { item, column, assignments: [], trust: null, subtasks: null } };
}
