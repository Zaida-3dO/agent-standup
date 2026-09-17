// The HTTP adapter's single-machine endpoint — SCHEMA.md §19
// `GET /machines/{name}`, `PATCH /machines/{name}`. MILESTONES.md #92.
// `PATCH` upserts — see `update-machine.ts`'s header.
//
// The shell around each call is `runReferenceRow`. Two things stay here, in
// a file named `route.ts`, because two scanners read this file's literal
// text to decide what it does: the authentication gate, and the service
// call. See `_shared/reference-row.ts` for which scanner reads which.
//
// The path parameter is `name` rather than `id`, and it carries the input
// field of the same name — a machine is addressed by what it is called.
import { service } from "@/lib/service/live";
import { authenticatedCaller } from "../../admin-respond";
import { runReferenceRow } from "../../_shared/reference-row";

export async function GET(request: Request, { params }: { params: Promise<{ name: string }> }) {
  const auth = authenticatedCaller(request);
  if (!auth.ok) return auth.response;

  return runReferenceRow(request, auth, {
    params,
    wrapAs: "machine",
    call: ({ caller, input }) => service.call("get_machine", input, { caller }),
  });
}

export async function PATCH(request: Request, { params }: { params: Promise<{ name: string }> }) {
  const auth = authenticatedCaller(request);
  if (!auth.ok) return auth.response;

  return runReferenceRow(request, auth, {
    params,
    readsBody: true,
    wrapAs: "machine",
    call: ({ caller, input }) => service.call("update_machine", input, { caller }),
  });
}
