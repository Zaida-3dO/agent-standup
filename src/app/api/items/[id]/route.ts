// The HTTP adapter's single-item endpoint (SCHEMA.md §19 `GET /items/{id}`,
// `PATCH /items/{id}`). Thin shell over `service.call` — see items/route.ts.
import { NextResponse } from "next/server";
import { service } from "@/lib/service/live";
import { authenticatedCaller, withRequestId, serviceErrorResponse } from "../respond";
import { parseBooleanParam } from "../../_shared/query";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = authenticatedCaller(request);
  if (!auth.ok) return auth.response;
  const { requestId, caller } = auth;
  const { id } = await params;
  const input: Record<string, unknown> = { id };
  // `?full=true` opts out of the slim default (MILESTONES.md #107).
  const full = new URL(request.url).searchParams.get("full");
  if (full !== null) input.full = parseBooleanParam(full);
  try {
    const item = await service.call("get_item", input, { caller });
    return withRequestId(NextResponse.json({ item }), requestId);
  } catch (error) {
    return serviceErrorResponse(error, requestId);
  }
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = authenticatedCaller(request);
  if (!auth.ok) return auth.response;
  const { requestId, caller } = auth;
  const { id } = await params;
  let body: Record<string, unknown>;
  try {
    const parsed = (await request.json()) as unknown;
    body = typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return withRequestId(
      NextResponse.json(
        {
          error: { code: "invalid_input", message: "Request body must be valid JSON.", fields: [] },
        },
        { status: 400 },
      ),
      requestId,
    );
  }

  try {
    const item = await service.call("update_item", { ...body, id }, { caller });
    return withRequestId(NextResponse.json({ item }), requestId);
  } catch (error) {
    return serviceErrorResponse(error, requestId);
  }
}

// `DELETE /api/items/{id}` — `delete_item`, the archive.
//
// **The transport this operation never had.** `restore_item` has had a route
// beside this file since #274, and its own header says "the undo affordance
// is this route's first caller: after an archive, pressing Undo posts here".
// There was no archive to press Undo after: `delete_item` was reachable over
// MCP and the command line and from nowhere a browser could call, so the
// reversibility #274 built could not be exercised by a person at all. This is
// the missing half.
//
// `DELETE` rather than a `POST /archive` beside `restore`: the operation is
// the removal of the row from every ordinary read, which is what the method
// means, and `id` is already the whole address. `restore` gets a named
// subresource because it is an action with no method of its own; this one has
// one.
//
// **A body on a `DELETE`**, which is unusual and deliberate — the exact shape
// `DELETE /items/{id}/loops/{loopId}` beside this already takes, for the same
// reason. `delete_item` requires a `reason`, and requiring it is the point of
// the operation rather than an extra: a query parameter for a sentence of
// prose is worse, and there is nowhere else a caller would find. `reason`,
// `supersededById` and `acknowledgeReferences` all ride in it, and the
// operation's own guards judge them — nothing is validated twice here.
//
// An absent body is passed through as `{}` rather than rejected, so the
// operation's own "a reason is required" refusal is what a caller gets,
// stated in its own words, rather than a shell's generic complaint about a
// missing field. Only a body that is present and unparseable is an error.
export async function DELETE(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = authenticatedCaller(request);
  if (!auth.ok) return auth.response;
  const { requestId, caller } = auth;
  const { id } = await params;

  let body: Record<string, unknown> = {};
  const raw = await request.text();
  if (raw.trim() !== "") {
    try {
      const parsed = JSON.parse(raw) as unknown;
      body =
        typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
    } catch {
      return withRequestId(
        NextResponse.json(
          {
            error: {
              code: "invalid_input",
              message: "Request body must be valid JSON.",
              fields: [],
            },
          },
          { status: 400 },
        ),
        requestId,
      );
    }
  }

  try {
    // The whole envelope, not just the item — `archived` is the only thing
    // that distinguishes "this call archived it" from "it was already
    // archived", and `effect` states in words what the archive means for
    // reads. Slimming either away would leave a caller inferring the outcome
    // from `archivedAt` on a record with thirty fields, which is the exact
    // misreading `DeleteItemOutput` was shaped to prevent.
    const result = await service.call("delete_item", { ...body, id }, { caller });
    return withRequestId(NextResponse.json(result), requestId);
  } catch (error) {
    return serviceErrorResponse(error, requestId);
  }
}
