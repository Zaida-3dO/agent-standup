// The HTTP adapter's settings collection endpoint — SCHEMA.md §19
// `GET /settings`, `PATCH /settings`.
//
// A thin shell over `service.call` (SCHEMA.md §22), same shape as
// `src/app/api/items/route.ts`: parse the request into a name and an input,
// call the service, render the result. Opens no transaction, resolves no
// settings snapshot itself, imports no database client.
import { NextResponse } from "next/server";
import { service } from "@/lib/service/live";
import { serviceErrorResponse } from "./respond";
import { httpCaller, withRequestId } from "../_shared/respond";

export async function GET(request: Request) {
  const { requestId, caller } = httpCaller(request);
  try {
    const result = await service.call("get_settings", {}, { caller });
    // The revision doubles as the entity tag (SCHEMA.md §17.2) — carried in
    // both the body (for a client parsing it as JSON) and the ETag header
    // (for a client that wants the cheap "did anything change" comparison
    // without decoding the body).
    return withRequestId(
      NextResponse.json(result, { headers: { ETag: `"${result.revision}"` } }),
      requestId,
    );
  } catch (error) {
    return serviceErrorResponse(error, requestId);
  }
}

export async function PATCH(request: Request) {
  const { requestId, caller } = httpCaller(request);
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return withRequestId(
      NextResponse.json(
        {
          error: { code: "invalid_input", message: "Request body must be valid JSON.", fields: [] },
        },
        { status: 400 },
      ),
      requestId,
    );
  }

  try {
    const result = await service.call("patch_settings", body, { caller });
    return withRequestId(NextResponse.json(result), requestId);
  } catch (error) {
    return serviceErrorResponse(error, requestId);
  }
}
