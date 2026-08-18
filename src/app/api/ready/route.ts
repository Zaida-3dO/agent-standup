// `GET /api/ready` — readiness, as distinct from the liveness `/api/health`
// answers. MILESTONES.md #133.
//
// The two are deliberately separate routes rather than one route with a
// query parameter or a richer body. Their consumers are different processes
// with different reactions: a restart policy reads liveness and kills the
// container when it fails, while a deployment gate, a compose `depends_on`
// condition and a load balancer read readiness and merely wait. Collapsing
// them means one of those two is reading an answer to the other's question,
// and the failure is silent in both directions — a restart loop on a
// database blip, or traffic sent to a process that cannot serve it.
//
// ── Unauthenticated, and deliberately so ────────────────────────────────
//
// Every other route on this server requires a bearer token. This one does
// not, because the things that ask it are the things that run *before* an
// installation is configured: an orchestrator's startup probe, a compose
// healthcheck, a load balancer's backend check. None of them holds a
// credential, and requiring one would mean readiness could never go green
// on a host whose tokens were mistyped — turning a configuration mistake
// into a deployment that hangs with no useful signal.
//
// What that costs is bounded by what the response says, which is why the
// body is counts and booleans and nothing else. It names no machine, no
// item, no setting and no version; it reveals that a server exists at an
// address, which is already evident from its answering at all.
import { NextResponse } from "next/server";
import { service } from "@/lib/service/live";
import { httpCaller, withRequestId } from "../_shared/respond";
import { log } from "@/lib/log";

export async function GET(request: Request) {
  // `httpCaller` rather than `authenticatedCaller`: this route serves
  // unauthenticated probes deliberately (see the header), but it still
  // resolves and echoes an inbound request id like every other route, so a
  // failing probe can be found in the log by the id its caller saw.
  const { requestId, caller } = httpCaller(request);

  try {
    const result = await service.call("readiness", {}, { caller });

    // A reachable database with a half-applied migration is a 503 too. The
    // status is what a probe acts on — most will never parse the body — so
    // a state that is not safe to send traffic to must not answer 200
    // merely because the connection opened.
    const status = result.ready ? 200 : 503;
    return withRequestId(NextResponse.json(result, { status }), requestId);
  } catch (error) {
    // Not ready, and that is an ordinary answer rather than a fault: an
    // unreachable database during startup is the exact state this route
    // exists to report. So it renders 503 with the same body shape as the
    // success case rather than the error envelope every other route uses —
    // a probe should not have to parse two different bodies to learn one
    // fact, and `ready: false` is the fact.
    //
    // Logged rather than returned in detail: the cause is what an operator
    // needs and is also the one part that could name a host or a
    // connection string, which is not something an unauthenticated route
    // may hand out.
    log.warn("Readiness probe failed.", { transport: "http", requestId, err: error });
    return withRequestId(
      NextResponse.json(
        { ready: false, database: false, migrationsApplied: 0, migrationsPending: 0 },
        { status: 503 },
      ),
      requestId,
    );
  }
}
