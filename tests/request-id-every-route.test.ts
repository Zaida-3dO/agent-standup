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
      return !source.includes("httpCaller(request)");
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
        // The MCP mount is exempt because the transport it forwards to owns
        // request identity — not because it touches nothing. The exemption
        // is earned only while it actually forwards.
        expect(
          source.includes("handleMcpRequest"),
          `${relative} must forward to a transport that mints its own id to stay exempt`,
        ).toBe(true);
      }
    }
  });
});
