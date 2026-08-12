// Shared error-to-status mapping for the admin entity routes (`/repos`,
// `/areas`, `/machines`, `/accounts`) — SCHEMA.md §19, §22 ("the service
// never knows an HTTP status exists"). MILESTONES.md #92.
//
// One copy across the four route trees this row owns, unlike `items` and
// `settings`, which each keep their own (`src/app/api/items/respond.ts`,
// `src/app/api/settings/respond.ts`) so their route trees don't couple to
// each other's internal layout. That reasoning is about *independent*
// owners, not about copying being wrong in general — all four admin trees
// below are this same row, so one shared mapping is the one that would
// actually drift if it were duplicated four times instead.
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

/** Renders an unparseable request body the same way every route here does. */
export function invalidJsonResponse(): NextResponse {
  return NextResponse.json(
    { error: { code: "invalid_input", message: "Request body must be valid JSON.", fields: [] } },
    { status: 400 },
  );
}

/** Parses a JSON request body into a plain object, or `null` if it is not valid JSON. */
export async function readJsonBody(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const parsed = (await request.json()) as unknown;
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return null;
  }
}
