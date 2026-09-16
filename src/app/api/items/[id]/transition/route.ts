// The HTTP adapter's transition endpoint (SCHEMA.md §19
// `POST /items/{id}/transition?dry_run=`). Thin shell over `service.call` —
// see `items/route.ts`'s own header for the shape every route here follows.
import { NextResponse } from "next/server";
import { service } from "@/lib/service/live";
import { authenticatedCaller, withRequestId, serviceErrorResponse } from "../../respond";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = authenticatedCaller(request);
  if (!auth.ok) return auth.response;
  const { requestId, caller } = auth;
  const { id } = await params;
  const url = new URL(request.url);
  const dryRun = url.searchParams.get("dry_run") === "true";

  let body: Record<string, unknown>;
  try {
    const parsed = (await request.json().catch(() => ({}))) as unknown;
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
    const result = await service.call("transition_item", { ...body, id, dryRun }, { caller });
    return withRequestId(NextResponse.json(result), requestId);
  } catch (error) {
    // No rehearsal special case here. A `dry_run` rolls its transaction
    // back by throwing (`service/operations/rehearsal-rollback.ts`), but
    // the runtime catches that sentinel immediately outside the transaction
    // and resolves it as `{ outcome }` — so the `try` above answers 200
    // with the rehearsal's verdict on its ordinary path, and a genuine
    // rejection is the only thing reaching this catch.
    return serviceErrorResponse(error, requestId);
  }
}
