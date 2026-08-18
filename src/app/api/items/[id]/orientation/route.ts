// The HTTP adapter's orientation endpoint (SCHEMA.md §19
// `GET /items/{id}/orientation`, MILESTONES.md #28). Thin shell over
// `service.call`, exactly like `items/route.ts` and `items/[id]/route.ts`
// (SCHEMA.md §22: "every way in ... is a thin shell over one service
// call") — parse the request into a name and an input, call the service,
// render the result. No transaction opened, no settings resolved, no
// database client imported here.
import { NextResponse } from "next/server";
import { service } from "@/lib/service/live";
import { httpCaller, serviceErrorResponse } from "../../respond";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { requestId, caller } = httpCaller(request);
  const { id } = await params;
  const url = new URL(request.url);
  const input: Record<string, unknown> = { itemId: id };
  const since = url.searchParams.get("since");
  if (since !== null) input.since = since;

  try {
    const result = await service.call("orientation", input, { caller });
    return NextResponse.json(result);
  } catch (error) {
    return serviceErrorResponse(error, requestId);
  }
}
