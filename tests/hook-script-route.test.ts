// `GET /api/hook/script?variant=<variant>` as a route —
// `src/app/api/hook/script/route.ts` — MILESTONES.md #125(b).
//
// Driven against a real build in a scratch directory the same way
// `hook-script-store.test.ts` drives `resolveHookScript` directly, but here
// through the actual route handler and a real `Request`/`Response` pair —
// what `hook-route.test.ts` does for `/api/hook` and
// `session-register-route.test.ts` does for `/api/sessions/{id}/register`.
//
// This module has no database dependency, so unlike most files in this
// suite it needs no `TEST_DATABASE_URL` gate.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let scratch: string;

beforeEach(() => {
  scratch = mkdtempSync(path.join(tmpdir(), "hook-script-route-"));
  const dir = path.join(scratch, "dist", "hook-scripts");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "http.js"), "#!/usr/bin/env node\nconsole.log('the http hook');\n");
  vi.spyOn(process, "cwd").mockReturnValue(scratch);
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(scratch, { recursive: true, force: true });
});

async function loadRoute(): Promise<typeof import("@/app/api/hook/script/route")> {
  // Re-imported per test rather than imported once at module scope: the
  // route reads `process.cwd()` at request time (via `resolveHookScript`'s
  // default), not at import time, so a fresh import isn't strictly required
  // for the mock to take effect — but keeping the import inside the test
  // keeps this file's setup order legible without relying on that.
  return import("@/app/api/hook/script/route");
}

describe("GET /api/hook/script", () => {
  it("serves the built script's bytes for a known, built variant", async () => {
    const route = await loadRoute();
    const response = await route.GET(new Request("http://localhost/api/hook/script?variant=http"));

    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toBe("#!/usr/bin/env node\nconsole.log('the http hook');\n");
  });

  it("sets a javascript content-type", async () => {
    const route = await loadRoute();
    const response = await route.GET(new Request("http://localhost/api/hook/script?variant=http"));
    expect(response.headers.get("content-type")).toContain("javascript");
  });

  it("marks the response no-store, so a cache never serves a stale build", async () => {
    const route = await loadRoute();
    const response = await route.GET(new Request("http://localhost/api/hook/script?variant=http"));
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  describe("rejection paths", () => {
    it("REFUSES an unknown variant with 404, not a 200 with empty content", async () => {
      const route = await loadRoute();
      const response = await route.GET(
        new Request("http://localhost/api/hook/script?variant=carrier-pigeon"),
      );

      expect(response.status).toBe(404);
      const body = (await response.json()) as { error: { code: string; fields: string[] } };
      expect(body.error.code).toBe("not_found");
      expect(body.error.fields).toContain("variant");
    });

    it("REFUSES a real HookVariant that has no built script (cli) the same way as an unknown one", async () => {
      // Only http.js was seeded above. `cli` is a real member of
      // HOOK_VARIANTS but this build has never produced a script for it —
      // the route must not treat that differently from a made-up string.
      const route = await loadRoute();
      const response = await route.GET(new Request("http://localhost/api/hook/script?variant=cli"));
      expect(response.status).toBe(404);
    });

    it("REFUSES with 404 when ?variant is missing entirely", async () => {
      const route = await loadRoute();
      const response = await route.GET(new Request("http://localhost/api/hook/script"));

      expect(response.status).toBe(404);
      const body = (await response.json()) as { error: { message: string } };
      expect(body.error.message).toContain("variant");
    });

    it("also marks a 404 response no-store", async () => {
      const route = await loadRoute();
      const response = await route.GET(new Request("http://localhost/api/hook/script?variant=cli"));
      expect(response.headers.get("cache-control")).toBe("no-store");
    });

    it("REFUSES a traversal string with 404, even when it resolves to a real .js file", async () => {
      // Same attack `hook-script-store.test.ts` proves against
      // `resolveHookScript` directly, exercised through the real route a
      // caller actually reaches — a sibling `.js` file the traversal
      // string's `..` segments walk straight to.
      const outsideDir = path.join(scratch, "dist", "bin");
      mkdirSync(outsideDir, { recursive: true });
      writeFileSync(
        path.join(outsideDir, "standup.js"),
        "#!/usr/bin/env node\nconsole.log('reachable');\n",
      );

      const route = await loadRoute();
      const response = await route.GET(
        new Request(
          `http://localhost/api/hook/script?variant=${encodeURIComponent("../bin/standup")}`,
        ),
      );

      expect(response.status).toBe(404);
    });
  });
});
