// The HTTP adapter's remove action for a stored override whose key this
// build does not declare — SCHEMA.md §17.3. Thin shell over `service.call`,
// same shape as ../../[key]/route.ts.
//
// A path of its own rather than a flag on `DELETE /settings/{key}`, because
// the two are different operations with different refusals (see
// `remove-unrecognised-setting.ts`), and a caller that names the wrong one
// should be told so rather than silently getting the other's behaviour.
import { NextResponse } from "next/server";
import { service } from "@/lib/service/live";
import { authenticatedCaller, withRequestId, serviceErrorResponse } from "../../respond";

export async function DELETE(request: Request, { params }: { params: Promise<{ key: string }> }) {
  const auth = authenticatedCaller(request);
  if (!auth.ok) return auth.response;
  const { requestId, caller } = auth;
  const { key } = await params;
  try {
    const removed = await service.call("remove_unrecognised_setting", { key }, { caller });
    return withRequestId(NextResponse.json(removed), requestId);
  } catch (error) {
    return serviceErrorResponse(error, requestId);
  }
}
