// Structural proof for SCHEMA.md §22's "every way in … is a thin shell over
// one service call" — applied to `src/app/api/settings/**`, the routes this
// row (MILESTONES.md #78) owns.
//
// Same resolver and same reasoning as
// tests/items-routes-thin-shell.test.ts, kept as its own file (rather than
// parameterising the items one over a directory) so each route tree's scan
// stays independently readable — the pattern row #26 and row #85
// (scripts/check-db-import-allowlist.mjs) both already use per-directory.
// See items-routes-thin-shell.test.ts's header for the full history of why
// this resolves specifiers rather than matching them as literal strings.
import { readFileSync, readdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

/**
 * The real, git-tracked repo root — deliberately NOT `import.meta.dirname`.
 * See tests/service-registry.test.ts's `repoRoot()` for the full rationale
 * (Stryker's mutation sandbox has no `.git` of its own; `git rev-parse
 * --show-toplevel` finds the real root from inside it too).
 */
function repoRoot(): string {
  return execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf-8" }).trim();
}

const REPO_ROOT = repoRoot();
const SETTINGS_API_DIR = path.resolve(REPO_ROOT, "src/app/api/settings");

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

/** Resolves a `./`, `../` or `@/`-aliased specifier to the repo-relative, extensionless path it points at. */
function resolveSpecifier(specifier: string, importingFilePath: string): string | null {
  const posixImporting = toPosix(importingFilePath);
  let resolved: string;
  if (specifier.startsWith("@/")) {
    resolved = path.posix.join("src", specifier.slice("@/".length));
  } else if (specifier.startsWith("./") || specifier.startsWith("../")) {
    const importingDir = path.posix.dirname(posixImporting);
    resolved = path.posix.normalize(path.posix.join(importingDir, specifier));
  } else {
    return null;
  }
  return stripKnownExtension(resolved);
}

/** True if `source` imports the database client as a **value** (a type-only import is erased and cannot reach it at runtime). */
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
    if (!clause) return true; // bare side-effect import still runs the module
    if (clause.isTypeOnly) continue;
    if (clause.name) return true; // default import binds a value

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

function repoRelative(absolutePath: string): string {
  return toPosix(path.relative(REPO_ROOT, absolutePath));
}

describe("the settings route layer never imports the database client directly", () => {
  it("catches the aliased and the literal-package forms", () => {
    const aliased = `import { prisma } from "@/lib/prisma";\nexport const x = prisma;`;
    expect(importsDbClientValue(aliased, "src/app/api/settings/route.ts")).toBe(true);

    const pkg = `import { PrismaClient } from "@prisma/client";\nexport const x = new PrismaClient();`;
    expect(importsDbClientValue(pkg, "src/app/api/settings/route.ts")).toBe(true);
  });

  it("catches a RELATIVE path to the same module, resolved by path rather than by specifier text", () => {
    const relative = `import { prisma } from "../../../lib/prisma";\nexport async function GET() { return prisma.setting.findMany(); }`;
    expect(importsDbClientValue(relative, "src/app/api/settings/route.ts")).toBe(true);

    const relativeDeeper = `import { prisma } from "../../../../lib/prisma";`;
    expect(importsDbClientValue(relativeDeeper, "src/app/api/settings/[key]/route.ts")).toBe(true);
  });

  it("does not flag a type-only import — it cannot reach the database at runtime", () => {
    const typeOnly = `import type { PrismaClient } from "@prisma/client";\nexport type Client = PrismaClient;`;
    expect(importsDbClientValue(typeOnly, "src/app/api/settings/route.ts")).toBe(false);
  });

  it("finds nothing on an ordinary thin-shell route, so the scan does not cry wolf", () => {
    const cleanSource = `
      import { service } from "@/lib/service/live";
      export async function GET() {
        return service.call("get_settings", {});
      }
    `;
    expect(importsDbClientValue(cleanSource, "src/app/api/settings/route.ts")).toBe(false);
  });

  it("a relative import of an UNRELATED sibling module is not flagged (no false positive)", () => {
    const source = `import { serviceErrorResponse } from "./respond";`;
    expect(importsDbClientValue(source, "src/app/api/settings/route.ts")).toBe(false);
  });

  it("every real file under src/app/api/settings imports no database client, by resolved path", () => {
    const files = tsFilesUnder(SETTINGS_API_DIR);
    // Guards the guard: an empty file list would make the assertion below
    // vacuously true.
    expect(files.length).toBeGreaterThan(0);

    const offenders = files.filter((file) =>
      importsDbClientValue(readFileSync(file, "utf-8"), repoRelative(file)),
    );
    expect(offenders).toEqual([]);
  });

  it("detects a planted RELATIVE-path violation inside a real directory tree, not just a string", () => {
    const scratchDir = mkdtempSync(path.join(tmpdir(), "settings-route-scan-"));
    try {
      writeFileSync(
        path.join(scratchDir, "route.ts"),
        `import { prisma } from "../../../lib/prisma";\n` +
          `export async function GET() { return prisma.setting.findMany(); }\n`,
      );
      const files = tsFilesUnder(scratchDir);
      const offenders = files.filter((file) =>
        importsDbClientValue(readFileSync(file, "utf-8"), "src/app/api/settings/route.ts"),
      );
      expect(offenders).toEqual([path.join(scratchDir, "route.ts")]);
    } finally {
      rmSync(scratchDir, { recursive: true, force: true });
    }
  });
});
