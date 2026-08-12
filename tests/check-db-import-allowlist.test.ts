import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
// Plain JS, deliberately: this has to run as `node scripts/check-db-import-allowlist.mjs`
// with no build step, so CI can gate on it before anything is compiled — same reasoning as
// tests/check-external-refs.test.ts.
import {
  ALLOWLIST_FILES,
  ALLOWLIST_PREFIXES,
  CLIENT_MODULE_PATH,
  PRISMA_PACKAGE_SPECIFIER,
  RESTRICTED_MODULE_SPECIFIERS,
  findViolations,
  isAllowlisted,
  isCheckable,
  resolveRelativeSpecifier,
} from "../scripts/check-db-import-allowlist.mjs";

type Violation = { line: number; specifier: string; imported: string };

const scan = (text: string, fileName = "file.ts"): Violation[] =>
  findViolations(text, fileName) as Violation[];

const scriptPath = path.resolve(import.meta.dirname, "../scripts/check-db-import-allowlist.mjs");

/**
 * Run the checker as CI runs it — a real process, over real files — and hand
 * back the exit code plus both streams. The unit tests below cover matching;
 * this covers the thing that actually gates a build.
 */
function runCli(files: string[], cwd: string) {
  try {
    const stdout = execFileSync(process.execPath, [scriptPath, ...files], {
      cwd,
      encoding: "utf8",
    });
    return { status: 0, stdout, stderr: "" };
  } catch (error) {
    const failure = error as { status?: number; stdout?: string; stderr?: string };
    return {
      status: failure.status ?? -1,
      stdout: failure.stdout ?? "",
      stderr: failure.stderr ?? "",
    };
  }
}

const tempDirs: string[] = [];
function seedFile(relativePath: string, contents: string) {
  const dir = mkdtempSync(path.join(tmpdir(), "db-import-allowlist-"));
  tempDirs.push(dir);
  const full = path.join(dir, relativePath);
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, contents, "utf8");
  return { dir, file: relativePath };
}

afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

describe("check-db-import-allowlist — what it catches", () => {
  it("catches a value import of the database client singleton", () => {
    const violations = scan('import { prisma } from "@/lib/prisma";\n');

    expect(violations).toEqual([{ line: 1, specifier: "@/lib/prisma", imported: "prisma" }]);
  });

  it("catches a renamed named import of the singleton", () => {
    expect(scan('import { prisma as db } from "@/lib/prisma";\n')).toEqual([
      { line: 1, specifier: "@/lib/prisma", imported: "prisma" },
    ]);
  });

  it("catches a bare, side-effect-only import of the singleton", () => {
    // No binding at all — still runs the module (constructs the client).
    expect(scan('import "@/lib/prisma";\n')).toEqual([
      { line: 1, specifier: "@/lib/prisma", imported: "*" },
    ]);
  });

  it("catches a namespace import of the singleton", () => {
    expect(scan('import * as prismaModule from "@/lib/prisma";\n')).toEqual([
      { line: 1, specifier: "@/lib/prisma", imported: "*" },
    ]);
  });

  it("catches a value import of PrismaClient used to construct a client", () => {
    const violations = scan(
      ['import { PrismaClient } from "@prisma/client";', "", "new PrismaClient();"].join("\n"),
    );

    expect(violations).toEqual([
      { line: 1, specifier: "@prisma/client", imported: "PrismaClient" },
    ]);
  });

  it("catches PrismaClient on a multi-line import statement", () => {
    const violations = scan(["import {", "  PrismaClient,", '} from "@prisma/client";'].join("\n"));

    expect(violations).toEqual([
      { line: 2, specifier: "@prisma/client", imported: "PrismaClient" },
    ]);
  });

  it("catches a default import of the singleton, should one ever exist", () => {
    expect(scan('import prisma from "@/lib/prisma";\n')).toEqual([
      { line: 1, specifier: "@/lib/prisma", imported: "default" },
    ]);
  });

  it("catches every restricted specifier when both appear in one file", () => {
    const violations = scan(
      [
        'import { prisma } from "@/lib/prisma";',
        'import { PrismaClient } from "@prisma/client";',
      ].join("\n"),
    );

    expect(violations).toHaveLength(2);
    expect(violations.map((v) => v.specifier)).toEqual(["@/lib/prisma", "@prisma/client"]);
  });
});

describe("check-db-import-allowlist — relative-path evasion (round-2 finding)", () => {
  // Both enforcement mechanisms used to match the client by exact specifier
  // TEXT ("@/lib/prisma"), so a file that wrote a relative path to the same
  // module instead of the alias — an ordinary spelling choice, not an
  // adversarial one — passed clean. Fixed by resolving every specifier to
  // the file it actually points at before comparing. These tests pin that
  // resolution, at the level `findViolations` operates: given the
  // *importing file's own path*, not just the specifier text.
  it("catches a deep relative import from src/app/, the exact case reported in review", () => {
    // A file two directories under src/ (src/app/api/) reaching
    // src/lib/prisma via ../../ — one "../" per directory back up to src/,
    // then down into lib/prisma.
    const violations = scan('import { prisma } from "../../lib/prisma";\n', "src/app/api/route.ts");

    expect(violations).toEqual([{ line: 1, specifier: "../../lib/prisma", imported: "prisma" }]);
  });

  it("catches a single-level relative import from a sibling directory of src/lib/", () => {
    // A file one directory *below* a hypothetical non-allowlisted sibling of
    // src/lib/service/ (e.g. src/lib/import/items.ts) reaching the client
    // via ../prisma — one "../" walks back up to src/lib/.
    const violations = scan('import { prisma } from "../prisma";\n', "src/lib/import/items.ts");

    expect(violations).toEqual([{ line: 1, specifier: "../prisma", imported: "prisma" }]);
  });

  it("catches a same-directory relative import (./prisma) from inside src/lib/", () => {
    const violations = scan('import { prisma } from "./prisma";\n', "src/lib/whatever.ts");

    expect(violations).toEqual([{ line: 1, specifier: "./prisma", imported: "prisma" }]);
  });

  it("catches a relative import with an explicit .ts extension", () => {
    const violations = scan('import { prisma } from "../prisma.ts";\n', "src/lib/import/items.ts");

    expect(violations).toEqual([{ line: 1, specifier: "../prisma.ts", imported: "prisma" }]);
  });

  it("does NOT flag a relative import from inside the allowlist itself — no false positive", () => {
    // src/lib/service/live.ts imports the singleton via the alias in the
    // real tree; this proves the *relative* spelling of that same import,
    // from that same allowlisted location, is still correctly left alone.
    // isAllowlisted (checked by main(), not findViolations) is what
    // actually exempts the file — findViolations only decides whether an
    // import statement names the client, which it correctly does here too.
    // The allowlist check happens one layer up; see the CLI-level test
    // below ("passes on a relative import from inside the service layer")
    // for the end-to-end proof.
    const violations = scan('import { prisma } from "../prisma";\n', "src/lib/service/live.ts");

    expect(violations).toEqual([{ line: 1, specifier: "../prisma", imported: "prisma" }]);
  });

  it("does not confuse a relative import of an unrelated sibling module with the client", () => {
    const violations = scan('import { ensureArea } from "./areas";\n', "src/lib/import-items.ts");

    expect(violations).toEqual([]);
  });
});

describe("check-db-import-allowlist — resolveRelativeSpecifier", () => {
  it("resolves the @/ alias to src/", () => {
    expect(resolveRelativeSpecifier("@/lib/prisma", "src/app/foo.ts")).toBe(CLIENT_MODULE_PATH);
  });

  it("resolves a deep relative path against the importing file's directory", () => {
    expect(resolveRelativeSpecifier("../../lib/prisma", "src/app/api/route.ts")).toBe(
      CLIENT_MODULE_PATH,
    );
  });

  it("resolves a single-level relative path — one '../' from one directory below src/lib/", () => {
    expect(resolveRelativeSpecifier("../prisma", "src/lib/import/items.ts")).toBe(
      CLIENT_MODULE_PATH,
    );
  });

  it("resolves a same-directory relative path from inside src/lib/ itself", () => {
    expect(resolveRelativeSpecifier("./prisma", "src/lib/whatever.ts")).toBe(CLIENT_MODULE_PATH);
  });

  it("strips a known extension so foo and foo.ts compare equal", () => {
    expect(resolveRelativeSpecifier("../prisma.ts", "src/lib/import/items.ts")).toBe(
      CLIENT_MODULE_PATH,
    );
  });

  it("resolves a relative import to something other than the client to a different path", () => {
    expect(resolveRelativeSpecifier("./areas", "src/lib/import-items.ts")).toBe("src/lib/areas");
    expect(resolveRelativeSpecifier("./areas", "src/lib/import-items.ts")).not.toBe(
      CLIENT_MODULE_PATH,
    );
  });

  it("returns null for a bare package specifier — it has no relative form to resolve", () => {
    expect(resolveRelativeSpecifier(PRISMA_PACKAGE_SPECIFIER, "src/lib/whatever.ts")).toBeNull();
    expect(resolveRelativeSpecifier("node:fs", "src/lib/whatever.ts")).toBeNull();
  });
});

describe("check-db-import-allowlist — what it must not flag", () => {
  it("leaves a type-only import of PrismaClient alone (dependency injection)", () => {
    const text = [
      'import type { PrismaClient } from "@prisma/client";',
      "",
      'export function ensureArea(client: Pick<PrismaClient, "area">, raw: string) {',
      "  return client.area.findFirst();",
      "}",
    ].join("\n");

    expect(scan(text)).toEqual([]);
  });

  it("leaves a type-only named specifier alone even inside a mixed import clause", () => {
    // `import { type PrismaClient, ItemState }` — the clause as a whole is
    // not type-only, but the PrismaClient specifier itself is.
    const text = ['import { type PrismaClient, ItemState } from "@prisma/client";'].join("\n");

    expect(scan(text)).toEqual([]);
  });

  it("leaves other named exports of @prisma/client alone", () => {
    // ItemState is a generated enum, not the client constructor — this
    // script restricts PrismaClient specifically, not the whole module.
    expect(scan('import { ItemState } from "@prisma/client";\n')).toEqual([]);
  });

  it("leaves an unrelated import alone", () => {
    expect(scan('import { readFile } from "node:fs/promises";\n')).toEqual([]);
  });

  it("leaves a comment merely mentioning the module alone", () => {
    expect(scan("// see @/lib/prisma for the singleton\n")).toEqual([]);
  });
});

describe("check-db-import-allowlist — the allowlist itself", () => {
  it("allows the service layer", () => {
    expect(isAllowlisted("src/lib/service/live.ts")).toBe(true);
    expect(isAllowlisted("src/lib/service/runtime.ts")).toBe(true);
  });

  it("allows the settings resolver", () => {
    expect(isAllowlisted("src/lib/settings/resolve.ts")).toBe(true);
  });

  it("allows migrations and seeds", () => {
    expect(isAllowlisted("prisma/seed.mjs")).toBe(true);
    expect(isAllowlisted("prisma/migrations/20260101000000_init/migration.sql")).toBe(true);
  });

  it("allows the client module itself by exact path, not by directory proximity", () => {
    expect(isAllowlisted("src/lib/prisma.ts")).toBe(true);
    // Nothing else at src/lib/ root gets this exception just for being a
    // sibling — that would silently widen the allowlist to the whole
    // directory the moment a new top-level file appears.
    expect(isAllowlisted("src/lib/db-url.ts")).toBe(false);
    expect(isAllowlisted("src/lib/repos.ts")).toBe(false);
  });

  it("does not allow an adapter, a route, or an arbitrary data-layer helper", () => {
    expect(isAllowlisted("src/lib/import-items.ts")).toBe(false);
    expect(isAllowlisted("src/app/api/items/route.ts")).toBe(false);
    expect(isAllowlisted("src/adapters/mcp/tools.ts")).toBe(false);
  });

  it("does not allow a lookalike path that merely starts with an allowlisted name", () => {
    // A prefix check has to compare against a path with a trailing
    // separator, or "src/lib/settingsx/" would pass as a prefix match.
    expect(isAllowlisted("src/lib/settingsx/whatever.ts")).toBe(false);
    expect(isAllowlisted("src/lib/servicex/whatever.ts")).toBe(false);
  });

  it("pins the allowlist so a silent widening shows up as a diff", () => {
    expect(ALLOWLIST_PREFIXES).toEqual(["src/lib/service/", "src/lib/settings/", "prisma/"]);
    expect(ALLOWLIST_FILES).toEqual(["src/lib/prisma.ts"]);
  });

  it("pins the two specifiers this check restricts", () => {
    expect(RESTRICTED_MODULE_SPECIFIERS).toEqual(["@/lib/prisma", "@prisma/client"]);
  });
});

describe("check-db-import-allowlist — what it inspects", () => {
  it("only inspects .ts/.tsx under src/, not tests, scripts, prisma, or .d.ts files", () => {
    expect(isCheckable("src/lib/import-items.ts")).toBe(true);
    expect(isCheckable("src/app/api/items/route.ts")).toBe(true);
    expect(isCheckable("tests/import-items.test.ts")).toBe(false);
    expect(isCheckable("scripts/check-db-import-allowlist.mjs")).toBe(false);
    expect(isCheckable("prisma/seed.mjs")).toBe(false);
    expect(isCheckable("src/generated/prisma/index.d.ts")).toBe(false);
  });
});

describe("check-db-import-allowlist — as CI runs it (the negative control)", () => {
  it("fails on a fixture that deliberately breaks the allowlist", () => {
    // This is the negative control the rule exists to prove: a file outside
    // the allowlist that imports the real database client. If this ever
    // passes, the guard is not running.
    const { dir, file } = seedFile(
      "src/adapters/rogue-adapter.ts",
      [
        "// A deliberately non-compliant adapter: reaches the database",
        "// directly instead of calling the service layer.",
        'import { prisma } from "@/lib/prisma";',
        "",
        "export async function listPeopleDirectly() {",
        "  return prisma.person.findMany();",
        "}",
      ].join("\n"),
    );

    const result = runCli([file], dir);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("src/adapters/rogue-adapter.ts:3");
    expect(result.stderr).toContain('imports "prisma" from "@/lib/prisma"');
    expect(result.stderr).toContain("1 file outside the allowlist");
    // The failure has to point at the rule and where it lives, or the only
    // thing a contributor learns is that something failed.
    expect(result.stderr).toContain("CLAUDE.md");
  });

  it("fails on a fixture that constructs a raw PrismaClient outside the allowlist", () => {
    const { dir, file } = seedFile(
      "src/adapters/another-rogue-adapter.ts",
      [
        'import { PrismaClient } from "@prisma/client";',
        "",
        "export async function listPeopleEvenMoreDirectly() {",
        "  const client = new PrismaClient();",
        "  return client.person.findMany();",
        "}",
      ].join("\n"),
    );

    const result = runCli([file], dir);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("src/adapters/another-rogue-adapter.ts:1");
    expect(result.stderr).toContain('imports "PrismaClient" from "@prisma/client"');
  });

  it("fails on a deep relative-path import that evades the alias entirely — round-2 negative control", () => {
    // The exact evasion reported in review round 1: a file that never
    // writes "@/lib/prisma" at all, reaching the same module by a relative
    // path instead. Two directories under src/ (src/app/api/), so ../../
    // walks back up to src/ before descending into lib/prisma.
    const { dir, file } = seedFile(
      "src/app/api/route.ts",
      [
        "// Deliberately non-compliant: reaches the database via a relative",
        "// path instead of the @/ alias — no evidence in this file that it",
        '// even names "@/lib/prisma".',
        'import { prisma } from "../../lib/prisma";',
        "",
        "export async function GET() {",
        "  return Response.json(await prisma.person.findMany());",
        "}",
      ].join("\n"),
    );

    const result = runCli([file], dir);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("src/app/api/route.ts:4");
    expect(result.stderr).toContain('imports "prisma" from "../../lib/prisma"');
    expect(result.stderr).toContain("1 file outside the allowlist");
  });

  it("fails on a single-level relative-path import from a sibling directory of src/lib/service/", () => {
    const { dir, file } = seedFile(
      "src/lib/import/rogue-helper.ts",
      'import { prisma } from "../prisma";\n',
    );

    const result = runCli([file], dir);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("src/lib/import/rogue-helper.ts:1");
    expect(result.stderr).toContain('imports "prisma" from "../prisma"');
  });

  it("passes on a relative-path import of the client from inside the service layer — no false positive", () => {
    // The identical relative specifier as the negative control above,
    // written from an allowlisted location one directory deeper
    // (src/lib/service/, a sibling of the disallowed src/lib/import/ used
    // above) so "../prisma" resolves to the same src/lib/prisma either way.
    // Proves the allowlist decides the verdict for a relative import too,
    // not only for the alias form already covered by the pre-existing
    // "moved inside the service layer" test below.
    const { dir, file } = seedFile(
      "src/lib/service/another-live.ts",
      'import { prisma } from "../prisma";\n',
    );

    const result = runCli([file], dir);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("none found");
  });

  it("passes on the same fixture once it is moved inside the service layer", () => {
    // Proves the allowlist, not just the pattern match: identical import,
    // different location, different verdict.
    const { dir, file } = seedFile(
      "src/lib/service/rogue-adapter.ts",
      'import { prisma } from "@/lib/prisma";\n',
    );

    const result = runCli([file], dir);

    expect(result.status).toBe(0);
  });

  it("passes on a clean adapter that only uses type-only dependency injection", () => {
    const { dir, file } = seedFile(
      "src/adapters/clean-adapter.ts",
      [
        'import type { PrismaClient } from "@prisma/client";',
        "",
        'export function readPeople(client: Pick<PrismaClient, "person">) {',
        "  return client.person.findMany();",
        "}",
      ].join("\n"),
    );

    const result = runCli([file], dir);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("none found");
  });

  it("passing an explicit file list that filters down to nothing is not vacuous — it is a narrower, deliberate invocation, so it passes", () => {
    // Every named file happens to be allowlisted/non-checkable. That is not
    // evidence the check has stopped running — the caller chose exactly
    // these files. The vacuous-scan guard below is specifically about the
    // *default*, whole-repo invocation, where an empty result really would
    // mean the check silently checked nothing.
    const { dir, file } = seedFile("prisma/seed.mjs", "// allowlisted, not even .ts\n");

    const result = runCli([file], dir);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Scanned 0 files");
  });

  it("fails loudly, not silently green, when the default whole-repo scan finds nothing to check", () => {
    // A real git repo whose tracked tree has no src/*.ts at all — the case
    // `git ls-files -- src/**/*.ts` legitimately returns empty for. This is
    // the scenario the vacuous-scan guard exists to catch: run with no
    // explicit args, so it takes the `trackedSourceFiles()` path instead of
    // an explicit list, and prove it refuses to report success on an empty
    // set rather than passing by accident.
    const dir = mkdtempSync(path.join(tmpdir(), "db-import-allowlist-empty-"));
    tempDirs.push(dir);
    mkdirSync(path.join(dir, "prisma"), { recursive: true });
    writeFileSync(path.join(dir, "prisma", "seed.mjs"), "// no src/ in this tree\n", "utf8");
    execFileSync("git", ["init", "-q"], { cwd: dir });
    execFileSync("git", ["add", "-A"], { cwd: dir });
    execFileSync(
      "git",
      ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "init"],
      {
        cwd: dir,
      },
    );

    const result = runCli([], dir);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("zero non-allowlisted");
  });

  it("passes over this repository as it stands", () => {
    // The whole point of landing the check with the sweep: it is not merely
    // runnable, it is green on the tree it ships with — proving the current
    // allowlist (service layer, settings resolver, prisma.ts, prisma/) is
    // both correct and non-empty against real source.
    const repoRoot = path.resolve(import.meta.dirname, "..");
    const result = runCli([], repoRoot);

    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout).toMatch(/^Scanned \d+ files? outside the allowlist/);
  });
});
