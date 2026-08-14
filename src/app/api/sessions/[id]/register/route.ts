// The HTTP adapter's registration handshake — SCHEMA.md §19
// `POST /sessions/{id}/register`, MILESTONES.md #43.
//
// Thin shell over `service.call`, like every other route here: read the
// body, call one operation, render the result. It opens no transaction,
// resolves no settings, imports no database client, and — importantly —
// makes no judgement about the version it is reporting. Which hook variant
// the reply describes and whether the session may claim are both decided by
// `register_session` in the service layer, so the command line's answer to
// the same registration is the same answer.
//
// **`transport: "http"` is stamped here and cannot be overridden by the
// body.** The session id comes from the path and the transport from this
// module; the body carries only what the session knows about itself. That
// ordering matters: `{ ...body, sessionId }` puts the path's id last so a
// body claiming a different `sessionId` cannot register a session other than
// the one the URL names, and the caller option is a separate argument the
// body cannot reach at all — which is what makes the transport a capability
// signal rather than a self-report (§21).
import { NextResponse } from "next/server";
import { service } from "@/lib/service/live";
import { invalidJsonResponse, serviceErrorResponse } from "../../../_shared/respond";
import { CLI_TRANSPORT_HEADER, transportForHttpRequest } from "@/lib/session-transport-header";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return invalidJsonResponse();
  }

  try {
    const registration = await service.call(
      "register_session",
      { ...(typeof body === "object" && body !== null ? body : {}), sessionId: id },
      {
        caller: {
          // `http` unless the command line's own binding stamped itself —
          // see `session-transport-header.ts` for why an unauthenticated
          // header is acceptable here and what it cannot be used to claim.
          transport: transportForHttpRequest(request.headers.get(CLI_TRANSPORT_HEADER)),
          sessionId: id,
        },
      },
    );
    return NextResponse.json({ registration });
  } catch (error) {
    return serviceErrorResponse(error);
  }
}
