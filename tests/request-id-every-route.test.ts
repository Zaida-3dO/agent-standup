// Structural proof that request-id correlation is not something a new route
// can quietly opt out of — MILESTONES.md #129.
//
// The behavioural tests prove the mechanism works where it is wired. What
// they cannot see is a route added next month that calls a service operation
// and never resolves an id: nothing would fail, the endpoint would work, and
// its lines would simply be unlabelled and its responses unquotable — the
// exact gap #129 exists to close, reopened one file at a time.
//
// So this walks the route tree and asserts the rule directly, the same shape
// and for the same reason as the other structural checks over
// `src/app/api/**`: a discovered file list rather than an enumerated one, so
// a route that was never added here is caught rather than skipped.
import { readFileSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";

function repoRoot(): string {
  return execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf-8" }).trim();
}

const REPO_ROOT = repoRoot();
const API_DIR = path.resolve(REPO_ROOT, "src/app/api");

/**
 * The routes that legitimately resolve no inbound request id.
 *
 * Written as a narrow, named list rather than a pattern so that adding a
 * route to it is a deliberate act visible in a diff, the same posture
 * `CLI_TRANSPORTS` takes in `session-transport-header.ts`. Each entry needs
 * a reason that is a property of the route, not a note that it has not been
 * done yet.
 */
const EXEMPT: ReadonlyMap<string, "no-service-call" | "own-request-identity"> = new Map([
  // Answer from the process alone — no operation runs, so there is no
  // service line for an id to join.
  ["health/route.ts", "no-service-call"],
  ["hook/script/route.ts", "no-service-call"],
  // Forwards every method to the MCP transport, which mints and logs its own
  // id per *tool call* (`callTool`, `src/lib/mcp/server.ts`) — one HTTP
  // request can carry several. Resolving a second id at this route would
  // label the envelope rather than the calls, which is the wrong grain.
  ["mcp/route.ts", "own-request-identity"],
  // Forwards the browser's call to another route, which resolves and stamps
  // the id itself. The forwarded request carries `X-Request-Id` through
  // untouched and the response's copy is relayed back, so one id already
  // labels both halves. Minting a second here would put a different id on
  // the envelope from the one on the service line it names — two ids for
  // one call, neither findable from the other.
  ["ui/[...path]/route.ts", "own-request-identity"],
]);

function routeFilesUnder(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...routeFilesUnder(full));
    else if (entry.isFile() && entry.name === "route.ts") found.push(full);
  }
  return found;
}

function repoRelative(absolute: string): string {
  return path.relative(API_DIR, absolute).split("\\").join("/");
}

describe("every route that calls the service correlates its request id", () => {
  const routes = routeFilesUnder(API_DIR);

  it("finds the route tree at all", () => {
    // Guards the guard: an empty or mislocated list would make every
    // assertion below vacuously true.
    expect(routes.length).toBeGreaterThan(20);
  });

  it("resolves an inbound id wherever a service operation is called", () => {
    const offenders = routes.filter((file) => {
      const relative = repoRelative(file);
      if (EXEMPT.has(relative)) return false;
      const source = readFileSync(file, "utf-8");
      if (!source.includes("service.call")) return false;
      // Either accessor resolves the id: `authenticatedCaller` is the gated
      // path every routed request takes, and it resolves the id through
      // `httpCaller` internally, so both spellings satisfy the property this
      // test guards. A route using neither has no inbound id at all, which
      // is the thing being caught.
      return !(
        source.includes("authenticatedCaller(request)") || source.includes("httpCaller(request)")
      );
    });

    expect(offenders.map(repoRelative)).toEqual([]);
  });

  it("stamps the id on its success responses, not only its failures", () => {
    // The gap this file exists to close, and one that got past a green unit
    // suite once: `serviceErrorResponse` threading the id made every *error*
    // carry it while every `return NextResponse.json(...)` on the success
    // path returned bare. An id present only on failures is missing exactly
    // when someone is reporting that a *successful* call returned the wrong
    // thing — which is most of "I called X and got Y".
    const offenders = routes.filter((file) => {
      const relative = repoRelative(file);
      if (EXEMPT.has(relative)) return false;
      const source = readFileSync(file, "utf-8");
      // A bare `return NextResponse.json(` is one that was not wrapped.
      return /return\s+NextResponse\.json\(/.test(source);
    });

    expect(offenders.map(repoRelative)).toEqual([]);
  });

  it("hands the resolved caller to the service rather than a bare transport", () => {
    // The failure this catches is subtler than a missing resolver: a route
    // that resolves an id and then passes `{ transport: "http" }` anyway
    // logs a server-minted id while echoing the caller's, so the value the
    // caller is told to quote appears nowhere in the log.
    const offenders = routes.filter((file) => {
      const relative = repoRelative(file);
      if (EXEMPT.has(relative)) return false;
      return readFileSync(file, "utf-8").includes('caller: { transport: "http" }');
    });

    expect(offenders.map(repoRelative)).toEqual([]);
  });

  it("keeps the exemption list honest — no entry has outlived its reason", () => {
    // An exemption that outlived its route, or one whose stated reason has
    // stopped being true, would silently widen the rule.
    for (const [relative, reason] of EXEMPT) {
      const source = readFileSync(path.join(API_DIR, relative), "utf-8");
      if (reason === "no-service-call") {
        expect(
          /\bservice\.call\(/.test(source),
          `${relative} now calls the service and cannot claim it does not`,
        ).toBe(false);
      } else {
        // An `own-request-identity` route is exempt because whatever it
        // hands the request to owns request identity — not because it
        // touches nothing. The exemption is earned only while it actually
        // forwards, so each entry names the call that does the forwarding
        // and the check requires that call to still be there. Listed per
        // route rather than matched loosely: "forwards somewhere" is the
        // claim being audited, so the audit should know where.
        const FORWARDING_CALL: Readonly<Record<string, string>> = {
          "mcp/route.ts": "handleMcpRequest",
          "ui/[...path]/route.ts": "forwardTargetUrl",
        };
        const forwardingCall = FORWARDING_CALL[relative];
        expect(
          forwardingCall,
          `${relative} claims own-request-identity but names no forwarding call`,
        ).toBeDefined();
        expect(
          source.includes(forwardingCall as string),
          `${relative} must forward to a transport that mints its own id to stay exempt`,
        ).toBe(true);
      }
    }
  });
});
