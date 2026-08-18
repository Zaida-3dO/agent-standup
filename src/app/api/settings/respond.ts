// The HTTP adapter's own error-to-status mapping for the settings routes —
// same shape and same reasoning as `src/app/api/items/respond.ts` (SCHEMA.md
// §22: "the service never knows an HTTP status exists"). Kept as its own
// copy rather than imported from `../items/respond`, so the settings route
// tree does not couple to items' internal layout for a five-line mapping
// table both already own the right to define independently.
import { NextResponse } from "next/server";
import { toServiceError, type ServiceErrorCode } from "@/lib/service";
import { authenticatedCaller, withRequestId } from "../_shared/respond";

const STATUS_BY_CODE: Record<ServiceErrorCode, number> = {
  invalid_input: 400,
  not_found: 404,
  guard_rejected: 422,
  conflict: 409,
  forbidden: 403,
  not_implemented: 501,
  internal: 500,
};

/**
 * Renders any thrown value as the JSON error envelope this adapter uses, with
 * the mapped status.
 *
 * The request id is threaded through so a refusal names the same call the
 * server logged — see `authenticatedCaller` in `_shared/respond.ts` for why every
 * response carries it, not just the failures.
 */
export function serviceErrorResponse(error: unknown, requestId?: string): NextResponse {
  const serviceError = toServiceError(error);
  const status = STATUS_BY_CODE[serviceError.code];
  const rejection = serviceError.toRejection();
  return withRequestId(
    NextResponse.json({ error: { message: serviceError.message, ...rejection } }, { status }),
    requestId,
  );
}

export { authenticatedCaller, withRequestId };
