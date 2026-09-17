// The HTTP adapter's `areas` collection endpoint — SCHEMA.md §19
// `GET /areas`, `POST /areas`. MILESTONES.md #92. Same shape as
// ../repos/route.ts.
//
// The shell around each call is `runReferenceRow`. Two things stay here, in
// a file named `route.ts`, because two scanners read this file's literal
// text to decide what it does: the authentication gate, and the service
// call. See `_shared/reference-row.ts` for which scanner reads which.
import { service } from "@/lib/service/live";
import { authenticatedCaller } from "../admin-respond";
import { listInput, runReferenceRow } from "../_shared/reference-row";

export async function GET(request: Request) {
  const auth = authenticatedCaller(request);
  if (!auth.ok) return auth.response;

  return runReferenceRow(request, auth, {
    query: listInput,
    call: ({ caller, input }) => service.call("list_areas", input, { caller }),
  });
}

export async function POST(request: Request) {
  const auth = authenticatedCaller(request);
  if (!auth.ok) return auth.response;

  return runReferenceRow(request, auth, {
    readsBody: true,
    wrapAs: "area",
    status: 201,
    call: ({ caller, input }) => service.call("create_area", input, { caller }),
  });
}
