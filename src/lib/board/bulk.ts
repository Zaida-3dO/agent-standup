// Applying one action to many items — T6-E's second half.
//
// Split from `selection.ts` for the reason `move.ts` is split from
// `drag.ts`: this is the part that talks to the network, and keeping it a
// plain function taking a `fetch` makes the whole shaping-and-refusal path
// testable with a stub, with no DOM and no server.
//
// ── The partial-failure decision, and why it went this way ──────────────
//
// The question a bulk has to answer before it is written: when four of six
// items move and two are refused, what happened?
//
// **This is partial, with a report.** Every item is attempted, the ones
// that move stay moved, and the caller is told exactly which were refused
// and why. All-or-nothing was the alternative and it was rejected on the
// merits, not for convenience:
//
//   - **It is not purchasable.** The server has no multi-item write — there
//     is one `transition_item` per item and no transaction spanning them —
//     so "all or nothing" could only be *simulated*, by transitioning the
//     succeeded items back after a refusal.
//   - **The simulation has the same failure mode it is trying to fix.**
//     Each compensating transition can itself be refused: a guard can
//     reject the move back, and another session can have touched the item
//     in the intervening moment. A rollback that is itself partial leaves
//     the board in a third state, which is worse than either of the two the
//     choice was between — and it would have to be reported with a sentence
//     nobody wants to write.
//   - **It would contradict the undo path.** `runUndo` already made this
//     call for the reverse direction: "The already-applied steps are
//     deliberately NOT rolled back. Rolling back an undo would be a third
//     layer of inferred intent." A forward bulk that rolled back while the
//     undo of that same bulk did not would be two rules for one gesture.
//
// What makes partial *honest* rather than sloppy is the report. The thing
// that is genuinely forbidden — the mandate calls it out and it is the real
// hazard here — is reporting success for a partial. So `BulkOutcome` has no
// boolean success field at all: it carries the moved list and the refused
// list, and a caller cannot read "did it work" without confronting both.
//
// ── Every item carries its own `expectedFrom` (#257) ────────────────────
//
// A bulk is exactly where a stale copy does the most damage: the reader
// selected these rows some seconds ago, and this board is written
// concurrently by many agents. Each request therefore carries the state
// *that item* was in when it was selected, read off the board entry — not
// the column's target, and not one shared value for the batch. A selection
// spans columns, so a single `expectedFrom` would be wrong for all but one
// item and would either refuse everything or, worse, silently overwrite
// whatever another session had just done.
//
// A 409 is reported, never retried, for the reason `undo/request.ts` gives:
// re-sending with the item's new state as the premise is precisely the
// silent clobber the precondition exists to prevent.

import { uiApiPath } from "@/lib/ui-proxy/path";
import { conflictDetailsFrom } from "@/lib/live/conflict";
import type { ItemMove } from "@/lib/undo";
import type { ItemStateValue } from "@/lib/service/state-machine";
import type { BoardEntry } from "./types";

/**
 * One item a bulk failed to move, and why.
 *
 * `currentState` is present only when the server named it — a 409 carries
 * the item's actual state in `details.currentState`, which is the fact that
 * makes the refusal checkable against the list rather than a shrug. Null
 * for every other refusal, where nothing here read where the item is.
 */
export interface BulkRefusal {
  readonly itemId: string;
  /** The item's title, so the report can name it rather than show an id. */
  readonly title: string;
  readonly message: string;
  readonly currentState: string | null;
}

/**
 * What a bulk actually did.
 *
 * **No success boolean, deliberately.** The two lists are the outcome, and
 * a caller has to look at both to say anything about it — which is what
 * stops "it worked" being reported over a batch that half-failed. A
 * completely successful bulk is simply one with an empty `refused`.
 *
 * `moved` is `ItemMove[]` — the exact shape `UndoableAction`'s `bulk` kind
 * wants, each with its OWN `from`. That is not a coincidence: the undo
 * module was landed ahead of this with per-item origins precisely so a
 * bulk could hand its result straight over.
 */
export interface BulkOutcome {
  readonly moved: readonly ItemMove[];
  readonly refused: readonly BulkRefusal[];
}

/** The error envelope every items route answers with (`src/app/api/items/respond.ts`). */
interface ErrorBody {
  readonly error?: { readonly message?: unknown };
}

/** The message a failed response carries, or a stand-in naming the status. */
function messageFrom(body: unknown, status: number): string {
  const message = (body as ErrorBody)?.error?.message;
  if (typeof message === "string" && message !== "") return message;
  return `That move was refused (${status}).`;
}

/**
 * Move one item, reporting either the move it made or the refusal it hit.
 *
 * Returns a discriminated result rather than throwing, for the reason
 * `requestMove` gives: a refusal is an ordinary outcome here — the state
 * machine is real and guards refuse moves as a matter of course — so the
 * caller has to handle it on the normal path.
 *
 * **`full` is not requested.** Unlike a board drag, a bulk has no single
 * card to reconcile: the list re-reads afterwards, so asking for the whole
 * row on every item would fetch fields nothing here reads, once per
 * selected item.
 */
async function moveOne(
  entry: BoardEntry,
  to: ItemStateValue,
  fetchImpl: typeof fetch,
): Promise<{ ok: true; move: ItemMove } | { ok: false; refusal: BulkRefusal }> {
  const itemId = entry.item.id;
  const from = entry.item.state;
  let response: Response;
  try {
    response = await fetchImpl(uiApiPath(`/api/items/${encodeURIComponent(itemId)}/transition`), {
      method: "POST",
      headers: { "content-type": "application/json" },
      // **`expectedFrom` is this item's own pre-move state.** See the header.
      body: JSON.stringify({ to, expectedFrom: from }),
    });
  } catch {
    // The request never reached the server. Reported as a refusal with no
    // `currentState`: nothing is known about where the item is, and naming
    // a state would be a guess.
    return {
      ok: false,
      refusal: {
        itemId,
        title: entry.item.title,
        message: "That move could not be sent.",
        currentState: null,
      },
    };
  }

  if (response.ok) {
    // **The move is recorded from what was asked and what the item was**,
    // and both are values this function already holds. `from` is the state
    // the board reported for the item — the server's own value from the
    // board read, not a UI guess — which is what `ItemMove` requires.
    return { ok: true, move: { itemId, from: from as ItemStateValue, to } };
  }

  // The body is read once and used twice — `response.json()` can only be
  // consumed once, so the parsed value feeds both the message and the
  // conflict details.
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }

  const conflict = response.status === 409 ? conflictDetailsFrom(body) : null;
  return {
    ok: false,
    refusal: {
      itemId,
      title: entry.item.title,
      message: messageFrom(body, response.status),
      currentState: conflict?.currentState ?? null,
    },
  };
}

/**
 * Move every selected item to `to`.
 *
 * **Sequential, and it does not stop at a refusal** — the two halves of the
 * partial decision, and they pull in opposite directions from `runUndo`'s,
 * which stops at the first. The difference is deliberate and rests on what
 * the person asked for: an undo is one intention ("put that back"), so
 * abandoning it part-way keeps the damage bounded; a bulk is many
 * intentions ("move these six"), and refusing the remaining five because
 * the second was blocked would discard work the reader asked for on account
 * of an item that has nothing to do with them.
 *
 * Sequential rather than parallel, though, for a reason worth keeping: this
 * writes to a shared board that other sessions are reading, and firing
 * sixty transitions at once turns a triage gesture into a load spike. A
 * bulk is a handful of items and the reader is watching a progress count.
 *
 * **A no-op move is still attempted, and still reported as moved.** An item
 * already in `to` transitions successfully with `from === to`, and that
 * pair lands in `moved` unchanged — which is exactly what `inverseOf`
 * filters out when building the undo. Suppressing it here instead would
 * make the count the bar reports disagree with the count the server saw,
 * and would put the no-op rule in two places.
 */
export async function runBulkTransition(
  entries: readonly BoardEntry[],
  to: ItemStateValue,
  fetchImpl: typeof fetch = fetch,
  onProgress?: (done: number) => void,
): Promise<BulkOutcome> {
  const moved: ItemMove[] = [];
  const refused: BulkRefusal[] = [];
  let done = 0;
  for (const entry of entries) {
    const result = await moveOne(entry, to, fetchImpl);
    if (result.ok) moved.push(result.move);
    else refused.push(result.refusal);
    done += 1;
    onProgress?.(done);
  }
  return { moved, refused };
}

/**
 * The sentence reporting what a bulk did.
 *
 * Kept out of the component for the reason `undo/describe.ts` is: this is
 * branching prose, it is the part a reader actually sees, and in a harness
 * with no DOM a plain function returning a string is directly assertable
 * while the same logic inlined in JSX is only reachable by walking a tree.
 *
 * **The partial case leads with the refusal, not the success.** "Moved 4 of
 * 6" puts the number that needs attention first; "Moved 4 items, 2 failed"
 * reads as a success with a footnote, and the footnote is the part the
 * reader has to act on. This is the sentence the whole partial decision
 * stands or falls on — a bulk that half-worked and said "Moved 6 items"
 * would be the dishonest report the choice was made to avoid.
 */
export function describeBulkOutcome(outcome: BulkOutcome, toLabel: string): string {
  const movedCount = outcome.moved.length;
  const refusedCount = outcome.refused.length;
  const total = movedCount + refusedCount;

  if (refusedCount === 0) {
    return `Moved ${movedCount === 1 ? "1 item" : `${movedCount} items`} to ${toLabel}.`;
  }
  if (movedCount === 0) {
    return refusedCount === 1
      ? `That item could not be moved to ${toLabel}.`
      : `None of the ${refusedCount} items could be moved to ${toLabel}.`;
  }
  return `Moved ${movedCount} of ${total} to ${toLabel} — ${refusedCount} refused.`;
}
