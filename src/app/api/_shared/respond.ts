// Shared HTTP-adapter error-to-status mapping (SCHEMA.md §22: "the service
// never knows an HTTP status exists" — that means this mapping belongs in
// the adapter, never in the service layer).
//
// A near-duplicate of `src/app/api/items/respond.ts` (row #26), kept
// separate rather than imported across directories: `items/respond.ts` is
// that row's own file, and reaching into it from `claims/`/`checkpoints/`
// would couple two independently-owned routes to one file neither owns
// outright. Both copies key the same mapping off `ServiceError.code`, so
// they cannot disagree about what one code means — only about which routes
// happen to import which copy.
import { NextResponse } from "next/server";
import { toServiceError, type ServiceErrorCode } from "@/lib/service";

const STATUS_BY_CODE: Record<ServiceErrorCode, number> = {
  invalid_input: 400,
  not_found: 404,
  guard_rejected: 422,
  conflict: 409,
  forbidden: 403,
  not_implemented: 501,
  internal: 500,
};

/** Renders any thrown value as the JSON error envelope this adapter uses, with the mapped status. */
export function serviceErrorResponse(error: unknown): NextResponse {
  const serviceError = toServiceError(error);
  const status = STATUS_BY_CODE[serviceError.code];
  const rejection = serviceError.toRejection();
  return NextResponse.json({ error: { message: serviceError.message, ...rejection } }, { status });
}

/** Renders a malformed-JSON body as the same 400 envelope every route uses for it. */
export function invalidJsonResponse(): NextResponse {
  return NextResponse.json(
    { error: { code: "invalid_input", message: "Request body must be valid JSON.", fields: [] } },
    { status: 400 },
  );
}

/**
 * `AppendedEvent` (src/lib/events.ts) carries `id` and `txId` as `bigint` —
 * chosen there because Postgres's `xid8`/`bigserial` values do not fit
 * `number` without precision loss at realistic table sizes. `JSON.stringify`
 * (which `NextResponse.json` calls internally) throws on a raw `bigint`
 * rather than silently truncating it, so every route returning one of these
 * must convert first. Stringified rather than left numeric: a `bigint`
 * serialised as a JSON number would round-trip through a JS client's
 * `JSON.parse` as an imprecise `number`, the exact loss the `bigint` type
 * exists to avoid — the string form is what every consumer here has to
 * parse deliberately instead of losing precision by default.
 */
export function serializeAppendedEvent(event: {
  readonly id: bigint;
  readonly txId: bigint;
  readonly ts: Date;
}): { id: string; txId: string; ts: string } {
  return { id: String(event.id), txId: String(event.txId), ts: event.ts.toISOString() };
}
