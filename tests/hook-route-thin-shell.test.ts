// Structural proof for SCHEMA.md §22's "every way in … is a thin shell over
// one service call" and "only the service layer, the settings resolver, and
// migrations and seeds may import the database client" — applied to
// `src/app/api/hook/**` (MILESTONES.md #41).
//
// Same scanner as tests/claims-routes-thin-shell.test.ts (row #29), pointed
// at this row's own directory instead. See that file's header for why this
// imports `findViolations` from `check-db-import-allowlist.mjs` rather than
// re-deriving the resolver, and why `repoRoot()` uses `git rev-parse`
// instead of `import.meta.dirname` (Stryker's sandboxed mutation run has no
// `.git` of its own but still resolves the real root through it).
import { readFileSync, readdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { findViolations } from "../scripts/check-db-import-allowlist.mjs";

function repoRoot(): string {
  return execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf-8" }).trim();
}

const REPO_ROOT = repoRoot();
const SCANNED_DIR = path.resolve(REPO_ROOT, "src/app/api/hook");

function toPosix(p: string): string {
  return p.split("\\").join("/");
}

function tsFilesUnder(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...tsFilesUnder(full));
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      files.push(full);
    }
  }
  return files;
}

function repoRelative(absolutePath: string): string {
  return toPosix(path.relative(REPO_ROOT, absolutePath));
}

describe("the hook route never imports the database client directly", () => {
  it("every real file under src/app/api/hook imports no database client", () => {
    const files = tsFilesUnder(SCANNED_DIR);
    // Guards the guard: an empty file list would make the assertion below
    // vacuously true.
    expect(files.length).toBeGreaterThan(0);

    const offenders = files.filter((file) => {
      const source = readFileSync(file, "utf-8");
      const violations = findViolations(source, repoRelative(file)) as unknown[];
      return violations.length > 0;
    });
    expect(offenders).toEqual([]);
  });

  it("detects a planted violation inside a directory tree at the same depth", () => {
    const scratchDir = mkdtempSync(path.join(tmpdir(), "hook-route-scan-"));
    try {
      const planted = path.join(scratchDir, "route.ts");
      writeFileSync(
        planted,
        `import { prisma } from "../../../lib/prisma";\n` +
          `export async function POST() { return prisma.item.findMany(); }\n`,
      );
      const source = readFileSync(planted, "utf-8");
      // Same depth as src/app/api/hook/route.ts, so the relative specifier
      // above resolves identically to how it would from the real location.
      const violations = findViolations(source, "src/app/api/hook/route.ts") as unknown[];
      expect(violations.length).toBeGreaterThan(0);
    } finally {
      rmSync(scratchDir, { recursive: true, force: true });
    }
  });

  it("calls exactly the hook_decision operation, not a different or additional one", () => {
    // A narrower, route-specific check than the generic scan above: proves
    // this row's route is wired to the operation this row declares, so a
    // future edit that quietly points it at a different operation name (or
    // adds a second `service.call`) is caught even though that would not
    // touch the database directly and so would not trip the scan above.
    const source = readFileSync(path.join(SCANNED_DIR, "route.ts"), "utf-8");
    const calls = [...source.matchAll(/service\.call\(\s*"([a-z0-9_]+)"/g)].map((m) => m[1]);
    expect(calls).toEqual(["hook_decision"]);
  });
});
