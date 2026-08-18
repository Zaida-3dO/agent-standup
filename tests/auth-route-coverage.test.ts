// Structural proof that the authentication gate is not something a route
// can forget.
//
// The per-route behaviour is tested elsewhere (`tests/auth-http-routes.test.ts`)
// by calling handlers and asserting on the refusal. This file asserts the
// property that makes those tests worth trusting: that **every** route
// passes through the gate, including ones written after this file was.
//
// A test that checked three routes by hand would go green for a fourth that
// authenticated nothing, which is precisely the failure mode — the gap is
// never in the route somebody was thinking about. So this reads the route
// tree from disk and requires each file to obtain its caller through
// `authenticatedCaller`, with the exceptions named and argued below rather
// than discovered.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";

/** The real, git-tracked repo root — see `claims-routes-thin-shell.test.ts`. */
function repoRoot(): string {
  return execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf-8" }).trim();
}

const REPO_ROOT = repoRoot();
const API_ROOT = path.resolve(REPO_ROOT, "src/app/api");

/**
 * Routes that deliberately serve unauthenticated requests.
 *
 * Each entry is a decision with a reason, and the list is asserted to be
 * exactly this long — a new unauthenticated route cannot be added without
 * editing this file, which is the point. An allowlist that grew silently
 * would be a gate that could be opened by adding a file.
 */
const UNAUTHENTICATED: ReadonlyMap<string, string> = new Map([
  [
    "health/route.ts",
    "Liveness. Its consumer is a restart policy, which must be able to tell a live process " +
      "from a dead one on a host whose tokens are misconfigured — requiring a credential " +
      "would turn a configuration mistake into a crash loop.",
  ],
  [
    "ready/route.ts",
    "Readiness. Asked by deployment gates, compose conditions and load balancers, none of " +
      "which holds a credential, and asked before an installation is configured. Its body is " +
      "counts and booleans naming nothing.",
  ],
  [
    "hook/script/route.ts",
    "Serves the built hook script to a machine that is being set up. A session fetches it " +
      "during the registration handshake, which is the moment before it has been configured " +
      "with anything; it returns a build artefact that ships in the public image and holds " +
      "no installation state.",
  ],
  [
    "mcp/route.ts",
    "Authenticates, but not through `authenticatedCaller`: it is an MCP mount rather than a " +
      "REST route, so it calls `authenticate` directly and passes the proven machine into " +
      "the MCP identity. Asserted separately below.",
  ],
  [
    "sessions/[id]/register/route.ts",
    "Reads only a request id from `httpCaller` and authenticates separately — asserted below.",
  ],
]);

/** Every `route.ts` under the API tree, as a path relative to it. */
function routeFiles(dir: string, prefix = ""): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const relative = prefix ? `${prefix}/${entry}` : entry;
    if (statSync(full).isDirectory()) {
      found.push(...routeFiles(full, relative));
    } else if (entry === "route.ts") {
      found.push(relative);
    }
  }
  return found;
}

const ROUTES = routeFiles(API_ROOT);

function read(relative: string): string {
  return readFileSync(path.join(API_ROOT, relative), "utf-8");
}

/**
 * Blanks out comments, preserving every byte's position.
 *
 * Replacing rather than deleting keeps the offsets of the surviving code
 * unchanged, which matters because the ordering assertion below compares
 * two indices into this string. Characters are swapped for spaces (and
 * newlines kept) so the result is the same length as the input.
 */
function withoutComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, (match) => match.replace(/[^\n]/g, " "))
    .replace(/\/\/[^\n]*/g, (match) => " ".repeat(match.length));
}

describe("every API route passes through the authentication gate", () => {
  it("finds the route tree at all", () => {
    // Guards the whole file: a scanner that silently found nothing would
    // pass every assertion below by vacuous truth.
    expect(ROUTES.length).toBeGreaterThan(40);
  });

  it.each(ROUTES.filter((route) => !UNAUTHENTICATED.has(route)))(
    "%s obtains its caller through authenticatedCaller",
    (route) => {
      const source = read(route);

      expect(source).toContain("authenticatedCaller(request)");
      // The refusal must be returned, not merely computed. A route that
      // called the gate and ignored the answer would satisfy the line above.
      expect(source).toContain("if (!auth.ok) return auth.response;");
    },
  );

  it.each(ROUTES.filter((route) => !UNAUTHENTICATED.has(route)))(
    "%s does not reach the service without having authenticated",
    (route) => {
      // Comments are stripped first. Several routes name the operation they
      // wrap in their header — `service.call("mark_event_seen", …)` — and a
      // position compared against prose would report an ordering violation
      // that does not exist in the code.
      const source = withoutComments(read(route));
      const gate = source.indexOf("if (!auth.ok) return auth.response;");
      const firstServiceCall = source.indexOf("service.call(");

      expect(gate).toBeGreaterThan(-1);
      expect(firstServiceCall).toBeGreaterThan(gate);
    },
  );

  it("the MCP mount authenticates and refuses before serving", () => {
    const source = read("mcp/route.ts");

    expect(source).toContain("authenticate(request)");
    expect(source).toContain("if (!auth.ok) return unauthenticatedResponse(auth.reason);");
    // The proven machine is handed to the MCP core rather than a header value.
    expect(source).toContain("auth.machine.machine");
    // And it happens before the request reaches the protocol layer.
    expect(source.indexOf("authenticate(request)")).toBeLessThan(
      source.indexOf("handleMcpRequest("),
    );
  });

  it("the session registration route authenticates", () => {
    const source = read("sessions/[id]/register/route.ts");

    expect(source).toContain("authenticate");
  });

  it("holds the unauthenticated list to exactly the routes argued for", () => {
    // The assertion that keeps the allowlist from absorbing a new route.
    // If this fails, a route was added to the map above — which is allowed,
    // but only deliberately, with a reason, in a diff someone reads.
    expect([...UNAUTHENTICATED.keys()].sort()).toEqual(
      [
        "health/route.ts",
        "hook/script/route.ts",
        "mcp/route.ts",
        "ready/route.ts",
        "sessions/[id]/register/route.ts",
      ].sort(),
    );
  });

  it("every unauthenticated route carries a real reason", () => {
    for (const [route, reason] of UNAUTHENTICATED) {
      expect(reason.length, `${route} needs a reason worth reading`).toBeGreaterThan(60);
    }
  });

  it("every route named in the unauthenticated list actually exists", () => {
    // Otherwise an entry outlives the file it excused and silently covers
    // nothing — the same failure a stale waiver has.
    for (const route of UNAUTHENTICATED.keys()) {
      expect(ROUTES, `${route} is listed but not on disk`).toContain(route);
    }
  });
});
