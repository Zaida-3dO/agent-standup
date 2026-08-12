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
// no route file has, in fact, reached around that boundary by importing the
// database client — **matched by resolved path, not by specifier text**.
//
// Review round 1 found the first version of this file matched
// `@prisma/client` / `@/lib/prisma` as literal strings, so a file that
// wrote the same import as a relative path (`../../lib/prisma`) resolved to
// the identical module but was never flagged — reachable by an ordinary
// contributor who simply didn't use the alias, since `[id]/route.ts` in
// this very directory already imports its sibling `respond.ts` relatively.
// Fixed the same way row #85 fixes it repo-wide
// (scripts/check-db-import-allowlist.mjs, commit a8c7d90): parse the real
// import declarations with the TypeScript compiler API, resolve each
// specifier (the `@/` alias or a relative `./`/`../` path) against the
// importing file's own location, and compare the *resolved* path to
// `src/lib/prisma.ts` — so every spelling that reaches that file is caught,
// not only the canonical one. `@prisma/client` has no relative form (a bare
// package specifier), so it stays matched by name.
import { readFileSync, readdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const ITEMS_API_DIR = path.resolve(REPO_ROOT, "src/app/api/items");

/** `src/lib/prisma.ts`, repo-relative, extensionless — what every spelling of the client import must resolve to. */
const CLIENT_MODULE_PATH = "src/lib/prisma";
const PRISMA_PACKAGE_SPECIFIER = "@prisma/client";
const RESTRICTED_PACKAGE_EXPORT = "PrismaClient";

function toPosix(p: string): string {
  return p.split("\\").join("/");
}

function stripKnownExtension(posixPath: string): string {
  return posixPath.replace(/\.(ts|tsx|js|jsx|mjs|cjs)$/, "");
}

/**
 * Resolves a `./`, `../` or `@/`-aliased specifier written inside
 * `importingFilePath` (repo-relative, POSIX or Windows separators) to the
 * repo-relative, extensionless path it points at. Returns `null` for a bare
 * package specifier (e.g. `@prisma/client`, `next/server`), which this
 * resolver deliberately does not attempt to resolve through node_modules —
 * it only has to close the relative/alias gap for the one file this test
 * cares about.
 */
function resolveSpecifier(specifier: string, importingFilePath: string): string | null {
  const posixImporting = toPosix(importingFilePath);
  let resolved: string;
  if (specifier.startsWith("@/")) {
    // tsconfig.json: "@/*": ["./src/*"]
    resolved = path.posix.join("src", specifier.slice("@/".length));
  } else if (specifier.startsWith("./") || specifier.startsWith("../")) {
    const importingDir = path.posix.dirname(posixImporting);
    resolved = path.posix.normalize(path.posix.join(importingDir, specifier));
  } else {
    return null;
  }
  return stripKnownExtension(resolved);
}

/**
 * True if `source` (the contents of the file at `repoRelativePath`) imports
 * the database client as a **value** — a type-only import is erased at
 * compile time and cannot reach the database at runtime, so it does not
 * count (mirrors row #85's own scan).
 */
function importsDbClientValue(source: string, repoRelativePath: string): boolean {
  const sourceFile = ts.createSourceFile(
    repoRelativePath,
    source,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    ts.ScriptKind.TS,
  );

  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    if (!ts.isStringLiteral(statement.moduleSpecifier)) continue;

    const specifier = statement.moduleSpecifier.text;
    const resolvesToClientModule =
      resolveSpecifier(specifier, repoRelativePath) === CLIENT_MODULE_PATH;
    const isPrismaPackage = specifier === PRISMA_PACKAGE_SPECIFIER;
    if (!resolvesToClientModule && !isPrismaPackage) continue;

    const clause = statement.importClause;
    // A bare side-effect import (`import "@/lib/prisma"`) still runs the
    // module — constructs the singleton — so it counts even with no clause.
    if (!clause) return true;
    // The whole clause is type-only: erased, never reaches the database.
    if (clause.isTypeOnly) continue;
    // A default import binds a value.
    if (clause.name) return true;

    const bindings = clause.namedBindings;
    if (!bindings) continue;
    if (ts.isNamespaceImport(bindings)) return true;

    for (const element of bindings.elements) {
      if (element.isTypeOnly) continue;
      const importedName = (element.propertyName ?? element.name).text;
      if (isPrismaPackage && importedName !== RESTRICTED_PACKAGE_EXPORT) continue;
      return true;
    }
  }

  return false;
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

/** Repo-relative POSIX path, as the resolver and the real CI scan both key on. */
function repoRelative(absolutePath: string): string {
  return toPosix(path.relative(REPO_ROOT, absolutePath));
}

describe("the items route layer never imports the database client directly", () => {
  it("catches the aliased and the literal-package forms", () => {
    const aliased = `import { prisma } from "@/lib/prisma";\nexport const x = prisma;`;
    expect(importsDbClientValue(aliased, "src/app/api/items/route.ts")).toBe(true);

    const pkg = `import { PrismaClient } from "@prisma/client";\nexport const x = new PrismaClient();`;
    expect(importsDbClientValue(pkg, "src/app/api/items/route.ts")).toBe(true);
  });

  it("catches a RELATIVE path to the same module — the exact evasion review round 1 found", () => {
    // From src/app/api/items/route.ts, "../../../lib/prisma" resolves to
    // src/lib/prisma — the identical file @/lib/prisma points at. A scan
    // matching specifier *text* misses this; a scan matching the *resolved
    // path* cannot, because both spellings resolve to the same string.
    const relative = `import { prisma } from "../../../lib/prisma";\nexport async function GET() { return prisma.item.findMany(); }`;
    expect(importsDbClientValue(relative, "src/app/api/items/route.ts")).toBe(true);

    // A different depth (one level deeper, matching [id]/route.ts's own
    // directory) resolves through one more "../" — still the same module.
    const relativeDeeper = `import { prisma } from "../../../../lib/prisma";`;
    expect(importsDbClientValue(relativeDeeper, "src/app/api/items/[id]/route.ts")).toBe(true);
  });

  it("does not flag a type-only import — it cannot reach the database at runtime", () => {
    const typeOnly = `import type { PrismaClient } from "@prisma/client";\nexport type Client = PrismaClient;`;
    expect(importsDbClientValue(typeOnly, "src/app/api/items/route.ts")).toBe(false);
  });

  it("finds nothing on an ordinary thin-shell route, so the scan does not cry wolf", () => {
    const cleanSource = `
      import { service } from "@/lib/service/live";
      export async function GET() {
        return service.call("get_item", {});
      }
    `;
    expect(importsDbClientValue(cleanSource, "src/app/api/items/route.ts")).toBe(false);
  });

  it("a relative import of an UNRELATED sibling module is not flagged (no false positive)", () => {
    // The real [id]/route.ts imports "../respond" — a relative import that
    // resolves to src/app/api/items/respond.ts, nowhere near
    // src/lib/prisma. Proves the resolver compares resolved *paths*, not
    // merely "is this specifier relative".
    const source = `import { serviceErrorResponse } from "../respond";`;
    expect(importsDbClientValue(source, "src/app/api/items/[id]/route.ts")).toBe(false);
  });

  it("every real file under src/app/api/items imports no database client, by resolved path", () => {
    const files = tsFilesUnder(ITEMS_API_DIR);
    // Guards the guard, same reasoning as every other canonical-scan test
    // in this repo: an empty file list would make the assertion below
    // vacuously true.
    expect(files.length).toBeGreaterThan(0);

    const offenders = files.filter((file) =>
      importsDbClientValue(readFileSync(file, "utf-8"), repoRelative(file)),
    );
    expect(offenders).toEqual([]);
  });

  it("detects a planted RELATIVE-path violation inside a real directory tree, not just a string", () => {
    // The end-to-end version of the checks above: write an actual file to
    // disk, using the relative spelling that evaded the previous version of
    // this test, and prove the directory-walking scan (not just the
    // resolver in isolation) finds it.
    const scratchDir = mkdtempSync(path.join(tmpdir(), "items-route-scan-"));
    try {
      writeFileSync(
        path.join(scratchDir, "route.ts"),
        `import { prisma } from "../../../lib/prisma";\n` +
          `export async function GET() { return prisma.item.findMany(); }\n`,
      );
      const files = tsFilesUnder(scratchDir);
      // Fake a repo-relative path at the same depth as the real
      // src/app/api/items/ directory, so "../../../lib/prisma" resolves
      // exactly as it would from the real location.
      const offenders = files.filter((file) =>
        importsDbClientValue(readFileSync(file, "utf-8"), "src/app/api/items/route.ts"),
      );
      expect(offenders).toEqual([path.join(scratchDir, "route.ts")]);
    } finally {
      rmSync(scratchDir, { recursive: true, force: true });
    }
  });
});
