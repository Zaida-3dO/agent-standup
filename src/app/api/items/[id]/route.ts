// The HTTP adapter's single-item endpoint (SCHEMA.md §19 `GET /items/{id}`,
// `PATCH /items/{id}`). Thin shell over `service.call` — see items/route.ts.
import { NextResponse } from "next/server";
import { service } from "@/lib/service/live";
import { authenticatedCaller, withRequestId, serviceErrorResponse } from "../respond";
import { parseBooleanParam } from "../../_shared/query";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = authenticatedCaller(request);
  if (!auth.ok) return auth.response;
  const { requestId, caller } = auth;
  const { id } = await params;
  const input: Record<string, unknown> = { id };
  // `?full=true` opts out of the slim default (MILESTONES.md #107).
  const full = new URL(request.url).searchParams.get("full");
  if (full !== null) input.full = parseBooleanParam(full);
  try {
    const item = await service.call("get_item", input, { caller });
    return withRequestId(NextResponse.json({ item }), requestId);
  } catch (error) {
    return serviceErrorResponse(error, requestId);
  }
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = authenticatedCaller(request);
  if (!auth.ok) return auth.response;
  const { requestId, caller } = auth;
  const { id } = await params;
  let body: Record<string, unknown>;
  try {
    const parsed = (await request.json()) as unknown;
    body = typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
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
    const item = await service.call("update_item", { ...body, id }, { caller });
    return withRequestId(NextResponse.json({ item }), requestId);
  } catch (error) {
    return serviceErrorResponse(error, requestId);
  }
}
