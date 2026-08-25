// Archiving and restoring an item from the detail page — the pure half.
//
// `delete_item` and `restore_item` are complete service operations, and this
// is what lets a person reach them. Archiving is reversible — `restore_item`
// guards a restore under an archived parent, and refuses a superseded row
// unless the caller says they mean it — and that reversibility is only worth
// anything if a person can archive a row and bring it back without an API
// client.
//
// This is the fetch-shaping and outcome-branching half of that, split
// out for the same reason `edit-state.ts` beside it is: this repo's harness
// runs `environment: "node"` with no DOM (`vitest.config.ts`), so the request
// shaping and the success/failure branching are only directly testable as
// plain functions. The `useState` and the click handling live in
// `ItemDetailContainer.tsx`.
//
// ── The refusals are the product here, not an error path ────────────────
//
// Both operations refuse in ways that were written to be *read*. `delete_item`
// refuses a reason under twenty characters and names `cancelled` as the call
// to make instead when the reason describes work that was wanted and dropped;
// it lists every live child, holder and deferred review pointing at the row.
// `restore_item` refuses a superseded row **naming its replacement's id**, and
// refuses an archived parent, area or repo naming every blocker at once.
//
// Each of those sentences was composed for a person deciding what to do next,
// and each names the specific thing to go and look at. So this module's whole
// job on a failure is to carry the server's own sentence through untouched.
// It deliberately does **not** substitute a friendlier generic message. A
// message reading "Could not archive this item" throws away the only part of
// the response that tells the person what went wrong — which was "3 things
// point at this item and would be left pointing at something no read returns:
// child abc — Wire the toast (executing); …". The status-code fallback is
// reached only when there is genuinely no sentence to show.
//
// ── Why the guard id travels with the message ───────────────────────────
//
// A caller cannot act on prose. Two of these refusals are *resolvable by the
// person who hit them* — a superseded restore and an unacknowledged set of
// inbound references both clear on a flag the person can decide to pass — and
// the surface needs to know which refusal it is holding in order to offer that
// second step. Matching on the sentence would break the moment anyone reworded
// it, so the guard id is carried as its own field and the ids are re-exported
// from the operations that own them. See `ArchiveOutcome.guard`.
import { uiApiPath } from "@/lib/ui-proxy/path";

/**
 * The guard ids these two operations refuse with, re-exported from the
 * operations that define them.
 *
 * Re-exported rather than re-declared as string literals so that a rename in
 * the operation is a **compile error here**, not a silently dead branch in the
 * UI. These modules are pure constants with no database import, so naming them
 * costs the client bundle nothing — `npm run check:db-imports` is what enforces
 * that boundary, and it is satisfied by construction rather than by care.
 */
export {
  ARCHIVE_REASON_GUARD,
  ARCHIVE_REFERENCES_GUARD,
  ARCHIVE_REASON_MIN_CHARS,
} from "@/lib/service/operations/delete-item";
export {
  RESTORE_SUPERSEDED_GUARD,
  RESTORE_CONTEXT_GUARD,
} from "@/lib/service/operations/restore-item";

import {
  ARCHIVE_REFERENCES_GUARD,
  ARCHIVE_REASON_MIN_CHARS,
} from "@/lib/service/operations/delete-item";
import { RESTORE_SUPERSEDED_GUARD } from "@/lib/service/operations/restore-item";

/**
 * How an archive or a restore ended.
 *
 * `guard` is null on a transport-level failure and on a refusal that carried
 * no guard id — a 500, or a schema rejection — because those are not decisions
 * anybody can acknowledge past. Present, it names which refusal this is, which
 * is what lets the surface offer the second step for the two that have one.
 */
export type ArchiveOutcome =
  | { readonly ok: true }
  | {
      readonly ok: false;
      /** The server's own sentence, carried through untouched. See the header. */
      readonly message: string;
      readonly guard: string | null;
      /**
       * The replacement named by a superseded-restore refusal, when the server
       * named one.
       *
       * Pulled out of `details` rather than left for the surface to parse out
       * of the prose, so a link to the surviving row can be offered beside the
       * sentence. Null for every other outcome.
       */
      readonly supersededById: string | null;
    };

/** The error envelope every items route answers with (`src/app/api/items/respond.ts`). */
interface ErrorBody {
  readonly error?: {
    readonly message?: unknown;
    readonly guard?: unknown;
    readonly details?: { readonly supersededById?: unknown };
  };
}

/**
 * Reads a failed response into an outcome, preferring the server's sentence.
 *
 * The `verb` is only ever used for the fallback, and the fallback exists only
 * for a response with no readable sentence at all — a proxy error page, or a
 * body that is not JSON. Every refusal these two operations raise carries a
 * message, so in practice the fallback is what a 502 looks like, not what a
 * guard looks like.
 */
async function outcomeFromFailure(response: Response, verb: string): Promise<ArchiveOutcome> {
  try {
    const body = (await response.json()) as ErrorBody;
    const message = body.error?.message;
    const guard = body.error?.guard;
    const superseded = body.error?.details?.supersededById;
    return {
      ok: false,
      message:
        typeof message === "string" && message !== ""
          ? message
          : `Could not ${verb} this item (${response.status}).`,
      guard: typeof guard === "string" && guard !== "" ? guard : null,
      supersededById: typeof superseded === "string" && superseded !== "" ? superseded : null,
    };
  } catch {
    // A non-JSON body is not itself worth reporting — the status is.
    return {
      ok: false,
      message: `Could not ${verb} this item (${response.status}).`,
      guard: null,
      supersededById: null,
    };
  }
}

/** What an archive sends — `delete_item`'s input, minus the id the path carries. */
export interface ArchiveFields {
  readonly reason: string;
  /** The surviving row this one is archived in favour of, when there is one. */
  readonly supersededById?: string;
  /**
   * Says the person has read the list of things pointing at this row and means
   * to archive it anyway. Never sent on a first attempt — the refusal is what
   * shows them the list, and passing this before they have seen it would turn
   * the guard into a formality.
   */
  readonly acknowledgeReferences?: boolean;
}

/**
 * Archives an item — `DELETE /api/items/{id}`.
 *
 * Sends only what the caller named. `acknowledgeReferences` in particular is
 * omitted rather than sent as `false`, so the request a first attempt makes is
 * plainly the one that has not acknowledged anything.
 */
export async function submitArchive(
  itemId: string,
  fields: ArchiveFields,
  fetchImpl: typeof fetch = fetch,
): Promise<ArchiveOutcome> {
  let response: Response;
  try {
    response = await fetchImpl(uiApiPath(`/api/items/${encodeURIComponent(itemId)}`), {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(fields),
    });
  } catch {
    return {
      ok: false,
      message: "The archive could not be sent.",
      guard: null,
      supersededById: null,
    };
  }
  if (!response.ok) return outcomeFromFailure(response, "archive");
  return { ok: true };
}

/**
 * Restores an archived item — `POST /api/items/{id}/restore`.
 *
 * The same endpoint the undo affordance posts to (`@/lib/undo/request.ts`),
 * reached here by the button on an already-archived row. The two callers are
 * deliberately separate: undo runs a plan through `runUndo` and reports into a
 * toast, while this one is a direct action on a page that then re-reads. What
 * they share is the route and the guards, which is the part that matters.
 */
export async function submitRestore(
  itemId: string,
  options: { readonly acknowledgeSuperseded?: boolean } = {},
  fetchImpl: typeof fetch = fetch,
): Promise<ArchiveOutcome> {
  let response: Response;
  try {
    response = await fetchImpl(uiApiPath(`/api/items/${encodeURIComponent(itemId)}/restore`), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(options),
    });
  } catch {
    return {
      ok: false,
      message: "The restore could not be sent.",
      guard: null,
      supersededById: null,
    };
  }
  if (!response.ok) return outcomeFromFailure(response, "restore");
  return { ok: true };
}

/**
 * Whether an archive reason is worth submitting at all.
 *
 * The client-side mirror of `delete_item`'s own length rule, and **only** the
 * length rule. The cancellation-phrase check is deliberately NOT mirrored: it
 * is the refusal that does the actual steering — it names `cancelled` as the
 * call to make instead — and re-implementing it here would either duplicate a
 * list that is meant to be able to change, or, worse, block the submit with a
 * disabled button that cannot explain itself. A person typing "decided not to
 * do this" should reach the server and be told why that is a cancellation.
 *
 * Length is different: it needs no explanation beyond the character count the
 * form already shows, and asking the server to count characters is a round
 * trip to learn what the box already knows.
 */
export function archiveReasonIsValid(reason: string): boolean {
  return reason.trim().length >= ARCHIVE_REASON_MIN_CHARS;
}

/**
 * Whether this refusal is one the person can pass by acknowledging it.
 *
 * Two of the four are: inbound references on an archive, and a superseded row
 * on a restore. Both are the same shape — the server surfaced something the
 * caller may not have known, and the flag is how they say they know now. The
 * other two (a reason that reads as a cancellation, an archived parent) are
 * not acknowledgeable and must not be offered as if they were: one wants a
 * different verb, the other wants a different action on a different row.
 */
export function isAcknowledgeable(guard: string | null): boolean {
  return guard === ARCHIVE_REFERENCES_GUARD || guard === RESTORE_SUPERSEDED_GUARD;
}
