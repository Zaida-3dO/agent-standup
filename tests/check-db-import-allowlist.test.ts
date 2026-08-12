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
  RESTRICTED_MODULE_SPECIFIERS,
  findViolations,
  isAllowlisted,
  isCheckable,
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
