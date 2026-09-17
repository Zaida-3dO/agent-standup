// The HTTP adapter's intervention-configuration collection endpoint —
// MILESTONES.md #128, `GET /interventions/settings`.
//
// Thin shell over `service.call`, same shape as `src/app/api/settings/route.ts`.
// Opens no transaction, reads no settings itself, imports no database client.
//
// **Under `/api/interventions` rather than `/api/settings`.** The keys these
// configure are deliberately absent from `SETTINGS_REGISTRY` — see
// `src/lib/interventions/settings.ts` — and the settings routes refuse them
// for that reason. Serving them from the settings tree would put two
// different notions of "a setting" behind one path prefix, with only the key
// spelling to tell a caller which refusals apply.
import { NextResponse } from "next/server";
import { service } from "@/lib/service/live";
import { authenticatedCaller, serviceErrorResponse, withRequestId } from "../../_shared/respond";

export async function GET(request: Request) {
  const auth = authenticatedCaller(request);
  if (!auth.ok) return auth.response;
  const { requestId, caller } = auth;
  try {
    const result = await service.call("list_intervention_settings", {}, { caller });
    return withRequestId(NextResponse.json(result), requestId);
  } catch (error) {
    return serviceErrorResponse(error, requestId);
  }
}
