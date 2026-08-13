import { NextResponse } from "next/server";
import { isBackfillEnabled } from "@/lib/backfill/enabled";

// Liveness check. Deliberately doesn't touch the database — a slow or down
// DB shouldn't make the process report unhealthy, it should surface as its
// own alert. Deeper readiness checks (DB round-trip, migration state) can
// land as a separate route once something actually consumes them.
//
// `backfillEnabled` is reported here for one reason: backfill is meant to
// be open for a window and then closed, and the realistic failure is not an
// attacker but somebody opening it, being interrupted, and never closing
// it. Answering "is it on right now?" over the same endpoint a monitor
// already polls means nobody has to shell into the container to find out.
// It reports a boolean, never the variable's value — a health endpoint that
// echoed raw environment strings would be a different kind of mistake.
export async function GET() {
  return NextResponse.json({
    status: "ok",
    backfillEnabled: isBackfillEnabled(),
    timestamp: new Date().toISOString(),
  });
}
