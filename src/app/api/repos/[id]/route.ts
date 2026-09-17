// The HTTP adapter's single-repo endpoint — SCHEMA.md §19 `GET /repos/{id}`,
// `PATCH /repos/{id}`, `DELETE /repos/{id}`. MILESTONES.md #92, #96.
//
// The shell around each call is `runReferenceRow`. Two things stay here, in
// a file named `route.ts`, because two scanners read this file's literal
// text to decide what it does: the authentication gate, and the service
// call. See `_shared/reference-row.ts` for which scanner reads which.
import { service } from "@/lib/service/live";
import { authenticatedCaller } from "../../admin-respond";
import { readDeleteInput, runReferenceRow } from "../../_shared/reference-row";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = authenticatedCaller(request);
  if (!auth.ok) return auth.response;

  return runReferenceRow(request, auth, {
    params,
    wrapAs: "repo",
    call: ({ caller, input }) => service.call("get_repo", input, { caller }),
  });
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = authenticatedCaller(request);
  if (!auth.ok) return auth.response;

  return runReferenceRow(request, auth, {
    params,
    readsBody: true,
    wrapAs: "repo",
    call: ({ caller, input }) => service.call("update_repo", input, { caller }),
  });
}

// `DELETE /repos/{id}` — the hard delete half of MILESTONES.md #96.
//
// Separate from the `PATCH` above because deleting and archiving are two
// different operations, not one operation with a flag: `PATCH` with
// `archived: true` keeps the row and every reference to it, and is what a
// caller almost always wants. This removes the row outright and is refused
// unless nothing anywhere references it.
export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = authenticatedCaller(request);
  if (!auth.ok) return auth.response;

  return runReferenceRow(request, auth, {
    params,
    // The `hardDelete` flag comes from the body or the query string, and an
    // absent flag is never defaulted — see `readDeleteInput`, which is
    // shared with the sibling reference-row deletes because all three read
    // it identically. Passed as `read` rather than `readsBody` so it runs
    // after the auth check, which is where it ran before: an unauthenticated
    // caller sending an unparseable body is told they are unauthenticated,
    // not that their JSON is malformed.
    read: readDeleteInput,
    call: ({ caller, input }) => service.call("delete_repo", input, { caller }),
  });
}
