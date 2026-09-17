// The HTTP adapter's single-account endpoint — SCHEMA.md §19
// `GET /accounts/{id}`, `PATCH /accounts/{id}`. MILESTONES.md #92.
// `PATCH` upserts — see `update-account.ts`'s header. This is also where
// `vendor` gets checked against the registered adapter list on write
// (SCHEMA.md §23.2) — enforced by the service operation, not this shell.
//
// The shell around each call is `runReferenceRow`. Two things stay here, in
// a file named `route.ts`, because two scanners read this file's literal
// text to decide what it does: the authentication gate, and the service
// call. See `_shared/reference-row.ts` for which scanner reads which.
import { service } from "@/lib/service/live";
import { authenticatedCaller } from "../../admin-respond";
import { runReferenceRow } from "../../_shared/reference-row";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = authenticatedCaller(request);
  if (!auth.ok) return auth.response;

  return runReferenceRow(request, auth, {
    params,
    wrapAs: "account",
    call: ({ caller, input }) => service.call("get_account", input, { caller }),
  });
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = authenticatedCaller(request);
  if (!auth.ok) return auth.response;

  return runReferenceRow(request, auth, {
    params,
    readsBody: true,
    wrapAs: "account",
    call: ({ caller, input }) => service.call("update_account", input, { caller }),
  });
}
