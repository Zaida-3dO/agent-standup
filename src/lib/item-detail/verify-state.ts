// Recording a check of an item's stored `state` — MILESTONES.md #131's
// "confirm state" action.
//
// A thin wrapper over `POST /items/{id}/artifacts` (`record_artifact`),
// exactly the shape `@/lib/board/move.ts` follows for `transition`: a plain
// function over an injectable `fetch`, so this is testable with a stub and
// no DOM, and a discriminated result rather than a thrown error, because a
// guard refusing the write is an ordinary outcome the caller has to render,
// not an exceptional one.
//
// **Why this writes a `historical_verification`, not a state transition.**
// The action this button offers is "I looked at this row and here is what I
// found" — a fact about an inspection, which is exactly the claim
// `historical_verification` already exists to record (SCHEMA.md §6b,
// `src/lib/service/guards/historical-verification.ts`). It is deliberately
// NOT a call to `transition_item`: recording a check must never itself
// change `state`, because the whole point of a verification is that it can
// disagree with the stored value and say so — a "confirm" that silently
// also mutated the row would make an honest "state is wrong" finding
// indistinguishable from the button just being clicked.
import { uiApiPath } from "@/lib/ui-proxy/path";

export type VerifyStateResult =
  { readonly ok: true } | { readonly ok: false; readonly message: string };

/** The error envelope every items route answers with (`src/app/api/items/respond.ts`). */
interface ErrorBody {
  readonly error?: { readonly message?: unknown };
}

export interface VerifyStateInput {
  readonly itemId: string;
  /** The commit the check was made against — `record_artifact` refuses a `historical_verification` without one. */
  readonly commitSha: string;
  /** What was inspected and what it found — required for the same reason. */
  readonly body: string;
  readonly createdByType: "person" | "agent";
  readonly createdById: string;
}

/**
 * Records a `historical_verification` for the item.
 *
 * Returns `ok: false` with the server's own refusal text where there is
 * one — the same "the guard's message is worth more than anything invented
 * here" reasoning `requestMove` follows — never a thrown error, so a caller
 * always has something to render.
 */
export async function verifyState(
  input: VerifyStateInput,
  fetchImpl: typeof fetch = fetch,
): Promise<VerifyStateResult> {
  let response: Response;
  try {
    response = await fetchImpl(
      uiApiPath(`/api/items/${encodeURIComponent(input.itemId)}/artifacts`),
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: "historical_verification",
          commitSha: input.commitSha,
          body: input.body,
          createdByType: input.createdByType,
          createdById: input.createdById,
        }),
      },
    );
  } catch {
    return { ok: false, message: "Could not reach the server. Check the connection and retry." };
  }

  if (!response.ok) {
    let serverMessage: string | null = null;
    try {
      const parsed = (await response.json()) as ErrorBody;
      const message = parsed.error?.message;
      if (typeof message === "string") serverMessage = message;
    } catch {
      serverMessage = null;
    }
    return {
      ok: false,
      message: serverMessage ?? `The server refused this (HTTP ${response.status}).`,
    };
  }

  return { ok: true };
}
