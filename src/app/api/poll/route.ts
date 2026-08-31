// The HTTP adapter's poll endpoint — SCHEMA.md §19 `POST /poll`,
// MILESTONES.md #58. Thin shell over `service.call`, the same shape as every
// other route here.
//
// Machine-facing, and it sits at the top level beside `/hook` and
// `/tool-calls` rather than under `/machines/{name}` because the machine a
// poll is recorded against is the one its *token* proved, not one named in
// the path. A path parameter would invite a caller to poll as a machine it
// does not hold, and the server would then be discarding a value the URL
// said was authoritative.
//
// `200` rather than `201`: a poll updates a machine's row and may store a
// reading, but the thing a caller came for is the answer — the interval, the
// globs, the bands — not a record of a resource created.
import { NextResponse } from "next/server";
import { service } from "@/lib/service/live";
import {
  invalidJsonResponse,
  serviceErrorResponse,
  authenticatedCaller,
  withRequestId,
} from "../_shared/respond";

export async function POST(request: Request) {
  const auth = authenticatedCaller(request);
  if (!auth.ok) return auth.response;
  const { requestId, caller } = auth;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return invalidJsonResponse(requestId);
  }

  try {
    const result = await service.call("poll", body, { caller });
    return withRequestId(NextResponse.json(result), requestId);
  } catch (error) {
    return serviceErrorResponse(error, requestId);
  }
}
