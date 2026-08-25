// The HTTP adapter's "what needs this person" endpoint (T24). Thin shell
// over one `service.call` (SCHEMA.md §22), like every other read route: no
// transaction, no settings, no database client.
//
// This is the endpoint that replaced three `GET /api/items?state=…` calls
// the inbox used to combine in the browser — see `get_needs_you`'s header
// for why the admission rule belongs on this side of the wire.
import { NextResponse } from "next/server";
import { service } from "@/lib/service/live";
import { authenticatedCaller, withRequestId } from "../_shared/respond";
import { serviceErrorResponse } from "../items/respond";
import { parseBooleanParam } from "../_shared/query";

export async function GET(request: Request) {
  const auth = authenticatedCaller(request);
  if (!auth.ok) return auth.response;
  const { requestId, caller } = auth;
  const url = new URL(request.url);
  const input: Record<string, unknown> = {};

  // `personId` is passed through exactly as given, including when absent —
  // the operation requires it, and letting its schema say so produces the
  // same `invalid_input` naming the same field on every adapter, which is
  // what §22's first assertion compares. Defaulting it here to the caller's
  // own identity would be this adapter inventing a rule the others do not
  // have, and would quietly serve one person's inbox to another.
  const personId = url.searchParams.get("personId");
  if (personId !== null) input.personId = personId;
  const full = url.searchParams.get("full");
  if (full !== null) input.full = parseBooleanParam(full);
  const limit = url.searchParams.get("limit");
  if (limit !== null) {
    const parsed = Number(limit);
    input.limit = Number.isNaN(parsed) ? limit : parsed;
  }
  const cursor = url.searchParams.get("cursor");
  if (cursor !== null) input.cursor = cursor;

  try {
    const result = await service.call("get_needs_you", input, { caller });
    return withRequestId(NextResponse.json(result), requestId);
  } catch (error) {
    return serviceErrorResponse(error, requestId);
  }
}
