// The artefact `GET /api/hook/script` actually serves —
// `dist/hook-scripts/http.js`, produced by `scripts/build-hook-scripts.mjs`
// — MILESTONES.md #125(b).
//
// `tests/hook-built-script.test.ts` covers `dist/bin/standup-hook.js`, the
// *split* build (`splitting: true`) used for the published npm package,
// where an entry point importing hashed chunk files beside it is correct —
// see `build-cli.mjs`'s header for why. This is a **different file**: the
// one at `dist/hook-scripts/http.js` has to work as a single download with
// nothing else beside it, because that is the entire point of serving it
// over one URL rather than a directory. If `buildHookScripts` regressed to
// `splitting: true`, or to referencing anything outside its own file, this
// is what would catch it — the source-level tests for the same script
// (`hook-run.test.ts`, `hook-decide.test.ts`, …) exercise the *logic*
// against the TypeScript, never the built artefact, so none of them would
// notice a build that only breaks once bundled standalone.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { HOOK_SCRIPTS_DIR, HOOK_SCRIPT_ENTRY_POINTS } from "../scripts/build-cli.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..");
// `dist/` (and `dist/hook-scripts/`) is built once for the whole run by
// `tests/helpers/global-setup.ts` — see that file's header for why building
// it per test file would race.
const servedHttpScript = path.join(repoRoot, HOOK_SCRIPTS_DIR, "http.js");

describe("the servable hook artefact (dist/hook-scripts/http.js)", () => {
  it("exists at the path the route reads, with a node shebang", () => {
    expect(existsSync(servedHttpScript)).toBe(true);
    expect(readFileSync(servedHttpScript, "utf8").split("\n")[0]).toBe("#!/usr/bin/env node");
  });

  it("declares exactly the variants this build has scripts for", () => {
    expect(Object.keys(HOOK_SCRIPT_ENTRY_POINTS)).toEqual(["http"]);
  });

  it("runs standalone — no import of a file outside itself", () => {
    // `bundle: true, splitting: false` (build-hook-scripts.mjs) should leave
    // nothing to resolve at runtime beyond Node's own builtins and
    // `packages: "external"` node_modules deps — never a sibling chunk file,
    // which is exactly what a split build would produce and what this file
    // exists to rule out.
    const stdout = execFileSync(process.execPath, [servedHttpScript, "--protocol-version"], {
      cwd: repoRoot,
      encoding: "utf8",
      env: { ...process.env, STANDUP_URL: "" },
    });
    expect(stdout.trim()).toMatch(/^\d+$/);
  });

  it("allows on an ordinary tool call, run from a directory with no dist/ beside it", () => {
    // Run from the OS temp directory rather than the repo root, so a
    // (re-introduced) relative import outside the bundle would fail to
    // resolve instead of accidentally finding the real dist/ tree next door.
    const stdout = execFileSync(process.execPath, [servedHttpScript], {
      cwd: tmpdir(),
      input: JSON.stringify({
        hook_event_name: "PreToolUse",
        session_id: "s-1",
        tool_name: "Bash",
        tool_input: { command: "git status" },
      }),
      encoding: "utf8",
      env: { ...process.env, STANDUP_URL: "" },
    });
    expect(stdout).toBe("");
  });
});
