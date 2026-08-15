// `resolveHookScript` (`src/lib/hook/script-store.ts`) — MILESTONES.md
// #125(b): the module `GET /api/hook/script` reads a built hook artefact
// through.
//
// Driven against a scratch directory rather than the real `dist/`, via the
// injectable `repoRoot` — so this file does not depend on
// `scripts/build-hook-scripts.mjs` having run, and can assert the "known
// variant, nothing built for it yet" case without deleting a real build.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveHookScript } from "@/lib/hook-script-store";

let scratch: string;

beforeEach(() => {
  scratch = mkdtempSync(path.join(tmpdir(), "hook-script-store-"));
});

afterEach(() => {
  rmSync(scratch, { recursive: true, force: true });
});

/** Writes a fake built script at the path `resolveHookScript` looks for. */
function seedScript(variant: string, contents = "// fake built script\n"): void {
  const dir = path.join(scratch, "dist", "hook-scripts");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, `${variant}.js`), contents);
}

describe("resolveHookScript", () => {
  it("returns the built script's bytes for a variant that has one", () => {
    seedScript("http", "// the http hook\n");

    const result = resolveHookScript({ variant: "http", repoRoot: scratch });

    expect(result).toBeDefined();
    expect(result?.variant).toBe("http");
    expect(result?.contents.toString("utf8")).toBe("// the http hook\n");
  });

  it("returns the raw bytes unmodified, including a shebang line", () => {
    seedScript("http", "#!/usr/bin/env node\nconsole.log('hi');\n");

    const result = resolveHookScript({ variant: "http", repoRoot: scratch });

    expect(result?.contents.toString("utf8")).toBe("#!/usr/bin/env node\nconsole.log('hi');\n");
  });

  describe("rejection paths", () => {
    it("REFUSES a string that is not a real HookVariant at all", () => {
      seedScript("http");
      const result = resolveHookScript({ variant: "carrier-pigeon", repoRoot: scratch });
      expect(result).toBeUndefined();
    });

    it("REFUSES a real HookVariant with no script built for it yet", () => {
      // `cli` is a member of HOOK_VARIANTS (SCHEMA.md §21's hook_variant
      // column names it) but this repository has never built a script for
      // it — only `http` has an entry in HOOK_SCRIPT_ENTRY_POINTS. This is
      // the case the module's header calls out explicitly: a known slot
      // that is nonetheless empty must answer the same as an unknown one.
      seedScript("http"); // some other variant exists — proves this isn't "nothing was built at all"
      const result = resolveHookScript({ variant: "cli", repoRoot: scratch });
      expect(result).toBeUndefined();
    });

    it("REFUSES a non-string value (what a caller with no query param actually sends)", () => {
      seedScript("http");
      expect(resolveHookScript({ variant: null, repoRoot: scratch })).toBeUndefined();
      expect(resolveHookScript({ variant: undefined, repoRoot: scratch })).toBeUndefined();
      expect(resolveHookScript({ variant: 42, repoRoot: scratch })).toBeUndefined();
    });

    it("REFUSES when the whole dist/hook-scripts directory does not exist", () => {
      // Nothing seeded at all — the pre-build state.
      const result = resolveHookScript({ variant: "http", repoRoot: scratch });
      expect(result).toBeUndefined();
    });

    it("REFUSES a traversal string even when it would resolve to a real .js file", () => {
      // The allowlist (`isHookVariant`) is the *only* thing standing between
      // a caller and an arbitrary `.js` read — `path.join` happily walks
      // `..` segments, and `existsSync`/`readFileSync` have no opinion about
      // where the resolved path ends up. So this seeds a real `.js` file
      // *outside* `dist/hook-scripts` (a sibling directory, the shape a
      // bundler's own output tree actually has) and proves a traversal
      // string that would resolve straight to it is still refused. If the
      // allowlist check were ever removed or reordered after the
      // `existsSync` check, this file existing would make the naive read
      // succeed — that is exactly the failure this test exists to catch.
      const outsideDir = path.join(scratch, "dist", "bin");
      mkdirSync(outsideDir, { recursive: true });
      writeFileSync(
        path.join(outsideDir, "standup.js"),
        "#!/usr/bin/env node\nconsole.log('reachable');\n",
      );

      expect(resolveHookScript({ variant: "../bin/standup", repoRoot: scratch })).toBeUndefined();
      expect(resolveHookScript({ variant: "..\\bin\\standup", repoRoot: scratch })).toBeUndefined();
    });

    it("does not read a file for a directory of the same name as a variant", () => {
      // A directory named "http.js" passes a naive `existsSync` check and
      // would throw `EISDIR` on `readFileSync` — this asserts the function
      // still reports "nothing to send" (`undefined`) rather than throwing,
      // matching this module's documented "never throws" contract.
      const dir = path.join(scratch, "dist", "hook-scripts");
      mkdirSync(path.join(dir, "http.js"), { recursive: true });
      expect(resolveHookScript({ variant: "http", repoRoot: scratch })).toBeUndefined();
    });
  });

  it("defaults repoRoot to the current working directory when not given", () => {
    // Not asserting a specific result — cwd during a test run is the repo
    // root, so this only proves the parameter is truly optional and the
    // function does not throw when it is omitted.
    expect(() => resolveHookScript({ variant: "http" })).not.toThrow();
  });
});
