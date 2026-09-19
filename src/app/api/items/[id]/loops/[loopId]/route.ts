// The HTTP adapter's single-loop endpoints — `GET`, `PATCH` and `DELETE` on
// `/items/{id}/loops/{loopId}` (SCHEMA.md §3a, §19). Thin shells over
// `service.call`.
//
// **Why the loop is a resource with its own methods**, where closing it is a
// `POST` to a sub-path (`.../close`). Closing is not deleting — the sibling
// route's header makes that point, and it is why `DELETE` was not already
// taken by it. The three verbs here read exactly as HTTP means them: `GET`
// returns the loop, `PATCH` changes its text, `DELETE` retracts it.
//
// `DELETE` is the honest method even though nothing is removed from the
// database. The ledger is append-only, so the operation appends an
// `open_loop_deleted` event and the loop stops being served — the same
// mechanism, and the same naming decision, `delete_item` makes one level up
// ("it is called delete and it never deletes"). The method describes what
// the caller is doing; the mechanism is stated plainly and hidden from
// nobody.
import { NextResponse } from "next/server";
import { service } from "@/lib/service/live";
import {
  authenticatedCaller,
  withRequestId,
  invalidJsonResponse,
  serializeAppendedEvent,
  serviceErrorResponse,
} from "../../../../_shared/respond";

type LoopParams = { params: Promise<{ id: string; loopId: string }> };

/** Parses the body, treating a non-object as empty and a broken one as an error. */
async function readBody(
  request: Request,
): Promise<{ ok: true; body: Record<string, unknown> } | { ok: false }> {
  try {
    const parsed = (await request.json()) as unknown;
    return {
      ok: true,
      body:
        typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {},
    };
  } catch {
    return { ok: false };
  }
}

/** `GET /items/{id}/loops/{loopId}` — one loop in full. */
export async function GET(request: Request, { params }: LoopParams) {
  const auth = authenticatedCaller(request);
  if (!auth.ok) return auth.response;
  const { requestId, caller } = auth;
  const { id, loopId } = await params;

  try {
    const result = await service.call("loop_get", { itemId: id, loopId }, { caller });
    return withRequestId(NextResponse.json(result), requestId);
  } catch (error) {
    return serviceErrorResponse(error, requestId);
  }
}

/** `PATCH /items/{id}/loops/{loopId}` — rewrite the loop's text. */
export async function PATCH(request: Request, { params }: LoopParams) {
  const auth = authenticatedCaller(request);
  if (!auth.ok) return auth.response;
  const { requestId, caller } = auth;
  const { id, loopId } = await params;
  const parsed = await readBody(request);
  if (!parsed.ok) return invalidJsonResponse(requestId);

  try {
    const edited = await service.call(
      "loop_edit",
      { ...parsed.body, itemId: id, loopId },
      { caller },
    );
    // The whole body rather than just the event: `previousText` is the half
    // that makes the response legible as a change, and it cannot be
    // recovered afterwards from any read — the loop now reports its new
    // wording.
    return withRequestId(
      NextResponse.json(
        {
          loopId: edited.loopId,
          previousText: edited.previousText,
          event: serializeAppendedEvent(edited.event),
        },
        { status: 200 },
      ),
      requestId,
    );
  } catch (error) {
    return serviceErrorResponse(error, requestId);
  }
}

/**
 * `POST /items/{id}/loops/{loopId}` — refused, naming the sub-path that closes.
 *
 * **This exists so that one specific wrong URL stops answering with silence.**
 * Closing a loop is `POST .../loops/{loopId}/close`, and a caller that puts
 * the loop id in the body instead — `POST /items/{id}/loops/close` — lands
 * here with `loopId` bound to the literal string `"close"`. Without a `POST`
 * export, Next answers that with an empty body and no error envelope, which
 * is the worst available answer: a caller checking for a non-empty body
 * reads every close as a failure, and one checking only for the absence of
 * an error reads success on a loop it never closed. An external report
 * arrived describing exactly that as "the close silently discards `reason`"
 * — the close had never run at all.
 *
 * Refused rather than helpfully redirected to the close operation. The path
 * genuinely does not identify a loop, and guessing that `"close"` was meant
 * as a verb here would make `POST .../loops/close` a second, undocumented
 * spelling of the close endpoint — reachable only by getting the URL wrong.
 */
export async function POST(request: Request, { params }: LoopParams) {
  const auth = authenticatedCaller(request);
  if (!auth.ok) return auth.response;
  const { requestId } = auth;
  const { id, loopId } = await params;

  const message =
    loopId === "close"
      ? `A loop is closed with POST /items/${id}/loops/{loopId}/close, with the loop id in the PATH — not in the body of /items/${id}/loops/close. This request named no loop, so nothing was closed.`
      : `POST is not a method on a single loop. Close one with POST /items/${id}/loops/${loopId}/close, rewrite its text with PATCH, or retract it with DELETE.`;

  return withRequestId(
    NextResponse.json(
      { error: { code: "invalid_input", message, fields: ["loopId"] } },
      { status: 400 },
    ),
    requestId,
  );
}

/** `DELETE /items/{id}/loops/{loopId}` — retract a loop that should never have existed. */
export async function DELETE(request: Request, { params }: LoopParams) {
  const auth = authenticatedCaller(request);
  if (!auth.ok) return auth.response;
  const { requestId, caller } = auth;
  const { id, loopId } = await params;
  // A body is read even though this is a `DELETE`, because the operation
  // requires a `reason` and there is nowhere else to put one that a caller
  // would find: a query parameter for a sentence of prose is worse, and the
  // requirement is the point of the operation rather than an extra.
  const parsed = await readBody(request);
  if (!parsed.ok) return invalidJsonResponse(requestId);

  try {
    const deleted = await service.call(
      "loop_delete",
      { ...parsed.body, itemId: id, loopId },
      { caller },
    );
    return withRequestId(
      NextResponse.json(
        {
          loopId: deleted.loopId,
          text: deleted.text,
          previousStatus: deleted.previousStatus,
          event: serializeAppendedEvent(deleted.event),
        },
        { status: 200 },
      ),
      requestId,
    );
  } catch (error) {
    return serviceErrorResponse(error, requestId);
  }
}
