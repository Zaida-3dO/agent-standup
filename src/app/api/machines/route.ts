// The HTTP adapter's `machines` collection endpoint — SCHEMA.md §19
// `GET /machines`. MILESTONES.md #92. No `POST` — see `update-machine.ts`'s
// header for why creation happens through `PATCH /machines/{name}` instead.
//
// The shell around the call — render the result, map a thrown value onto the
// error envelope — is `runReferenceRow`. Two things stay here, in a file
// named `route.ts`, because two scanners read this file's literal text to
// decide what it does: the authentication gate, and the service call.
import { service } from "@/lib/service/live";
import { authenticatedCaller } from "../admin-respond";
import { runReferenceRow } from "../_shared/reference-row";

export async function GET(request: Request) {
  const auth = authenticatedCaller(request);
  if (!auth.ok) return auth.response;

  return runReferenceRow(request, auth, {
    call: ({ caller, input }) => service.call("list_machines", input, { caller }),
  });
}
