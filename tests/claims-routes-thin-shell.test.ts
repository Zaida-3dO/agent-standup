// Structural proof for SCHEMA.md §22's "every way in … is a thin shell over
// one service call" and "only the service layer, the settings resolver, and
// migrations and seeds may import the database client" — applied here to the
// routes MILESTONES.md #29 owns: `src/app/api/claims/**`,
// `src/app/api/checkpoints/**`, and `src/app/api/items/[id]/notes/**`.
//
// Same scanner as `tests/items-routes-thin-shell.test.ts` (row #26), applied
// to a different directory set — `check-db-import-allowlist.mjs` already
// covers the whole `src/` tree via `git ls-files` (CI's `npm run
// check:db-imports`), but that only sees *committed* files, and there is no
// per-directory structural test yet for the routes this row adds. Rather
// than re-derive the resolver, this imports the exact matcher
// `check-db-import-allowlist.mjs` exports (`findViolations` — the same
// TypeScript-AST-based, resolved-path matcher item's own thin-shell test
// hand-rolls locally) and points it at this row's own directories.
import { readFileSync, readdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { findViolations } from "../scripts/check-db-import-allowlist.mjs";

/**
 * The real, git-tracked repo root — not `import.meta.dirname`. See
 * `tests/items-routes-thin-shell.test.ts`'s `repoRoot()` for why: under
 * mutation testing, Stryker runs from a sandboxed copy with no `.git` of its
 * own, nested inside the real tree, so `git rev-parse --show-toplevel` finds
 * the real root from inside the sandbox too.
 */
function repoRoot(): string {
  return execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf-8" }).trim();
}

const REPO_ROOT = repoRoot();
const SCANNED_DIRS = [
  path.resolve(REPO_ROOT, "src/app/api/claims"),
  path.resolve(REPO_ROOT, "src/app/api/checkpoints"),
  path.resolve(REPO_ROOT, "src/app/api/items/[id]/notes"),
];

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

describe("the claim/checkpoint/note route layer never imports the database client directly", () => {
  it("every real file under the routes this row owns imports no database client", () => {
    const files = SCANNED_DIRS.flatMap((dir) => tsFilesUnder(dir));
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

  it("detects a planted violation inside a real directory tree, not just a string match", () => {
    // The end-to-end proof this scanner actually fires: write a file that
    // imports the client singleton by a RELATIVE path (the same evasion
    // row #26's review round 1 found for literal-string matching) into a
    // scratch directory nested at the same depth as one of this row's real
    // route directories, and confirm `findViolations` catches it.
    const scratchDir = mkdtempSync(path.join(tmpdir(), "claims-route-scan-"));
    try {
      const planted = path.join(scratchDir, "route.ts");
      writeFileSync(
        planted,
        `import { prisma } from "../../../lib/prisma";\n` +
          `export async function POST() { return prisma.assignment.create({}); }\n`,
      );
      const source = readFileSync(planted, "utf-8");
      // Same depth as src/app/api/claims/route.ts, so the relative
      // specifier above resolves identically to how it would from the real
      // location.
      const violations = findViolations(source, "src/app/api/claims/route.ts") as unknown[];
      expect(violations.length).toBeGreaterThan(0);
    } finally {
      rmSync(scratchDir, { recursive: true, force: true });
    }
  });
});
