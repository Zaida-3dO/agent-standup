// The respond-in-place actions for `/needs-you` — what a person can
// actually *do* about each thing waiting on them, from the screen that
// says it is waiting.
//
// Composed over the existing `record_artifact`, `transition_item`, `note`
// and `update_item` operations. No new service operation: these are the
// same calls a person would otherwise have to make from the CLI.
//
// ── Why this is four controls and not one comment box ────────────────────
//
// A generic "reply" box would be the easy build and the wrong one. The four
// reasons are not four flavours of the same wait — they are waiting on
// different *acts*, recorded as different rows, read by different guards:
//
//   | reason                | the act              | what it records            |
//   |-----------------------|----------------------|----------------------------|
//   | `needs_approval`      | a DECISION to merge  | `merge_approval` + sha     |
//   | `plan_review`         | approving a plan     | `plan_review` verdict      |
//   | `needs_visual_review` | LOOKING at something | `visual_review` verdict    |
//   | `blocked_on_you`      | ANSWERING a question | a `note` on the item       |
//
// Collapsing those into one box would produce a row that satisfies no
// guard: the item would carry a person's words and still be held — a
// prompt answered into the void. The controls exist so that clicking one
// *actually ends the wait*.
//
// ── `needs_approval` records a `merge_approval`, never a `code_review` ───
//
// This is the correctness heart of the module.
//
// `merge_authority = needs_approval` is satisfied by exactly one thing:
// `merge.requires_authorisation` → `personHasApprovedMerge`
// (`../service/guards/merge-approval.ts`), which reads
// `kind = 'merge_approval' AND createdByType = 'person'`, scoped to the tip
// commit. A `code_review` — whoever authored it — never satisfies it.
//
// So an approve button that records an approving `code_review` as a person
// and then transitions to `merged` is wrong twice over. It writes a row
// `merge-approval.ts` exists to make unnecessary — that module's header is
// explicit that recording a review as a person "credits a human with a
// review an agent performed" — and the transition behind it cannot succeed
// anyway, because the authorisation clause refuses `merged` for want of the
// `merge_approval` nobody wrote. The click leaves a misleading
// person-authored review on the record and the item still held, so the
// decision has to be made somewhere else regardless. That is the dead end
// this screen exists to remove.
//
// So: `merge_approval`, `createdByType: "person"`, `commitSha` naming the
// tip. No verdict — `merge_approval` is not in `REVIEW_KINDS`, and
// `record_artifact` refuses a verdict on a non-review.
//
// ── Approving once vs. approving a class ────────────────────────────────
//
// `approveMerge` is a decision about *one state of one item*, pinned to a
// sha. `grantStandingApproval` is a different and much broader act — it
// sets `mergeAuthority` to `pre-approved` so this and future work on the
// item merges without asking again. They are deliberately separate
// functions here and separate, differently-weighted controls in the UI,
// because a person clicking "approve" almost never means "and everything
// after this too". `record_artifact`'s own refusal message points at
// `pre-approved` as the standing-grant path, so offering it here is
// surfacing an existing route rather than inventing one.
import { uiApiPath } from "@/lib/ui-proxy/path";
import type { NeedsYouItem, NeedsYouReason } from "./types";

export type RespondResult =
  { readonly ok: true } | { readonly ok: false; readonly message: string };

/** The error envelope every items route answers with (`src/app/api/items/respond.ts`). */
interface ErrorBody {
  readonly error?: { readonly message?: unknown };
}

async function readErrorMessage(response: Response, fallback: string): Promise<string> {
  try {
    const body = (await response.json()) as ErrorBody;
    const message = body.error?.message;
    if (typeof message === "string" && message.trim() !== "") return message;
  } catch {
    // fall through to the fallback below
  }
  return `${fallback} (returned ${response.status}).`;
}

/**
 * What kind of control a reason gets. The screen switches on this rather
 * than on the reason itself, so two reasons that happen to want the same
 * shape of control share one branch and the *reason* stays distinct in the
 * data.
 *
 *   - `decision` — an approve/reject pair that records evidence and may
 *     move the item on.
 *   - `answer`   — a free-text reply, because the wait is a question.
 */
export type ResponseKind = "decision" | "answer";

export const RESPONSE_KIND_BY_REASON: Readonly<Record<NeedsYouReason, ResponseKind>> = {
  blocked_on_you: "answer",
  needs_approval: "decision",
  needs_visual_review: "decision",
  plan_review: "decision",
};

/**
 * The three decision reasons and what each one's approval writes.
 *
 * `to: null` means "record the evidence and stop" — there is no transition
 * this screen can honestly make. That is the case for `needs_visual_review`:
 * an approving look clears `merge.requires_visual_review`, but the item may
 * still be held by the authorisation or code-review clauses, so moving it to
 * `merged` here would be asserting a merge the other guards have not agreed
 * to. Recording the look is the complete act; the merge happens when
 * everything holding it is satisfied.
 */
const DECISION_BY_REASON: Readonly<
  Record<
    "plan_review" | "needs_approval" | "needs_visual_review",
    {
      readonly kind: string;
      readonly to: string | null;
      /** Whether the artifact must name the tip commit it applies to. */
      readonly pinsCommit: boolean;
      /** Whether this kind takes a verdict — `merge_approval` does not. */
      readonly takesVerdict: boolean;
    }
  >
> = {
  plan_review: { kind: "plan_review", to: "executing", pinsCommit: false, takesVerdict: true },
  // `merge_approval` — NOT `code_review`. See the module header.
  needs_approval: { kind: "merge_approval", to: "merged", pinsCommit: true, takesVerdict: false },
  needs_visual_review: {
    kind: "visual_review",
    to: null,
    pinsCommit: true,
    takesVerdict: true,
  },
};

export interface RespondInput {
  readonly itemId: string;
  readonly reason: NeedsYouReason;
  /** The active profile responding — required: `record_artifact` refuses to guess a person. */
  readonly personId: string;
  /**
   * The item's state **as the server last reported it** — `NeedsYouItem.state`,
   * carried verbatim from `GET /api/needs-you` (`./state.ts`), never a value
   * this module derived.
   *
   * This becomes the transition's `expectedFrom` (MILESTONES.md #257). It is
   * required rather than optional for the reason #292 gives on the board's
   * drag path: omitting it is not a smaller request, it is a *different* one.
   * `applyTransition` raises `StaleTransitionError` only when a caller
   * supplied a precondition, so an approval sent without one asks the server
   * to move the item from wherever it now happens to be — and a decision made
   * against a screen that has gone stale gets a 200 and silently overwrites
   * whatever another session did in the meantime.
   *
   * **It must be the pre-move state, never the target.**
   */
  readonly expectedFrom: string;
  /**
   * The commit the decision applies to — `NeedsYouItem.tipCommitSha`, as the
   * server derived it. Required for the kinds that pin a commit, and its
   * absence is a refusal *before* any request rather than a 422 after one.
   */
  readonly tipCommitSha: string | null;
}

interface ArtifactBody {
  readonly kind: string;
  readonly createdByType: "person";
  readonly createdById: string;
  readonly verdict?: string;
  readonly commitSha?: string;
}

async function recordArtifact(
  itemId: string,
  body: ArtifactBody,
  fetchImpl: typeof fetch,
): Promise<Response> {
  return fetchImpl(uiApiPath(`/api/items/${encodeURIComponent(itemId)}/artifacts`), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** Whether this reason is answered by a decision rather than a reply. */
function isDecisionReason(
  reason: NeedsYouReason,
): reason is "plan_review" | "needs_approval" | "needs_visual_review" {
  return RESPONSE_KIND_BY_REASON[reason] === "decision";
}

/**
 * Approves — records the artifact this reason's approval actually needs,
 * then transitions the item onward when there is a transition to make.
 *
 * For `needs_approval` this writes a `merge_approval` naming the tip commit,
 * which is the one row `merge.requires_authorisation` accepts. For
 * `needs_visual_review` it writes an approving `visual_review` and stops.
 */
export async function approve(
  input: RespondInput,
  fetchImpl: typeof fetch = fetch,
): Promise<RespondResult> {
  if (!isDecisionReason(input.reason)) {
    return {
      ok: false,
      message: "This item is waiting on an answer, not a decision — reply to it instead.",
    };
  }
  const { kind, to, pinsCommit, takesVerdict } = DECISION_BY_REASON[input.reason];

  // Refused here rather than by the server, so the button is never offered
  // in a state where clicking it can only fail. `record_artifact` rejects a
  // `merge_approval` with no `commitSha` because an unpinned approval reads
  // as standing permission to merge whatever the item later becomes — and
  // the honest response to "there is no commit" is to say so, not to record
  // an approval scoped to nothing.
  if (pinsCommit && input.tipCommitSha === null) {
    return {
      ok: false,
      message:
        "This item has recorded no commit, so there is nothing to approve yet — an approval " +
        "names the commit it applies to. Once the work is pushed and its commit recorded, " +
        "this can be approved here.",
    };
  }

  const body: ArtifactBody = {
    kind,
    createdByType: "person",
    // The person who clicked, never the session that rendered the page.
    // This is what makes the authorisation mean anything: `createdByType`
    // is the field `personHasApprovedMerge` filters on, and an agent-authored
    // row is refused at the write.
    createdById: input.personId,
    // `plan_review` and `visual_review` both approve on `lgtm` — the tier
    // that clears with no further condition (`@/lib/verdicts.ts`'s
    // `APPROVING_VERDICTS`), the right default for a one-click approval with
    // no findings to record. A reviewer wanting to leave nits still has the
    // full Reviews tab on the item.
    ...(takesVerdict ? { verdict: "lgtm" } : {}),
    ...(pinsCommit && input.tipCommitSha !== null ? { commitSha: input.tipCommitSha } : {}),
  };

  let artifactResponse: Response;
  try {
    artifactResponse = await recordArtifact(input.itemId, body, fetchImpl);
  } catch {
    return { ok: false, message: "Could not reach the server to record that." };
  }
  if (!artifactResponse.ok) {
    return {
      ok: false,
      message: await readErrorMessage(artifactResponse, "Could not record that"),
    };
  }

  // Nothing further to do for a reason whose evidence *is* the whole act.
  if (to === null) return { ok: true };

  let transitionResponse: Response;
  try {
    transitionResponse = await fetchImpl(
      uiApiPath(`/api/items/${encodeURIComponent(input.itemId)}/transition`),
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ to, expectedFrom: input.expectedFrom }),
      },
    );
  } catch {
    return {
      ok: false,
      message: "That was recorded, but the server could not be reached to move the item on.",
    };
  }
  if (!transitionResponse.ok) {
    // The evidence stands even though the move did not — and saying so
    // matters, because the next thing the reader does depends on it. A
    // `merge_approval` that landed against a still-held item is not wasted:
    // the authorisation clause is now satisfied and whatever else is holding
    // the item is named in this message.
    return {
      ok: false,
      message: await readErrorMessage(
        transitionResponse,
        "That was recorded, but the item could not be moved on",
      ),
    };
  }
  return { ok: true };
}

/**
 * Rejects — records the rejecting verdict and stops.
 *
 * There is no "send back" state a `plan_review` or `in_review` item moves to
 * on a rejection (SCHEMA.md's state machine has no such edge — the item
 * stays where it is and the guard reading the artifact simply continues to
 * refuse until a new, approving one lands). So rejecting means "record why
 * not", which is a real and complete action.
 *
 * **`needs_approval` cannot be rejected this way**, and that is not an
 * oversight. `merge_approval` carries no verdict: it is a row whose
 * existence *is* the approval, so there is no such thing as a rejecting one.
 * Withholding it is how a person declines — the item simply stays held. The
 * honest control is therefore to leave a reason, which is what the UI offers
 * instead (a reply), rather than writing a rejecting `code_review` in a
 * human's name for a review no human performed.
 */
export async function reject(
  input: RespondInput,
  fetchImpl: typeof fetch = fetch,
): Promise<RespondResult> {
  if (!isDecisionReason(input.reason)) {
    return {
      ok: false,
      message: "This item is waiting on an answer, not a decision — reply to it instead.",
    };
  }
  if (input.reason === "needs_approval") {
    return {
      ok: false,
      message:
        "An approval is given or withheld, not refused on the record — leave a reply saying " +
        "what would need to change, and the item stays held until you approve it.",
    };
  }
  const { kind, pinsCommit } = DECISION_BY_REASON[input.reason];

  if (pinsCommit && input.tipCommitSha === null) {
    return {
      ok: false,
      message: "This item has recorded no commit, so there is nothing to review yet.",
    };
  }

  let response: Response;
  try {
    response = await recordArtifact(
      input.itemId,
      {
        kind,
        createdByType: "person",
        createdById: input.personId,
        verdict: "changes_required",
        ...(pinsCommit && input.tipCommitSha !== null ? { commitSha: input.tipCommitSha } : {}),
      },
      fetchImpl,
    );
  } catch {
    return { ok: false, message: "Could not reach the server to record that." };
  }
  if (!response.ok) {
    return { ok: false, message: await readErrorMessage(response, "Could not record that") };
  }
  return { ok: true };
}

/**
 * Answers — records a person's reply against the item as a `note`.
 *
 * This is what `blocked_on_you` gets, and it is deliberately *not* a
 * transition. A `blocked` item has no single canonical unblock target
 * (`../service/state-machine/transition.ts` permits many `from: "blocked"`
 * edges, chosen by what actually unblocks that specific item), so a screen
 * that moved the item on would be guessing at a transition it has no way to
 * know is right. The wait here is for an *answer*; supplying the answer is
 * the complete act, and the agent working the item is who acts on it.
 */
export async function answer(
  input: { readonly itemId: string; readonly personId: string; readonly body: string },
  fetchImpl: typeof fetch = fetch,
): Promise<RespondResult> {
  const trimmed = input.body.trim();
  if (trimmed === "") {
    return { ok: false, message: "Write a reply first." };
  }

  let response: Response;
  try {
    response = await fetchImpl(uiApiPath(`/api/items/${encodeURIComponent(input.itemId)}/notes`), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        body: trimmed,
        // The person who typed it — the same authorship discipline the
        // artifact path follows, so the item's history shows who answered
        // rather than which session posted it. `note`'s schema is `.strict()`
        // and names these `actorType`/`actorId`; `authorType`/`authorId`
        // would be rejected outright rather than ignored.
        actorType: "person",
        actorId: input.personId,
      }),
    });
  } catch {
    return { ok: false, message: "Could not reach the server to send that reply." };
  }
  if (!response.ok) {
    return { ok: false, message: await readErrorMessage(response, "Could not send that reply") };
  }
  return { ok: true };
}

/**
 * Grants a standing approval — sets `mergeAuthority` to `pre-approved`, so
 * this item merges without waiting on a person.
 *
 * Separate from `approve` on purpose, and the UI must present it as the
 * different and broader act it is. `approve` is a decision about the code as
 * it stands, pinned to a sha and expiring when the item moves past it; this
 * removes the hold altogether for whatever the item becomes. Both
 * `record_artifact` and `merge.requires_authorisation` name `pre-approved`
 * as the standing-grant route, so this surfaces an existing path rather than
 * inventing a second one.
 *
 * Note the hyphenated spelling: `update_item` accepts `pre-approved`, and
 * the DB enum's `pre_approved` would be refused.
 */
export async function grantStandingApproval(
  input: { readonly itemId: string },
  fetchImpl: typeof fetch = fetch,
): Promise<RespondResult> {
  let response: Response;
  try {
    response = await fetchImpl(uiApiPath(`/api/items/${encodeURIComponent(input.itemId)}`), {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ mergeAuthority: "pre-approved" }),
    });
  } catch {
    return { ok: false, message: "Could not reach the server to record that." };
  }
  if (!response.ok) {
    return {
      ok: false,
      message: await readErrorMessage(response, "Could not set this item to pre-approved"),
    };
  }
  return { ok: true };
}

/**
 * Whether `/needs-you` can act on this row at all.
 *
 * Every reason now has a control, so this is true for all four — stated as
 * a function anyway so the *claim* has somewhere to live and a later reason
 * added without an affordance breaks a test rather than silently rendering
 * a row a person cannot answer, which is the whole defect this screen was
 * built to fix.
 */
export function isRespondable(item: NeedsYouItem): boolean {
  return item.reason in RESPONSE_KIND_BY_REASON;
}
