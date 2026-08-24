// The HTTP adapter's own error-to-status mapping (SCHEMA.md §22: "the
// service never knows an HTTP status exists" — that means this mapping
// belongs in the adapter, never in the service layer).
//
// Every items route funnels its response through here, so a rejection code
// maps onto the same HTTP status regardless of which route produced it —
// `create_item`'s `invalid_input` and `update_item`'s `invalid_input` both
// become 400, because the mapping is keyed on `ServiceError.code`, not on
// which route caught it.
import { NextResponse } from "next/server";
import { log } from "@/lib/log";
import { faultContext, toServiceError, type ServiceErrorCode } from "@/lib/service";
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
 * The structured extras a refusal carries, when it has any.
 *
 * `toRejection()` is deliberately the *comparable* part of a refusal — what
 * the adapter conformance suite asserts is identical across adapters — and
 * `details` is excluded from it by construction. That exclusion is right for
 * conformance and wrong for the client: a `conflict` that knows the item's
 * actual current state would render as a 409 that does not say what it is,
 * leaving the one fact the caller needs in order to retry parseable only out
 * of prose.
 *
 * So `details` is spread alongside the rejection rather than into it: the
 * comparable shape is untouched, and every existing envelope key keeps its
 * meaning. `ServiceErrorOptions.details` is documented as never containing
 * credentials, which is what makes it renderable at all.
 */
function detailsOf(error: { readonly details?: Readonly<Record<string, unknown>> }) {
  return error.details === undefined ? {} : { details: error.details };
}

/**
 * Renders any thrown value as the JSON error envelope this adapter uses, with
 * the mapped status.
 *
 * Logs an `internal` with its cause, for the same reason and on the same terms
 * as the `_shared` copy this mirrors — see the comment there. The two stay in
 * step on what one code means; they must also stay in step on this, or which
 * routes happen to import which copy would decide whether a 500 is
 * investigable.
 *
 * The request id is threaded through for the same reason and on the same
 * terms — see `httpCaller` in the `_shared` copy. `withRequestId` is
 * imported from there rather than duplicated a third time: the near-
 * duplication above is about what a *code* means, which each row owns,
 * whereas stamping a header is one line with nothing to disagree about.
 */
export function serviceErrorResponse(error: unknown, requestId?: string): NextResponse {
  const serviceError = toServiceError(error);
  const status = STATUS_BY_CODE[serviceError.code];
  const rejection = serviceError.toRejection();
  // `fault` rather than `code === "internal"`, so this responder and the
  // service runtime cannot come to disagree about which codes mean the
  // server broke. It puts `not_implemented` on this branch — a route
  // answering a call this build cannot serve is an operator's problem.
  if (serviceError.fault === "server") {
    log.error("Request failed unexpectedly.", {
      transport: "http",
      ...(requestId === undefined ? {} : { requestId }),
      ...faultContext(serviceError),
      err: serviceError,
    });
  }
  return withRequestId(
    NextResponse.json(
      { error: { message: serviceError.message, ...rejection, ...detailsOf(serviceError) } },
      { status },
    ),
    requestId,
  );
}

// Re-exported so a route in this tree imports its adapter helpers from the one
// module it already imports, rather than reaching across directories for a
// second. The helper itself lives in `_shared` because resolving an inbound
// request id is common to every route, not something this row owns.
export { authenticatedCaller, withRequestId };
