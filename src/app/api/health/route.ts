import { NextResponse } from "next/server";

// Liveness check. Deliberately doesn't touch the database — a slow or down
// DB shouldn't make the process report unhealthy, it should surface as its
// own alert. Deeper readiness checks (DB round-trip, migration state) can
// land as a separate route once something actually consumes them.
export async function GET() {
  return NextResponse.json({
    status: "ok",
    timestamp: new Date().toISOString(),
  });
}
