// Structural proof for SCHEMA.md §22's "every way in … is a thin shell over
// one service call", applied to `src/app/api/my-work/**` — the one route
// under this row (#28) that lives outside `src/app/api/items/`, so it is
// not covered by `tests/items-routes-thin-shell.test.ts`'s directory walk
// (that file scopes itself explicitly to "the routes this row owns", row
// #26's territory). `src/app/api/items/[id]/orientation/route.ts`, this
// row's other route, *is* covered by that walk — it lives inside
// `src/app/api/items/`.
//
// Same resolver and same reasoning as `items-routes-thin-shell.test.ts`:
// matched by resolved import path, not specifier text, so a relative
// spelling of `@/lib/prisma` cannot evade it. This is a smaller, second
// instance of the same check rather than a shared helper, because the two
// rows own different directories and a shared helper would have to import
// across territory it does not need to.
import { readFileSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

function repoRoot(): string {
  return execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf-8" }).trim();
}

const REPO_ROOT = repoRoot();
const MY_WORK_API_DIR = path.resolve(REPO_ROOT, "src/app/api/my-work");

const CLIENT_MODULE_PATH = "src/lib/prisma";
const PRISMA_PACKAGE_SPECIFIER = "@prisma/client";
const RESTRICTED_PACKAGE_EXPORT = "PrismaClient";

function toPosix(p: string): string {
  return p.split("\\").join("/");
}

function stripKnownExtension(posixPath: string): string {
  return posixPath.replace(/\.(ts|tsx|js|jsx|mjs|cjs)$/, "");
}

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
    if (!clause) return true;
    if (clause.isTypeOnly) continue;
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

function repoRelative(absolutePath: string): string {
  return toPosix(path.relative(REPO_ROOT, absolutePath));
}

describe("the my-work route never imports the database client directly", () => {
  it("catches the aliased and the literal-package forms", () => {
    const aliased = `import { prisma } from "@/lib/prisma";\nexport const x = prisma;`;
    expect(importsDbClientValue(aliased, "src/app/api/my-work/route.ts")).toBe(true);
  });

  it("catches a RELATIVE path to the same module", () => {
    // From src/app/api/my-work/route.ts, three "../" hops (my-work -> api
    // -> app -> src) reach src/lib/prisma.
    const relative = `import { prisma } from "../../../lib/prisma";\nexport async function GET() { return prisma.item.findMany(); }`;
    expect(importsDbClientValue(relative, "src/app/api/my-work/route.ts")).toBe(true);
  });

  it("does not flag a type-only import", () => {
    const typeOnly = `import type { PrismaClient } from "@prisma/client";\nexport type Client = PrismaClient;`;
    expect(importsDbClientValue(typeOnly, "src/app/api/my-work/route.ts")).toBe(false);
  });

  it("finds nothing on an ordinary thin-shell route, so the scan does not cry wolf", () => {
    const cleanSource = `
      import { service } from "@/lib/service/live";
      export async function GET() {
        return service.call("my_work", {});
      }
    `;
    expect(importsDbClientValue(cleanSource, "src/app/api/my-work/route.ts")).toBe(false);
  });

  it("every real file under src/app/api/my-work imports no database client, by resolved path", () => {
    const files = tsFilesUnder(MY_WORK_API_DIR);
    expect(files.length).toBeGreaterThan(0);

    const offenders = files.filter((file) =>
      importsDbClientValue(readFileSync(file, "utf-8"), repoRelative(file)),
    );
    expect(offenders).toEqual([]);
  });
});
