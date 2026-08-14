// Structural proof for the two boundaries MILESTONES.md #42 has to hold —
// applied to `src/lib/hook/**` and `src/bin/standup-hook.ts`.
//
// **1. The adapter boundary** (CLAUDE.md, "Working in this repo"; SCHEMA.md
// §22). The hook is an adapter: it resolves input, makes one service call
// through the API, and shapes the result. It may not reach the database or a
// guard directly. Same scanner as `tests/hook-route-thin-shell.test.ts` —
// see that file's header for why `findViolations` is imported from the check
// script rather than re-derived, and why `repoRoot()` uses `git rev-parse`.
//
// **2. The process boundary.** `src/lib/hook/**` must stay free of
// `process`, `node:fs` and a global `fetch`, because that property is what
// makes every refusal in this row testable as a value in and a value out.
// It is asserted rather than trusted: an `import { readFileSync }` added to
// `rules-cache.ts` during a later row would silently move the cache read
// inside the tested code and out of the injected surface, and no behavioural
// test would notice — the tests would still pass, having stopped exercising
// the path the process actually takes.
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
const HOOK_LIB_DIR = path.resolve(REPO_ROOT, "src/lib/hook");
const HOOK_BIN = path.resolve(REPO_ROOT, "src/bin/standup-hook.ts");

function toPosix(p: string): string {
  return p.split("\\").join("/");
}

function tsFilesUnder(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...tsFilesUnder(full));
    else if (entry.isFile() && entry.name.endsWith(".ts")) files.push(full);
  }
  return files;
}

function repoRelative(absolutePath: string): string {
  return toPosix(path.relative(REPO_ROOT, absolutePath));
}

describe("the hook never imports the database client directly", () => {
  it("every file under src/lib/hook and the hook entry point is clean", () => {
    const files = [...tsFilesUnder(HOOK_LIB_DIR), HOOK_BIN];
    // Guards the guard: an empty file list would make the assertion below
    // vacuously true.
    expect(files.length).toBeGreaterThan(1);

    const offenders = files.filter((file) => {
      const source = readFileSync(file, "utf-8");
      return (findViolations(source, repoRelative(file)) as unknown[]).length > 0;
    });
    expect(offenders).toEqual([]);
  });

  it("detects a planted violation at the same depth as a real hook module", () => {
    // Proves the scan above can fail rather than merely being green: without
    // this, a scanner that returned `[]` for everything would pass.
    const scratchDir = mkdtempSync(path.join(tmpdir(), "hook-lib-scan-"));
    try {
      const planted = path.join(scratchDir, "decide.ts");
      writeFileSync(
        planted,
        `import { prisma } from "../prisma";\nexport const rules = () => prisma.setting.findMany();\n`,
      );
      const source = readFileSync(planted, "utf-8");
      const violations = findViolations(source, "src/lib/hook/decide.ts") as unknown[];
      expect(violations.length).toBeGreaterThan(0);
    } finally {
      rmSync(scratchDir, { recursive: true, force: true });
    }
  });
});

describe("the decision logic stays free of the process it runs in", () => {
  const libFiles = tsFilesUnder(HOOK_LIB_DIR);

  it("scans a non-empty set of files", () => {
    expect(libFiles.length).toBeGreaterThan(0);
  });

  it("no module under src/lib/hook imports node:fs or reads process", () => {
    // The property that makes an unreadable cache and an unreachable server
    // testable without a temporary directory or a socket. `src/bin` is
    // exempt by design and is asserted separately below.
    const offenders = libFiles
      .map((file) => ({ file: repoRelative(file), source: readFileSync(file, "utf-8") }))
      .filter(
        ({ source }) =>
          /from\s+"node:(fs|process|child_process|net|http|https)"/.test(source) ||
          /\bprocess\.(env|argv|stdin|stdout|stderr|exit)\b/.test(source),
      )
      .map(({ file }) => file);

    expect(offenders).toEqual([]);
  });

  it("no module under src/lib/hook reaches for the global fetch", () => {
    // `ask-http.ts` calls a `fetch` it was *handed*; what it must never do
    // is reach for the ambient one, which would make the transport
    // untestable without a live server — and the failure paths are the whole
    // point of this row. The distinction is exactly `globalThis.fetch`, so
    // that is what is matched: a bare `fetch(` is the injected parameter and
    // is correct.
    const offenders = libFiles
      .map((file) => ({ file: repoRelative(file), source: readFileSync(file, "utf-8") }))
      .filter(({ source }) => /\bglobalThis\.fetch\b/.test(source))
      .map(({ file }) => file);

    expect(offenders).toEqual([]);
  });

  it("ask-http takes fetch as a parameter rather than closing over an ambient one", () => {
    // The positive half of the rule above: the negative check alone would
    // pass on a module that had no `fetch` at all, so this pins that the
    // transport is genuinely injected.
    const source = readFileSync(path.join(HOOK_LIB_DIR, "ask-http.ts"), "utf-8");
    expect(source).toMatch(/readonly fetch: FetchLike/);
  });

  it("the entry point is the only place the process is touched", () => {
    // The mirror of `src/bin/standup.ts`'s own header: "the only module in
    // this build that touches `process`". Asserted so the split cannot erode
    // one convenient import at a time.
    const entry = readFileSync(HOOK_BIN, "utf-8");
    expect(entry).toMatch(/process\.stdin/);
    expect(entry).toMatch(/process\.exitCode/);
  });
});

describe("the hook shares the server's matcher rather than reimplementing it", () => {
  it("decide.ts imports decideHook instead of constructing its own RegExp", () => {
    // DECISIONS.md §4's "one script has nothing to agree with", applied to
    // the matcher. Two implementations of one match are two things that can
    // disagree about whether a pattern matched — and the disagreement would
    // be invisible until it allowed something.
    const source = readFileSync(path.join(HOOK_LIB_DIR, "decide.ts"), "utf-8");
    expect(source).toMatch(
      /import\s*\{[^}]*decideHook[^}]*\}\s*from\s*"@\/lib\/service\/hook-decision"/,
    );
    expect(source).not.toMatch(/new RegExp\(/);
  });
});
