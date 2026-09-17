// `POST /api/areas/merge` — `merge_areas`. A named sub-route rather than a
// flag on `PATCH /areas/{id}`, matching `../../items/[id]/reparent/route.ts`
// and `../../items/[id]/retype/route.ts`: this call touches every item that
// held the losing area plus both `Area` rows, which is a different shape of
// write from renaming or archiving one row, and it is refused the same way
// those two are — see `merge_areas`' own header for the reasoning.
//
// A thin shell over one service call (SCHEMA.md §22): validation, guards and
// the de-duplication pass all live in the operation. The shell is
// `runReferenceRow`; the authentication gate and the service call stay here,
// because two scanners read this file's literal text to decide what it does.
import { service } from "@/lib/service/live";
import { authenticatedCaller } from "../../admin-respond";
import { runReferenceRow } from "../../_shared/reference-row";

export async function POST(request: Request) {
  const auth = authenticatedCaller(request);
  if (!auth.ok) return auth.response;

  return runReferenceRow(request, auth, {
    readsBody: true,
    call: ({ caller, input }) => service.call("merge_areas", input, { caller }),
  });
}
