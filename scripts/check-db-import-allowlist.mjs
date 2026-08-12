#!/usr/bin/env node
/**
 * Fails when a file outside the allowlist imports the database client at
 * runtime: `src/lib/prisma.ts` (the connected singleton) or the value export
 * `PrismaClient` from `@prisma/client`.
 *
 * The allowlist (CLAUDE.md, "Working in this repo" — MILESTONES.md #85):
 *
 *   - `src/lib/prisma.ts` — the client module itself: constructs the
 *     singleton `PrismaClient`, so it necessarily imports the constructor it
 *     wraps. This is the module *being* the database client, not a caller
 *     reaching for it, which is why it is named exactly rather than folded
 *     into a directory prefix — nothing else at `src/lib/` root gets this
 *     exception by proximity.
 *   - `src/lib/service/**` — the service layer. `src/lib/service/live.ts` is
 *     the one file that imports the constructed singleton from
 *     `src/lib/prisma.ts`; the rest of the service layer takes it as a
 *     parameter.
 *   - `src/lib/settings/**` — the settings resolver, which reads overrides
 *     out of Postgres directly (it runs *inside* the service layer's
 *     transaction, before a settings snapshot exists to hand to a guard).
 *   - `prisma/**` — migrations and seeds. Prisma's own tooling and
 *     `prisma/seed.mjs` both need the real client; there is no service layer
 *     to call before the schema exists.
 *
 * Everywhere else — every adapter, every future route, every data-layer
 * helper under `src/lib/` that is not the service layer itself — is expected
 * to go through the service layer instead of reaching the database (or a
 * guard) directly. That is the rule this script enforces independently of
 * ESLint's `no-restricted-imports` (`eslint.config.mjs`), so the invariant
 * holds even for someone running `tsc`/`vitest` without lint, or bypassing
 * lint with a disable comment.
 *
 * ── What this checks, precisely ─────────────────────────────────────────
 *
 * A **value** import of the database client:
 *   - `import { prisma } from "@/lib/prisma"` (any binding name)
 *   - `import prisma from "@/lib/prisma"` (default import, if one existed)
 *   - `import { PrismaClient } from "@prisma/client"` as a **value** — i.e.
 *     used to construct a client, not merely to name a type
 *
 * `import type { PrismaClient } from "@prisma/client"` — and any import
 * where every named specifier is written `type X` — is dependency injection
 * (`client: Pick<PrismaClient, "item">`), not a database reach, and is
 * allowed everywhere. This is checked with the real TypeScript parser
 * (`ts.isImportDeclaration` + `isTypeOnly` on the clause and each named
 * specifier), not a regex, so a value import cannot slip past by formatting
 * differently than a hand-written pattern expects.
 *
 * ── What a green run does, and does not, mean ───────────────────────────
 *
 * **A green run means no tracked `.ts`/`.tsx` file outside the allowlist
 * contains a value import of the database client.** It does not mean an
 * adapter never reaches the database — a file could still open its own
 * `pg` connection, call `fetch` against a database-backed HTTP API, or
 * require an unlisted module that itself wraps Prisma. This check only
 * inspects import *specifiers* of the two forms named above; it does not
 * trace transitive re-exports (a new `src/lib/db-handle.ts` that
 * re-exports `prisma` from `./prisma` would not itself be caught importing
 * `@/lib/prisma` outside the allowlist — the file *doing* the re-export
 * would be, because that file is not in the allowlist either, but a
 * hypothetical allowlisted file re-exporting the client under a new name
 * is a gap this script does not close). It is a backstop against the
 * common case — a plain import — not a proof that no adapter code path
 * ever reaches the database.
 *
 * Usage:
 *   node scripts/check-db-import-allowlist.mjs        # every tracked .ts/.tsx under src/
 *   node scripts/check-db-import-allowlist.mjs a.ts    # just these
 */
import { spawnSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import ts from "typescript";

/**
 * Directories allowed to import the database client at runtime. Checked as
 * a path prefix against the POSIX-normalised, repo-relative path.
 */
export const ALLOWLIST_PREFIXES = ["src/lib/service/", "src/lib/settings/", "prisma/"];

/**
 * Exact files allowed alongside the directories above — the client module
 * itself, which has to import what it constructs. See the header comment.
 */
export const ALLOWLIST_FILES = ["src/lib/prisma.ts"];

/** The two import specifiers this script restricts. */
export const RESTRICTED_MODULE_SPECIFIERS = ["@/lib/prisma", "@prisma/client"];

/** Only the named `PrismaClient` export of `@prisma/client` is restricted. */
const RESTRICTED_NAME = "PrismaClient";

function toPosix(p) {
  return p.split("\\").join("/");
}

export function isAllowlisted(relativePath) {
  const posixPath = toPosix(relativePath);
  if (ALLOWLIST_FILES.includes(posixPath)) return true;
  return ALLOWLIST_PREFIXES.some((prefix) => posixPath.startsWith(prefix));
}

/** Should this path be parsed at all? Only real TS/TSX source under `src/`. */
export function isCheckable(relativePath) {
  const posixPath = toPosix(relativePath);
  if (!posixPath.startsWith("src/")) return false;
  return /\.(ts|tsx)$/.test(posixPath) && !posixPath.endsWith(".d.ts");
}

/**
 * Find every restricted-import violation in one file's text.
 *
 * Returns `{ line, specifier, imported }[]` — `imported` is the binding that
 * triggered it: `"*"` for a bare/namespace import of `@/lib/prisma`, or the
 * specific named export (`"prisma"`, `"PrismaClient"`) that was imported as
 * a value.
 */
export function findViolations(sourceText, fileName = "file.ts") {
  const sourceFile = ts.createSourceFile(
    fileName,
    sourceText,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
    fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );

  const violations = [];

  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    if (!ts.isStringLiteral(statement.moduleSpecifier)) continue;

    const specifier = statement.moduleSpecifier.text;
    if (!RESTRICTED_MODULE_SPECIFIERS.includes(specifier)) continue;

    const clause = statement.importClause;
    // `import "@/lib/prisma"` — a bare side-effect import. Nothing to
    // restrict for `@prisma/client` (there is no value to name), but
    // `@/lib/prisma`'s whole point is its `prisma` export, and a bare
    // import still runs the module (constructs the client) for the side
    // effect — so it counts.
    if (!clause) {
      violations.push({
        line: lineOf(sourceFile, statement.getStart(sourceFile)),
        specifier,
        imported: "*",
      });
      continue;
    }

    // The whole clause is `import type ... from "..."` — erased at compile
    // time, never reaches the database at runtime. Always allowed.
    if (clause.isTypeOnly) continue;

    // Default import: `import prisma from "@/lib/prisma"`. Neither module
    // exports a default; a default import would still be caught here as a
    // value import if one were ever added.
    if (clause.name) {
      violations.push({
        line: lineOf(sourceFile, statement.getStart(sourceFile)),
        specifier,
        imported: "default",
      });
    }

    const bindings = clause.namedBindings;
    if (!bindings) continue;

    if (ts.isNamespaceImport(bindings)) {
      // `import * as prismaModule from "..."` — a value import of
      // everything the module exports.
      violations.push({
        line: lineOf(sourceFile, statement.getStart(sourceFile)),
        specifier,
        imported: "*",
      });
      continue;
    }

    // Named imports: `import { prisma } from "@/lib/prisma"` or
    // `import { PrismaClient } from "@prisma/client"`. Each specifier can
    // independently be `type X` (allowed) even when the clause as a whole
    // is not — `import { type PrismaClient, other } from "..."`.
    for (const element of bindings.elements) {
      if (element.isTypeOnly) continue;

      const importedName = (element.propertyName ?? element.name).text;

      if (specifier === "@prisma/client" && importedName !== RESTRICTED_NAME) {
        // `@prisma/client` also exports enums/types this script does not
        // restrict (e.g. `ItemState`) — only the client constructor.
        continue;
      }

      violations.push({
        line: lineOf(sourceFile, element.getStart(sourceFile)),
        specifier,
        imported: importedName,
      });
    }
  }

  return violations;
}

function lineOf(sourceFile, pos) {
  return sourceFile.getLineAndCharacterOfPosition(pos).line + 1;
}

/** Every tracked `.ts`/`.tsx` file under `src/`, so a new file is covered the moment it is added. */
function trackedSourceFiles() {
  const result = spawnSync("git", ["ls-files", "-z", "--", "src/**/*.ts", "src/**/*.tsx"], {
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(
      `git ls-files failed: ${result.stderr || result.error?.message || "unknown error"}`,
    );
  }
  return result.stdout.split("\0").filter(Boolean);
}

function describe(violation, path) {
  return (
    `${path}:${violation.line}  imports "${violation.imported}" from "${violation.specifier}"\n` +
    `    ↳ only src/lib/service/, src/lib/settings/ and prisma/ may import the database client ` +
    `(CLAUDE.md, "Working in this repo") — call the service layer instead`
  );
}

function main(argv) {
  const explicit = argv.slice(2);
  const isDefaultFullScan = explicit.length === 0;
  const listed = isDefaultFullScan ? trackedSourceFiles() : explicit;
  const paths = listed.filter(isCheckable).filter((p) => !isAllowlisted(p));

  // A guard that finds nothing to check is not a guard — it just hasn't
  // run. `src/lib/service/live.ts` alone guarantees this repository always
  // has at least one file that imports the client (inside the allowlist,
  // so it is never itself flagged), which only proves files *exist*; it
  // says nothing about whether *this scan* found any non-allowlisted
  // source to inspect. Fail loudly rather than pass on an empty set —
  // but only for the default, whole-repo scan CI actually runs. An
  // explicit file list can legitimately filter down to nothing (every
  // named file happens to be allowlisted or non-checkable); that is a
  // narrower, deliberate invocation, not evidence the check has stopped
  // running.
  if (isDefaultFullScan && paths.length === 0) {
    console.error(
      "check-db-import-allowlist found zero non-allowlisted .ts/.tsx files under src/ to " +
        "inspect. That means this check is not actually running against anything, which is " +
        "worse than not running at all — treat this as a failure, not a pass.",
    );
    return 1;
  }

  const failures = [];
  let scanned = 0;

  for (const path of paths) {
    let stats;
    try {
      stats = statSync(path);
    } catch {
      continue; // deleted between listing and reading; nothing to check
    }
    if (!stats.isFile()) continue;

    scanned += 1;
    const contents = readFileSync(path, "utf8");
    for (const violation of findViolations(contents, path)) {
      failures.push(describe(violation, path));
    }
  }

  const coverage = `Scanned ${scanned} file${scanned === 1 ? "" : "s"} outside the allowlist for a database-client import`;

  if (failures.length === 0) {
    console.log(`${coverage}: none found.`);
    return 0;
  }

  console.error(failures.join("\n\n"));
  console.error(
    `\n${failures.length} file${failures.length === 1 ? "" : "s"} outside the allowlist ` +
      "import the database client directly.\n\n" +
      "Only the service layer (src/lib/service/), the settings resolver (src/lib/settings/) " +
      "and migrations/seeds (prisma/) may import it. Every adapter is a thin shell over a " +
      "service call and must not reach the database (or a guard) directly — call the service " +
      'layer instead. See CLAUDE.md, "Working in this repo".',
  );
  return 1;
}

if (process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv));
}
