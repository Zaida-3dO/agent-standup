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
