// The HTTP adapter's `repos` collection endpoint — SCHEMA.md §19
// `GET /repos`, `POST /repos`. MILESTONES.md #92.
//
// A thin shell over one service call (SCHEMA.md §22), same shape as
// `src/app/api/items/route.ts`: parse the request into a name and an input,
// call the service, render the result. The shell is `runReferenceRow`; the
// authentication gate and the service call stay here, because two scanners
// read this file's literal text to decide what it does.
import { service } from "@/lib/service/live";
import { authenticatedCaller } from "../admin-respond";
import { listInput, runReferenceRow } from "../_shared/reference-row";

export async function GET(request: Request) {
  const auth = authenticatedCaller(request);
  if (!auth.ok) return auth.response;

  return runReferenceRow(request, auth, {
    query: listInput,
    call: ({ caller, input }) => service.call("list_repos", input, { caller }),
  });
}

export async function POST(request: Request) {
  const auth = authenticatedCaller(request);
  if (!auth.ok) return auth.response;

  return runReferenceRow(request, auth, {
    readsBody: true,
    wrapAs: "repo",
    status: 201,
    call: ({ caller, input }) => service.call("create_repo", input, { caller }),
  });
}
