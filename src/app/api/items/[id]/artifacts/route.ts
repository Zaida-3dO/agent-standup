// The HTTP adapter's `GET` and `POST /items/{id}/artifacts` endpoints
// (SCHEMA.md §6, §19). Lists the artifacts recorded against the item named in
// the path, and records one. Thin shells over `service.call`.
//
// The read sits on the same path as the write rather than under a name of its
// own, because it is the same collection: `GET` lists what `POST` appends to.
// It exists because `get_item_artifacts` had no route at all — it was
// reachable on MCP and nowhere else — and a command bound to it would
// otherwise work on `--direct` and fail over the API, which is the binding
// divergence `tests/cli-http-binding.test.ts` exists to prevent.
//
// Item-scoped rather than a bare `/artifacts` collection, following
// `items/{id}/notes` — an artifact has no meaning apart from the item it was
// produced for, so the item belongs in the path where it cannot be omitted.
//
// Uses the shared `_shared/respond.ts` (not the sibling `items/respond.ts`)
// for the same reason `claims/`, `checkpoints/` and `items/{id}/notes` do —
// see `_shared/respond.ts`'s header.
import { NextResponse } from "next/server";
import { service } from "@/lib/service/live";
import {
  authenticatedCaller,
  withRequestId,
  invalidJsonResponse,
  serviceErrorResponse,
} from "../../../_shared/respond";
import { parseBooleanParam } from "../../../_shared/query";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = authenticatedCaller(request);
  if (!auth.ok) return auth.response;
  const { requestId, caller } = auth;
  const { id } = await params;
  const url = new URL(request.url);

  // Only parameters actually present are forwarded. Sending a key the caller
  // did not ask for would overwrite the schema's own default with this
  // adapter's idea of one, which is the drift §22 rules out — the schema
  // decides the absent case, here as everywhere.
  const input: Record<string, unknown> = { id };
  const artifactId = url.searchParams.get("artifactId");
  if (artifactId !== null) input.artifactId = artifactId;
  const kind = url.searchParams.get("kind");
  if (kind !== null) input.kind = kind;
  const cursor = url.searchParams.get("cursor");
  if (cursor !== null) input.cursor = cursor;
  const full = url.searchParams.get("full");
  if (full !== null) input.full = parseBooleanParam(full);
  const limit = url.searchParams.get("limit");
  // Left as the string the query gave when it is not a number, so the
  // schema refuses it and names the field, rather than this route turning
  // `?limit=lots` into NaN and refusing something the caller never typed.
  if (limit !== null) input.limit = Number.isNaN(Number(limit)) ? limit : Number(limit);

  try {
    const result = await service.call("get_item_artifacts", input, { caller });
    return withRequestId(NextResponse.json(result), requestId);
  } catch (error) {
    return serviceErrorResponse(error, requestId);
  }
}

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const auth = authenticatedCaller(request);
  if (!auth.ok) return auth.response;
  const { requestId, caller } = auth;
  const { id } = await params;
  let body: Record<string, unknown>;
  try {
    const parsed = (await request.json()) as unknown;
    body = typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return invalidJsonResponse(requestId);
  }

  try {
    const artifact = await service.call("record_artifact", { ...body, itemId: id }, { caller });
    // `createdAt` is a `Date`; everything else the operation returns is a
    // string, a number or null. There is no bigint in this shape — unlike an
    // appended event, whose `id`/`txId` need `serializeAppendedEvent` — so
    // the row serialises as-is apart from the timestamp.
    return withRequestId(
      NextResponse.json(
        { artifact: { ...artifact, createdAt: artifact.createdAt.toISOString() } },
        { status: 201 },
      ),
      requestId,
    );
  } catch (error) {
    return serviceErrorResponse(error, requestId);
  }
}
