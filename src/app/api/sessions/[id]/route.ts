// The HTTP adapter's `GET /sessions/{id}` endpoint over `get_session_detail`
// (T19) — one session end to end.
//
// A thin shell over one `service.call`, the same shape as every other read
// route in this adapter: no transaction, no settings, no database client.
// The sibling `[id]/register` route is the write side of the same id.
import { NextResponse } from "next/server";
import { service } from "@/lib/service/live";
import { authenticatedCaller, withRequestId, serviceErrorResponse } from "../../items/respond";
import { parseBooleanParam } from "../../_shared/query";

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const auth = authenticatedCaller(request);
  if (!auth.ok) return auth.response;
  const { requestId, caller } = auth;
  const { id } = await context.params;
  const url = new URL(request.url);
  const input: Record<string, unknown> = { sessionId: id };

  const full = url.searchParams.get("full");
  if (full !== null) input.full = parseBooleanParam(full);

  // The two caps arrive as numbers or not at all. A non-numeric string is
  // forwarded untouched so the schema refuses it naming the field, rather
  // than this adapter quietly substituting a default the caller did not ask
  // for — the same rule `../../events/route.ts` applies to `limit`.
  for (const name of ["callLimit", "eventLimit"] as const) {
    const raw = url.searchParams.get(name);
    if (raw === null) continue;
    const parsed = Number(raw);
    input[name] = raw.trim() !== "" && Number.isFinite(parsed) ? parsed : raw;
  }

  try {
    const result = await service.call("get_session_detail", input, { caller });
    return withRequestId(NextResponse.json(result), requestId);
  } catch (error) {
    return serviceErrorResponse(error, requestId);
  }
}
