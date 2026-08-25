// Cancelling an item from the detail page — the pure half.
//
// ── Why this exists at all ──────────────────────────────────────────────
//
// `delete_item` refuses an archive reason that reads like a cancellation and
// names `transition_item` to `cancelled` as the call to make instead. #281
// then added archive and restore controls and nothing else, so the interface
// arrived at a state where **the remedy the refusal names was not reachable
// from the interface at all**. A person who wanted to record "we decided not
// to do this" found exactly one button, and it was the wrong one.
//
// That is worse than a missing feature. Every affordance on the page pointed
// at archive, so the easy act was the destructive one and the correct act was
// the one with no control — which makes the confusion the archive guard exists
// to prevent *more* likely, not less. This module is the other half of that
// pair.
//
// ── The distinction being preserved ─────────────────────────────────────
//
// Archiving is for a row that **should never have existed** — a duplicate, or
// one created by accident. It hides the row from the board, from search and
// from every ordinary read.
//
// Cancelling is for a row that **was real** — work that was wanted, considered
// and then deliberately not done. The row survives, visible, carrying the
// decision. `SCHEMA.md` §1.4 draws exactly this line, and it is why the two
// operations exist separately rather than as one verb with a flag.
//
// Conflating them loses the decision, and the decision is the only part nobody
// can reconstruct later: a closed row with no reason is indistinguishable from
// an abandoned one.
//
// ── Why cancelling is a transition and not its own endpoint ─────────────
//
// `cancelled` is a state in the item state machine, so cancelling is
// `transition_item` and nothing new is invented here. That matters for more
// than tidiness: it means a cancellation goes through the same guards, writes
// the same event row and produces the same summary record as a cancellation
// recorded by an agent through the service. A second path with its own
// endpoint would be a second thing to keep in step, and the first divergence
// would be silent.
//
// Split out as a pure module for the reason `archive-state.ts` beside it is:
// this repo's harness runs `environment: "node"` with no DOM
// (`vitest.config.ts`), so the request shaping and the outcome branching are
// only directly testable as plain functions. The `useState` and the click
// handling live in `ItemDetailContainer.tsx`.
import { uiApiPath } from "@/lib/ui-proxy/path";
import {
  DECISION_CHAR_MIN,
  DECISION_CHAR_CAP,
  COMPLETED_STATES,
} from "@/lib/service/summaries/validate";

/**
 * The decision length rule, re-exported from the validator that owns it.
 *
 * Re-exported rather than restated as a literal so a change to the floor is a
 * single edit rather than a client and a server that disagree — the same
 * discipline `archive-state.ts` applies to `ARCHIVE_REASON_MIN_CHARS`. These
 * are pure constants with no database import, so naming them costs the client
 * bundle nothing; `npm run check:db-imports` enforces that boundary.
 *
 * The floor is the same 20 characters `delete_item` asks for, and deliberately
 * so: both refusals ask a caller for the same kind of sentence at the same
 * kind of moment, and two different minimums would be a difference with no
 * meaning behind it.
 */
export { DECISION_CHAR_MIN, DECISION_CHAR_CAP };

/** The state a cancellation moves the item to. */
export const CANCELLED_STATE = "cancelled";

/**
 * Whether this item is already finished, one way or another.
 *
 * Used by the surface to decide whether to offer the control at all. Reads the
 * validator's own `COMPLETED_STATES` rather than re-listing the four states,
 * so a fifth completed state cannot appear in the vocabulary and leave this
 * offering a cancellation on a row that is already closed.
 *
 * This is **not** a guard and does not pretend to be one — the state machine
 * owns whether a move is legal, and this call being wrong in either direction
 * changes only whether a button is drawn. The distinction is worth keeping
 * clear: not offering an act that cannot apply is a different thing from
 * offering it and having it refused.
 */
export function isAlreadyClosed(state: string): boolean {
  return (COMPLETED_STATES as readonly string[]).includes(state);
}

/**
 * How a cancellation ended.
 *
 * The same shape as `ArchiveOutcome` minus `supersededById`, which has no
 * meaning here: superseding is an archive concept — it names the row that
 * replaced one that should not have existed. A cancelled row was not replaced
 * by anything; it was decided against.
 */
export type CancelOutcome =
  | { readonly ok: true }
  | {
      readonly ok: false;
      /** The server's own sentence, carried through untouched. */
      readonly message: string;
      /** Which refusal this is, when the server named one. */
      readonly guard: string | null;
      /**
       * The specific fields the summary validator complained about, when it
       * was the validator that refused.
       *
       * Carried because a summary refusal is the one failure here a person can
       * act on precisely: "decision is 14 characters, under the 20-character
       * floor" is about the box on screen, and knowing *which* field lets the
       * surface put the complaint beside it rather than in a generic error
       * region. Empty for every other refusal.
       */
      readonly fields: readonly string[];
    };

/** The error envelope every items route answers with (`src/app/api/items/respond.ts`). */
interface ErrorBody {
  readonly error?: {
    readonly message?: unknown;
    readonly guard?: unknown;
    readonly fields?: unknown;
  };
}

/**
 * Reads a failed response into an outcome, preferring the server's sentence.
 *
 * The server's refusals here were written to be read — the summary validator
 * answers with the field, the rule and the distance from it — so this carries
 * the sentence through untouched for the same reason `archive-state.ts` does.
 * The status-code fallback is what a 502 looks like, not what a guard looks
 * like.
 */
async function outcomeFromFailure(response: Response): Promise<CancelOutcome> {
  try {
    const body = (await response.json()) as ErrorBody;
    const message = body.error?.message;
    const guard = body.error?.guard;
    const fields = body.error?.fields;
    return {
      ok: false,
      message:
        typeof message === "string" && message !== ""
          ? message
          : `Could not cancel this item (${response.status}).`,
      guard: typeof guard === "string" && guard !== "" ? guard : null,
      fields: Array.isArray(fields) ? fields.filter((f): f is string => typeof f === "string") : [],
    };
  } catch {
    // A non-JSON body is not itself worth reporting — the status is.
    return {
      ok: false,
      message: `Could not cancel this item (${response.status}).`,
      guard: null,
      fields: [],
    };
  }
}

/**
 * How the cancellation was established, for the summary's `how_verified`.
 *
 * ── Why this is derived rather than asked for ───────────────────────────
 *
 * A completed state's summary requires `what_to_test` when `user_facing` is
 * true and `how_verified` when it is false, and that branch runs for *every*
 * completed state — including the non-delivery ones. So a cancellation has to
 * carry a `how_verified` even though nothing was built to verify.
 *
 * Asking a person "how did you verify the work you did not do?" is a field
 * that can only be answered by writing something untrue. `validate.ts`'s own
 * header makes this argument better than this one can: a rule that forces a
 * false-ish statement in order to close a truthful state teaches that the
 * summary is a formality to satisfy rather than a record to get right, and
 * **one field that must be lied into is enough to make every neighbouring
 * field feel optional**. The neighbouring field here is `decision`, which is
 * the whole point of the act.
 *
 * So the person is asked for the one sentence that is real — why the work is
 * not being done — and this states what was actually established: a person
 * cancelled the row from its page, and no work was delivered. That is a true
 * account of this cancellation rather than filler.
 *
 * **What this sentence does not do**, stated because a reader should not have
 * to infer it: it carries no information specific to this row. It is the same
 * sentence every time. The per-row fact lives in `decision`, which is asked
 * for, checked for length, and refused when it is a shrug. This field is a
 * true constant; that is a deliberate trade against a prompt that would invite
 * a fabricated variable.
 */
export const CANCEL_HOW_VERIFIED =
  "Cancelled from the item page by a person. No work was delivered, so there was " +
  "nothing built to verify — the reasoning is recorded in the decision above.";

/** What a cancellation sends — `transition_item`'s input, minus the id the path carries. */
export interface CancelFields {
  /** Why the work is not being done. The sentence the whole act exists to record. */
  readonly decision: string;
  /**
   * The state the caller believed the item was in.
   *
   * Sent so a cancellation composed against a stale page is refused with where
   * the item actually is, rather than applied over a move somebody else made
   * while the sentence was being typed. This board is written concurrently by
   * many sessions, and a cancellation is a closing act — applying one to an
   * item that has since been merged is exactly the write worth refusing.
   */
  readonly expectedFrom?: string;
}

/**
 * The transition body a cancellation sends.
 *
 * Exported so a test can assert the exact shape without a network, and so the
 * summary's construction is one readable thing rather than an object literal
 * buried in a fetch call. `shipped` is empty and `decision` is present, which
 * is precisely the non-delivery shape the validator requires — it refuses a
 * `cancelled` close that also claims delivery, and that refusal is the field
 * split doing its job.
 */
export function cancelRequestBody(fields: CancelFields): Record<string, unknown> {
  const body: Record<string, unknown> = {
    to: CANCELLED_STATE,
    fields: {
      summary: {
        // Nothing was delivered. The validator refuses a non-delivery close
        // that carries shipped entries, which is what keeps this honest.
        shipped: [],
        decision: fields.decision.trim(),
        not_done: [],
        user_facing: false,
        how_verified: CANCEL_HOW_VERIFIED,
        watch_for: [],
      },
    },
  };
  if (fields.expectedFrom !== undefined) body.expectedFrom = fields.expectedFrom;
  return body;
}

/**
 * Cancels an item — `POST /api/items/{id}/transition`.
 *
 * No new endpoint: this is the ordinary transition route, which is what makes
 * a cancellation recorded here identical to one recorded by an agent through
 * the service. See the module header.
 */
export async function submitCancel(
  itemId: string,
  fields: CancelFields,
  fetchImpl: typeof fetch = fetch,
): Promise<CancelOutcome> {
  let response: Response;
  try {
    response = await fetchImpl(uiApiPath(`/api/items/${encodeURIComponent(itemId)}/transition`), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(cancelRequestBody(fields)),
    });
  } catch {
    return { ok: false, message: "The cancellation could not be sent.", guard: null, fields: [] };
  }
  if (!response.ok) return outcomeFromFailure(response);
  return { ok: true };
}

/**
 * Whether a decision is worth submitting at all.
 *
 * The client-side mirror of the validator's length rule, and **only** the
 * length rule — the same line `archive-state.ts` draws, for the same reason.
 * Length needs no explanation beyond the character count the form already
 * shows, so a round trip to learn it would be a round trip to be told what the
 * box knows. Everything else the validator checks (the jargon rule, the cap)
 * is left to the server, whose refusals explain themselves.
 *
 * The upper bound is included because it is equally mechanical and equally
 * visible: a person 40 characters over a cap should see that in the hint
 * rather than in a refusal.
 */
export function cancelDecisionIsValid(decision: string): boolean {
  const length = decision.trim().length;
  return length >= DECISION_CHAR_MIN && length <= DECISION_CHAR_CAP;
}
