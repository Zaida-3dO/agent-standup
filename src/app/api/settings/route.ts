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

export async function GET() {
  try {
    const result = await service.call("get_settings", {}, { caller: { transport: "http" } });
    // The revision doubles as the entity tag (SCHEMA.md §17.2) — carried in
    // both the body (for a client parsing it as JSON) and the ETag header
    // (for a client that wants the cheap "did anything change" comparison
    // without decoding the body).
    return NextResponse.json(result, { headers: { ETag: `"${result.revision}"` } });
  } catch (error) {
    return serviceErrorResponse(error);
  }
}

export async function PATCH(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: { code: "invalid_input", message: "Request body must be valid JSON.", fields: [] } },
      { status: 400 },
    );
  }

  try {
    const result = await service.call("patch_settings", body, { caller: { transport: "http" } });
    return NextResponse.json(result);
  } catch (error) {
    return serviceErrorResponse(error);
  }
}
