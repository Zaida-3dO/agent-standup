// The HTTP adapter's transition endpoint (SCHEMA.md §19
// `POST /items/{id}/transition?dry_run=`). Thin shell over `service.call` —
// see `items/route.ts`'s own header for the shape every route here follows.
import { NextResponse } from "next/server";
import { service } from "@/lib/service/live";
import { RehearsalRollback } from "@/lib/service";
import { httpCaller, serviceErrorResponse } from "../../respond";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { requestId, caller } = httpCaller(request);
  const { id } = await params;
  const url = new URL(request.url);
  const dryRun = url.searchParams.get("dry_run") === "true";

  let body: Record<string, unknown>;
  try {
    const parsed = (await request.json().catch(() => ({}))) as unknown;
    body = typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return NextResponse.json(
      { error: { code: "invalid_input", message: "Request body must be valid JSON.", fields: [] } },
      { status: 400 },
    );
  }

  try {
    const result = await service.call("transition_item", { ...body, id, dryRun }, { caller });
    return NextResponse.json(result);
  } catch (error) {
    // `RehearsalRollback` is not a rejection — see that class's own doc for
    // why the dry_run path always throws even on an *allowed* outcome. This
    // is the one place that throw is meant to be caught: unwrap it back
    // into the outcome it carries and answer 200, exactly as a real
    // transition would report an allowed or rejected move without an
    // exception reaching this far. Any other thrown value still goes
    // through the ordinary error mapping below.
    if (error instanceof RehearsalRollback) {
      return NextResponse.json({ outcome: error.outcome });
    }
    return serviceErrorResponse(error, requestId);
  }
}
