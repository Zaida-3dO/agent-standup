// Structural proof for SCHEMA.md §22's "every way in … is a thin shell over
// one service call" and "only the service layer, the settings resolver, and
// migrations and seeds may import the database client" — applied here to
// `src/app/api/items/**`, the routes this row owns.
//
// The strongest available proof (per the task brief) is a type that makes
// DB access from a route impossible; the next best is a grep-style test
// asserting the route layer imports no db client. `TransactionHandle`
// (service/context.ts) already provides the type-level half — an operation
// cannot reach a `PrismaClient` because its `ctx.db` parameter is typed too
// narrowly to have one. This file is the second half: a source scan proving
// no route file has, in fact, reached around that boundary by importing
// `@prisma/client` or `@/lib/prisma` directly.
import { readFileSync, readdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ITEMS_API_DIR = path.resolve(import.meta.dirname, "../src/app/api/items");

const FORBIDDEN_IMPORT_PATTERNS = [
  /from\s+["']@prisma\/client["']/,
  /from\s+["']@\/lib\/prisma["']/,
  /require\(\s*["']@prisma\/client["']\s*\)/,
];

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

/** True if `source` imports the database client by any pattern this scan knows. */
function importsDbClient(source: string): boolean {
  return FORBIDDEN_IMPORT_PATTERNS.some((pattern) => pattern.test(source));
}

describe("the items route layer never imports the database client directly", () => {
  it("scans a route file that imports @prisma/client and finds it — proving the scan is real", () => {
    // Same discipline as service-registry.test.ts and adapter-registry.test.ts:
    // before trusting "the real routes are clean", prove the detector can
    // catch a genuine violation. A scan that always reports "clean" would
    // pass this file's other test regardless of what the routes actually do.
    const violatingSource = `
      import { PrismaClient } from "@prisma/client";
      export async function GET() {
        const prisma = new PrismaClient();
        return prisma.item.findMany();
      }
    `;
    expect(importsDbClient(violatingSource)).toBe(true);

    const alsoViolating = `import { prisma } from "@/lib/prisma";\nexport const x = prisma;`;
    expect(importsDbClient(alsoViolating)).toBe(true);
  });

  it("finds nothing on an ordinary thin-shell route, so the scan does not cry wolf", () => {
    const cleanSource = `
      import { service } from "@/lib/service/live";
      export async function GET() {
        return service.call("get_item", {});
      }
    `;
    expect(importsDbClient(cleanSource)).toBe(false);
  });

  it("every real file under src/app/api/items imports no database client", () => {
    const files = tsFilesUnder(ITEMS_API_DIR);
    // Guards the guard, same reasoning as every other canonical-scan test
    // in this repo: an empty file list would make the assertion below
    // vacuously true.
    expect(files.length).toBeGreaterThan(0);

    const offenders = files.filter((file) => importsDbClient(readFileSync(file, "utf-8")));
    expect(offenders).toEqual([]);
  });

  it("detects a planted violation inside a real directory tree, not just a string", () => {
    // The end-to-end version of the two unit checks above: write an actual
    // file to disk under a scratch tree shaped like src/app/api/items, and
    // prove the directory-walking scan (not just the regex in isolation)
    // finds it.
    const scratchDir = mkdtempSync(path.join(tmpdir(), "items-route-scan-"));
    try {
      writeFileSync(
        path.join(scratchDir, "route.ts"),
        `import { PrismaClient } from "@prisma/client";\nexport async function GET() { return new PrismaClient(); }\n`,
      );
      const files = tsFilesUnder(scratchDir);
      const offenders = files.filter((file) => importsDbClient(readFileSync(file, "utf-8")));
      expect(offenders).toEqual([path.join(scratchDir, "route.ts")]);
    } finally {
      rmSync(scratchDir, { recursive: true, force: true });
    }
  });
});
