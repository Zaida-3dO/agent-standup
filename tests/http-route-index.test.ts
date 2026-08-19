// The route index served by `GET /api`, and the mechanism that keeps it
// from drifting away from the routes it claims to enumerate.
//
// The load-bearing claim of this whole feature is not "an index exists" — it
// is "the index cannot silently go stale". A hand-maintained route list that
// drifts is worse than no list at all, because a caller has no reason to
// doubt it: an absent path reads as deleted, and a moved one sends them
// looking in the wrong place. So the assertions below are weighted towards
// the staleness check rather than the happy path, and the central test
// deliberately *introduces* drift and requires the check to fail on it. A
// check that has never been observed failing is not known to be a check.
import {
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { HTTP_ROUTES } from "@/lib/http-routes.generated";

/** Every `route.ts` under `dir`, walked from the filesystem. */
function routeFilesOnDisk(dir: string, prefix = ""): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    const relative = prefix ? `${prefix}/${entry}` : entry;
    if (statSync(full).isDirectory()) {
      found.push(...routeFilesOnDisk(full, relative));
    } else if (entry === "route.ts") {
      found.push(relative);
    }
  }
  return found;
}

/** The real, git-tracked repo root — see `claims-routes-thin-shell.test.ts`. */
function repoRoot(): string {
  return execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf-8" }).trim();
}

const REPO_ROOT = repoRoot();
const GENERATOR = path.join(REPO_ROOT, "scripts", "generate-http-routes.mjs");
const API_ROOT = path.join(REPO_ROOT, "src", "app", "api");

/**
 * Runs the generator's `--check` mode and reports how it exited.
 *
 * `cwd` is a parameter so the drift test can point it at a throwaway copy of
 * the tree rather than mutating the real one — a test that added a route
 * file to `src/app/api` and crashed before cleaning up would leave the
 * working tree broken.
 */
function runCheck(root: string): { ok: boolean; output: string } {
  try {
    // The generator resolves the route tree and the output file relative to
    // **its own location**, not to `cwd` — so a scratch tree must be checked
    // by the *copy of the generator inside it*, not by the real one with
    // `cwd` pointed elsewhere. Getting this wrong is not a harmless slip: it
    // silently makes every drift test below re-check the real repository,
    // which is green, so all three passed while asserting nothing. That is
    // exactly the hollow-test shape these tests exist to disprove, and it
    // took a deliberate "does this fail when it should?" run to catch.
    const output = execFileSync(
      process.execPath,
      [path.join(root, "scripts", "generate-http-routes.mjs"), "--check"],
      {
        cwd: root,
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    return { ok: true, output };
  } catch (error) {
    const e = error as { stdout?: string; stderr?: string };
    return { ok: false, output: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

/**
 * Copies the real route tree, the generator and the committed index into a
 * scratch directory, so a drift test can mutate a tree without touching the
 * working copy.
 *
 * Copies from **disk** rather than from git's index, for the same reason the
 * count assertion reads disk: an uncommitted route is still a route, and a
 * scratch tree missing one would compare the generator's output against a
 * different tree than the committed index describes — which is exactly how
 * both drift tests below first passed while asserting nothing at all.
 */
function scratchTree(prefix: string): string {
  const scratch = mkdtempSync(path.join(tmpdir(), prefix));
  mkdirSync(path.join(scratch, "scripts"), { recursive: true });
  mkdirSync(path.join(scratch, "src", "lib"), { recursive: true });

  for (const relative of routeFilesOnDisk(API_ROOT)) {
    const target = path.join(scratch, "src", "app", "api", relative);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, readFileSync(path.join(API_ROOT, relative), "utf-8"));
  }
  writeFileSync(
    path.join(scratch, "scripts", "generate-http-routes.mjs"),
    readFileSync(GENERATOR, "utf-8"),
  );
  writeFileSync(
    path.join(scratch, "src", "lib", "http-routes.generated.ts"),
    readFileSync(path.join(REPO_ROOT, "src", "lib", "http-routes.generated.ts"), "utf-8"),
  );
  return scratch;
}

describe("the generated route index", () => {
  it("lists every route file under the API tree", () => {
    // Discovered from disk rather than from a number written here: a
    // hard-coded count would need editing on every route added, which is
    // the maintenance burden this whole mechanism exists to avoid.
    //
    // Read from the filesystem, deliberately not from `git ls-files`: a
    // route file written but not yet committed is still a route the server
    // serves, and an index ignoring it would be exactly as wrong as one gone
    // stale. This bit for real — the index route itself was uncommitted when
    // this test first ran, and the git-based assertion under-counted by one.
    const onDisk = routeFilesOnDisk(API_ROOT);

    expect(onDisk.length).toBeGreaterThan(40);
    expect(HTTP_ROUTES).toHaveLength(onDisk.length);
  });

  it("serves itself, so the index is reachable from its own contents", () => {
    expect(HTTP_ROUTES.find((r) => r.path === "/api")?.methods).toEqual(["GET"]);
  });

  it("records the real methods for a route that serves two", () => {
    // `/api/items` is GET (list) and POST (create). A generator that
    // recorded only the first export it found would report one.
    expect(HTTP_ROUTES.find((r) => r.path === "/api/items")?.methods).toEqual(["GET", "POST"]);
  });

  it("records methods declared by assignment, not just by function", () => {
    // The MCP mount writes `export const POST = serve`. This was a real
    // miss on the generator's first run — it reported the route as serving
    // nothing — so it is asserted rather than assumed.
    expect(HTTP_ROUTES.find((r) => r.path === "/api/mcp")?.methods).toEqual([
      "GET",
      "POST",
      "DELETE",
    ]);
  });

  it("renders dynamic segments as named parameters", () => {
    expect(HTTP_ROUTES.some((r) => r.path === "/api/items/{id}")).toBe(true);
    // A catch-all is marked as one. A caller told `/api/ui/{path}` would
    // reasonably send a single segment.
    expect(HTTP_ROUTES.some((r) => r.path === "/api/ui/{path...}")).toBe(true);
  });

  it("lists the retype route a failed session had to guess at", () => {
    // The concrete regression. `POST /api/items/{id}/retype-to-task` was
    // invented after `/api/items` was found to work; the real route was one
    // guess away and nothing announced it.
    expect(HTTP_ROUTES.find((r) => r.path === "/api/items/{id}/retype")?.methods).toEqual(["POST"]);
    expect(HTTP_ROUTES.some((r) => r.path === "/api/items/{id}/retype-to-task")).toBe(false);
  });

  it("names no path that is not under /api", () => {
    for (const route of HTTP_ROUTES) {
      expect(route.path.startsWith("/api")).toBe(true);
      // Brackets are the Next.js source spelling and must not leak into a
      // path a caller reads as literal.
      expect(route.path).not.toContain("[");
    }
  });

  it("carries at least one method for every route it lists", () => {
    // A listed path serving nothing would advertise a 404 — the exact
    // failure the index exists to prevent, arriving from the other side.
    for (const route of HTTP_ROUTES) {
      expect(route.methods.length, `${route.path} lists no methods`).toBeGreaterThan(0);
    }
  });
});

describe("the staleness check", () => {
  it("passes against the committed tree", () => {
    expect(runCheck(REPO_ROOT).ok).toBe(true);
  });

  it("fails when a route exists that the committed index does not list", () => {
    // The test that makes the drift-proofing claim real rather than merely
    // asserted. A new route is added to a *copy* of the tree, and the check
    // must reject it and name the command that fixes it.
    //
    // The route added is the exact one a session invented — so this also
    // pins the shape of the original failure: had `retype-to-task` ever
    // really been added, the index would have been required to say so.
    const scratch = scratchTree("route-index-drift-");
    try {
      const invented = path.join(scratch, "src", "app", "api", "items", "[id]", "retype-to-task");
      mkdirSync(invented, { recursive: true });
      writeFileSync(
        path.join(invented, "route.ts"),
        "export async function POST(request: Request) {\n  return new Response(null);\n}\n",
      );

      const result = runCheck(scratch);
      expect(result.ok, "the check passed against a tree with an unlisted route").toBe(false);
      // The refusal has to say what to do, or it costs a round trip to
      // discover a command the thing refusing already knew.
      expect(result.output).toContain("generate:http-routes");
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("fails when the committed index lists a route the tree does not serve", () => {
    // The other direction of drift, and the more dangerous one for a
    // caller: an index naming a deleted path sends them to a 404 while
    // asserting it should work.
    const scratch = scratchTree("route-index-ghost-");
    try {
      const generated = path.join(scratch, "src", "lib", "http-routes.generated.ts");
      writeFileSync(
        generated,
        readFileSync(generated, "utf-8").replace(
          '  { path: "/api/board", methods: ["GET"] },',
          '  { path: "/api/board", methods: ["GET"] },\n  { path: "/api/ghost", methods: ["GET"] },',
        ),
      );

      const result = runCheck(scratch);
      expect(
        result.ok,
        "the check passed against an index naming a route that does not exist",
      ).toBe(false);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("regenerating a drifted tree makes the check pass again", () => {
    // Closes the loop: the check does not merely fail on drift, it fails on
    // drift that the documented command actually resolves. A check whose
    // remedy did not work would be a wall, not a gate.
    const scratch = scratchTree("route-index-repair-");
    try {
      const added = path.join(scratch, "src", "app", "api", "invented-probe");
      mkdirSync(added, { recursive: true });
      writeFileSync(
        path.join(added, "route.ts"),
        "export async function GET(request: Request) {\n  return new Response(null);\n}\n",
      );
      expect(runCheck(scratch).ok).toBe(false);

      execFileSync(process.execPath, [path.join(scratch, "scripts", "generate-http-routes.mjs")], {
        cwd: scratch,
        encoding: "utf-8",
      });

      expect(runCheck(scratch).ok).toBe(true);
      expect(
        readFileSync(path.join(scratch, "src", "lib", "http-routes.generated.ts"), "utf-8"),
      ).toContain('"/api/invented-probe"');
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});

describe("the index route itself", () => {
  const source = readFileSync(path.join(API_ROOT, "route.ts"), "utf-8");

  it("authenticates like every other route", () => {
    // Also enforced structurally by `auth-route-coverage.test.ts`, which
    // discovers this file from disk. Asserted here too because this route's
    // whole purpose is to be easy to reach, and "easy to reach" is one
    // careless edit away from "reachable without a token".
    expect(source).toContain("authenticatedCaller(request)");
    expect(source).toContain("if (!auth.ok) return auth.response;");
  });

  it("serves the generated list rather than a list of its own", () => {
    expect(source).toContain("HTTP_ROUTES");
    // A literal route path written into the handler would be the beginning
    // of the hand-maintained copy this design exists to avoid.
    expect(source).not.toMatch(/path:\s*"\/api\//);
  });

  it("tells a caller that a missing path is absent rather than undocumented", () => {
    // The sentence that converts "I could not find it" into "it does not
    // exist", which is the difference between one call and thirty-nine.
    expect(source).toContain("does not exist");
  });
});
