// The decide-in-place actions — "approve" and "deny", over the existing
// `record_artifact` + `transition_item` operations, exactly as the task's
// brief asks for. No new service operation: this composes two calls that
// already exist, the same two a reviewer would make from the CLI.
//
// **Two requests, not one, and the second is skipped on a rejection of the
// first.** `record_artifact` writes the evidence a guard reads;
// `transition_item` is what the guard actually gates. Recording an
// approving artifact and then failing to transition is still useful — the
// evidence exists and the guard now passes for whoever tries next — so it
// is not rolled back; but a `record_artifact` failure must stop here rather
// than attempt a transition with no evidence behind it, which would either
// be refused by the same guard (an honest, if redundant, failure) or — for
// an item whose state this code cannot fully trust after a failed write —
// occasionally not.
//
// **Deny records the rejecting verdict and stops. It does not transition.**
// There is no "send back" state a plan_review or in_review item moves to on
// a `changes_required`/rejection verdict (SCHEMA.md's state machine has no
// such edge — the item stays exactly where it is and the guard that reads
// the artifact simply continues to refuse `merged`/`executing` until a new,
// approving one lands). So "deny" here means "record why not", which is a
// real and complete action: the next reviewer or the agent already on the
// item sees the rejection and knows to act, without this screen guessing at
// a transition the schema does not define.
import { uiApiPath } from "@/lib/ui-proxy/path";
import type { NeedsYouReason } from "./types";

export type DecideResult = { readonly ok: true } | { readonly ok: false; readonly message: string };

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

/** The artifact kind and the transition each reason's approval writes — the pairing the module header argues for. */
const APPROVAL_BY_REASON: Readonly<
  Record<"plan_review" | "needs_approval", { readonly kind: string; readonly to: string }>
> = {
  plan_review: { kind: "plan_review", to: "executing" },
  needs_approval: { kind: "code_review", to: "merged" },
};

interface DecideInput {
  readonly itemId: string;
  readonly reason: NeedsYouReason;
  /** The active profile deciding — required: `record_artifact` refuses to guess a person (see that operation's own header). */
  readonly personId: string;
}

async function recordArtifact(
  itemId: string,
  kind: string,
  verdict: string,
  personId: string,
  fetchImpl: typeof fetch,
): Promise<Response> {
  return fetchImpl(uiApiPath(`/api/items/${encodeURIComponent(itemId)}/artifacts`), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      kind,
      verdict,
      createdByType: "person",
      createdById: personId,
    }),
  });
}

/**
 * Approves — records the approving artifact the item's reason needs, then
 * transitions it onward. `blocked_on_you` is not accepted; see
 * `isDecidable` (`./view.ts`) for why that reason has no single approval
 * this function could perform.
 */
export async function approve(
  input: DecideInput,
  fetchImpl: typeof fetch = fetch,
): Promise<DecideResult> {
  if (input.reason !== "plan_review" && input.reason !== "needs_approval") {
    return { ok: false, message: "This item has no single approval action — open it to decide." };
  }
  const { kind, to } = APPROVAL_BY_REASON[input.reason];
  // `plan_review` and `code_review` both approve on `lgtm` — the tier that
  // merges on its own with no further condition (`@/lib/verdicts.ts`'s
  // `APPROVING_VERDICTS`), which is the right default for a one-click
  // approval with no findings to record. A reviewer wanting to leave nits
  // or file a follow-up still has the full Reviews tab on the item.
  const verdict = "lgtm";

  let artifactResponse: Response;
  try {
    artifactResponse = await recordArtifact(input.itemId, kind, verdict, input.personId, fetchImpl);
  } catch {
    return { ok: false, message: "Could not reach the server to record the approval." };
  }
  if (!artifactResponse.ok) {
    return {
      ok: false,
      message: await readErrorMessage(artifactResponse, "Could not record the approval"),
    };
  }

  let transitionResponse: Response;
  try {
    transitionResponse = await fetchImpl(
      uiApiPath(`/api/items/${encodeURIComponent(input.itemId)}/transition`),
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ to }),
      },
    );
  } catch {
    return {
      ok: false,
      message:
        "The approval was recorded, but the server could not be reached to move the item on.",
    };
  }
  if (!transitionResponse.ok) {
    return {
      ok: false,
      message: await readErrorMessage(
        transitionResponse,
        "The approval was recorded, but the item could not be moved on",
      ),
    };
  }
  return { ok: true };
}

/**
 * Denies — records a rejecting verdict and stops. See the module header for
 * why this does not also transition.
 */
export async function deny(
  input: DecideInput,
  fetchImpl: typeof fetch = fetch,
): Promise<DecideResult> {
  if (input.reason !== "plan_review" && input.reason !== "needs_approval") {
    return { ok: false, message: "This item has no single denial action — open it to decide." };
  }
  const { kind } = APPROVAL_BY_REASON[input.reason];

  let response: Response;
  try {
    response = await recordArtifact(
      input.itemId,
      kind,
      "changes_required",
      input.personId,
      fetchImpl,
    );
  } catch {
    return { ok: false, message: "Could not reach the server to record the denial." };
  }
  if (!response.ok) {
    return { ok: false, message: await readErrorMessage(response, "Could not record the denial") };
  }
  return { ok: true };
}
