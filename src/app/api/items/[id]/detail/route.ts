// The HTTP adapter's item-detail endpoint — MILESTONES.md #72. Thin shell
// over one `service.call`, exactly like `items/[id]/route.ts` and
// `items/[id]/orientation/route.ts` (SCHEMA.md §22: "every way in ... is a
// thin shell over one service call"): resolve the request into a name and
// an input, call the service, shape the result for the transport. No
// transaction opened, no settings resolved, no database client imported.
import { NextResponse } from "next/server";
import { service } from "@/lib/service/live";
import { httpCaller, withRequestId, serviceErrorResponse } from "../../respond";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { requestId, caller } = httpCaller(request);
  const { id } = await params;
  const url = new URL(request.url);
  const input: Record<string, unknown> = { id };

  // `historyLimit` is passed through as a number when present and omitted
  // entirely when absent, so the operation's own default applies rather
  // than this adapter re-declaring it. A non-numeric value is passed
  // through as-is for the operation's schema to reject — an adapter that
  // silently swallowed it would turn a caller's mistake into a surprising
  // default instead of an error naming the field.
  const historyLimit = url.searchParams.get("historyLimit");
  if (historyLimit !== null) {
    const parsed = Number(historyLimit);
    input.historyLimit = Number.isNaN(parsed) ? historyLimit : parsed;
  }

  try {
    const detail = await service.call("get_item_detail", input, {
      caller,
    });
    return withRequestId(NextResponse.json({ detail }), requestId);
  } catch (error) {
    return serviceErrorResponse(error, requestId);
  }
}
