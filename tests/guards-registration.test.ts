// The guard registry is canonical, not documentation.
//
// Same trap `service-registry.test.ts` exists to avoid: a test that
// enumerates `ALL_GUARDS` and asserts the registry contains what it
// enumerated passes forever and proves nothing. The expectation here comes
// from the source tree instead — every guard `id` declared under
// `src/lib/service/guards/` must appear in `ALL_GUARDS`, which is what
// `guards/index.ts` registers into `guardRegistry`.
import { readdirSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ALL_GUARDS } from "@/lib/service/guards";
import { guardRegistry } from "@/lib/service/state-machine";
import { ALL_GUARDS as ALL_GUARDS_FROM_BARREL } from "@/lib/service";

/**
 * The real, git-tracked repo root — deliberately NOT `import.meta.dirname`.
 * See `tests/service-registry.test.ts`'s `repoRoot()` for the full
 * explanation: under mutation testing, Stryker runs this suite from inside
 * a sandbox copy of the tree with the source rewritten, and
 * `import.meta.dirname` resolves inside that sandbox — so a scan rooted on
 * it reads Stryker's instrumented source, finds no `id: "..."` matches, and
 * this test fails for a reason that has nothing to do with the registry it
 * checks. `git rev-parse --show-toplevel` always finds the real repo root,
 * both normally and from inside a Stryker sandbox.
 */
function repoRoot(): string {
  return execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf-8" }).trim();
}

const GUARDS_DIR = path.join(repoRoot(), "src/lib/service/guards");

/**
 * Every guard id declared in the source tree, found by reading the files
 * rather than by importing `ALL_GUARDS` — a regex over source that cannot
 * consult the thing it is checking, same shape as
 * `service-registry.test.ts`'s `declaredOperationNames`.
 */
function declaredGuardIds(): string[] {
  const ids: string[] = [];
  for (const entry of readdirSync(GUARDS_DIR, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".ts") || entry.name === "index.ts") continue;
    const source = readFileSync(path.join(GUARDS_DIR, entry.name), "utf-8");
    for (const match of source.matchAll(/\bid:\s*"([a-z0-9_.]+)"/g)) {
      const id = match[1];
      if (id) ids.push(id);
    }
  }
  return ids.sort();
}

describe("the guard registry is canonical", () => {
  it("registers every guard declared in the guards directory", () => {
    const declared = declaredGuardIds();
    // An empty scan would make the comparison below vacuous.
    expect(declared.length).toBeGreaterThan(0);
    expect([...ALL_GUARDS].map((g) => g.id).sort()).toEqual(declared);
  });

  it("exposes a non-empty registry — an empty-set assertion passes forever and proves nothing", () => {
    expect(ALL_GUARDS.length).toBeGreaterThan(0);
    expect(guardRegistry.size()).toBeGreaterThanOrEqual(ALL_GUARDS.length);
  });

  it("is the same list whether imported from the state-machine module or the service barrel", () => {
    // `guards/index.ts` re-exports through `@/lib/service`, and the barrel
    // must not accidentally fork the list — a second copy is exactly how
    // "canonical" quietly stops being true.
    expect([...ALL_GUARDS_FROM_BARREL].map((g) => g.id)).toEqual([...ALL_GUARDS].map((g) => g.id));
  });

  it("actually registers each declared guard into the shared guardRegistry singleton", () => {
    // Importing `ALL_GUARDS` (above) is what runs `guards/index.ts`'s
    // module-level registration loop — so by the time this test body runs,
    // the shared registry already has every guard, not merely a list that
    // claims to.
    for (const guard of ALL_GUARDS) {
      expect(guardRegistry.has(guard.id)).toBe(true);
    }
  });
});
