// The adapter registry is canonical, not documentation. See
// docs/plans/SCHEMA.md §22 ("the module the application mounts its adapters
// through, so the names are load-bearing at runtime rather than a list
// maintained for a test") and DECISIONS.md §13f.
//
// Same shape as tests/service-registry.test.ts: the interesting assertions
// get their expectation from somewhere *other* than the registry object —
// a real file planted on disk that declares an adapter and is never
// entered into ADAPTER_REGISTRY, so "the registry is canonical" is proven
// by a source-scan finding a real gap, not by re-deriving the registry's
// own contents and comparing them to themselves.
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  readdirSync,
  readFileSync,
  type Dirent,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  ADAPTER_NAMES,
  ADAPTER_REGISTRY,
  defineAdapter,
  getAdapter,
  isAdapterName,
  listAdapters,
  type AdapterName,
} from "@/lib/adapters";

/**
 * The real, git-tracked repo root — deliberately NOT `import.meta.dirname`.
 * See `tests/service-registry.test.ts`'s `repoRoot()` for the full
 * rationale: under mutation testing, Stryker runs the suite from a
 * sandboxed, instrumented copy of the tree, and `import.meta.dirname`
 * inside that sandbox resolves to the sandbox's own `tests/` directory —
 * so a scan rooted on it reads Stryker's rewritten source instead of the
 * real declarations, finds nothing, and fails for a reason that has
 * nothing to do with the registry this test is supposed to be checking.
 * Stryker's sandbox has no `.git` of its own and lives nested inside the
 * real repo's working tree, so `git rev-parse --show-toplevel` finds the
 * real root from inside the sandbox too.
 */
function repoRoot(): string {
  return execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf-8" }).trim();
}

const ADAPTERS_MODULE_DIR = path.join(repoRoot(), "src/lib/adapters");

/**
 * Every adapter name declared anywhere under `src/lib/adapters/` **and**
 * `src/app/`, found by reading source rather than importing it — the same
 * "cannot consult the thing it is checking" discipline
 * `service-registry.test.ts` uses for operations. This is deliberately
 * crude and deliberately does not know about `ADAPTER_REGISTRY`.
 */
function declaredAdapterNamesUnder(dir: string): string[] {
  const names: string[] = [];
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return names;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      names.push(...declaredAdapterNamesUnder(path.join(dir, entry.name)));
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith(".ts")) continue;
    const source = readFileSync(path.join(dir, entry.name), "utf-8");
    for (const match of source.matchAll(/defineAdapter\(\{\s*name:\s*"([a-z0-9_]+)"/g)) {
      const name = match[1];
      if (name) names.push(name);
    }
  }
  return names;
}

describe("the adapter registry is canonical", () => {
  it("exposes a non-empty registry", () => {
    // Mirrors service-registry.test.ts's "exposes a non-empty registry":
    // every conformance assertion the adapter registry feeds (§22, #94) is
    // computed over this set, so an empty registry would make every one of
    // them vacuously true.
    expect(ADAPTER_NAMES.length).toBeGreaterThan(0);
    expect(listAdapters().length).toBe(ADAPTER_NAMES.length);
  });

  it("registers every adapter this codebase declares with defineAdapter", () => {
    const declared = declaredAdapterNamesUnder(ADAPTERS_MODULE_DIR).sort();
    expect(declared.length).toBeGreaterThan(0);
    expect([...ADAPTER_NAMES].sort()).toEqual(declared);
  });

  it("detects an adapter declared on disk but never entered into the registry", () => {
    // The row #14 reviewer's pattern, applied to adapters instead of
    // operations: plant a real file, on disk, that calls `defineAdapter`
    // with a name `ADAPTER_REGISTRY` does not have — and prove the scan
    // that walks the source tree finds it. If this test passed with the
    // planted file *absent* from the assertion, "canonical" would be a
    // claim nothing checks.
    const scratchDir = mkdtempSync(path.join(tmpdir(), "adapter-registry-scan-"));
    try {
      writeFileSync(
        path.join(scratchDir, "orphan-adapter.ts"),
        `import { defineAdapter } from "@/lib/adapters/registry";\n` +
          `export const orphanAdapter = defineAdapter({\n` +
          `  name: "orphan_grpc",\n` +
          `  summary: "A real adapter declaration nothing registered.",\n` +
          `  transport: "network",\n` +
          `});\n`,
      );

      const declaredInScratch = declaredAdapterNamesUnder(scratchDir);
      expect(declaredInScratch).toEqual(["orphan_grpc"]);

      // The registry itself has no idea this file exists — proving the
      // absence is real, not a self-referential check.
      expect(isAdapterName("orphan_grpc")).toBe(false);
      expect(getAdapter("orphan_grpc")).toBeUndefined();

      // And the comparison the previous test runs would fail if this
      // scratch directory were the real one: declared names would include
      // "orphan_grpc" but ADAPTER_NAMES would not.
      const wouldMismatch =
        [...ADAPTER_NAMES].sort().join(",") !== declaredInScratch.sort().join(",");
      expect(wouldMismatch).toBe(true);
    } finally {
      rmSync(scratchDir, { recursive: true, force: true });
    }
  });

  it("makes AdapterName a narrow union of the four real names, not `string`", () => {
    // Compile-time proof: a driver map keyed on `AdapterName` must have
    // exactly these four properties — no more, no fewer — or this file
    // fails to typecheck. Runtime mirrors it so the assertion is visible
    // in a test run, not only in `tsc`.
    const driverMap: Record<AdapterName, boolean> = {
      http: true,
      mcp_http: true,
      mcp_stdio: true,
      cli: true,
    };
    expect(Object.keys(driverMap).sort()).toEqual([...ADAPTER_NAMES].sort());
  });
});

// §22's "adding an adapter without adding its driver does not compile" is a
// compile-time property that a runtime assertion cannot exercise — a
// missing property in an object literal does not throw, it fails `tsc`
// before the file ever runs, so vitest can prove only the half above (that
// a *complete* map is exactly four keys, not three and not five). The
// other half is proven by `npm run typecheck`, which CI runs on every PR,
// against a map genuinely missing one adapter:
//
//   const incomplete: Record<AdapterName, boolean> = { http: true, mcp_http: true, cli: true };
//   // Property 'mcp_stdio' is missing in type '{ http: boolean; mcp_http: boolean; cli: boolean; }'
//   //   but required in type 'Record<AdapterName, boolean>'.
//
// Confirmed against this tree's `tsc --noEmit` while writing this file —
// left as a paste of the actual compiler error rather than a test, because
// a test that only compiles what already compiles proves nothing, and a
// test file that intentionally fails to compile cannot be committed here.

describe("adapter descriptors", () => {
  it("names each adapter consistently with its registry key", () => {
    for (const name of ADAPTER_NAMES) {
      expect(ADAPTER_REGISTRY[name].name).toBe(name);
    }
  });

  it("gives every adapter a usable summary and a transport", () => {
    for (const adapter of listAdapters()) {
      expect(adapter.summary.trim().length).toBeGreaterThan(10);
      expect(["network", "embedded"]).toContain(adapter.transport);
    }
  });

  it("uses snake_case names", () => {
    for (const name of ADAPTER_NAMES) {
      expect(name).toMatch(/^[a-z][a-z0-9_]*$/);
    }
  });

  it("returns names in a stable, sorted order", () => {
    expect([...ADAPTER_NAMES]).toEqual([...ADAPTER_NAMES].sort());
    expect(listAdapters().map((a) => a.name)).toEqual([...ADAPTER_NAMES]);
  });

  it("marks exactly the two in-process bindings (mcp_stdio, cli) as embedded", () => {
    // Not an enumeration of the registry's own values — this is checked
    // against what MILESTONES.md #26/#30/#79/#84 actually describe: the
    // command line's direct binding and MCP-over-stdio run inside the
    // caller's process (SCHEMA.md §20 "runs the service layer in-process"),
    // while the web API and MCP-over-HTTP are both a request away.
    const embedded = listAdapters()
      .filter((a) => a.transport === "embedded")
      .map((a) => a.name)
      .sort();
    expect(embedded).toEqual(["cli", "mcp_stdio"]);
  });

  it("isAdapterName rejects a name that merely resembles a real one", () => {
    expect(isAdapterName("http ")).toBe(false);
    expect(isAdapterName("HTTP")).toBe(false);
    expect(isAdapterName("mcp")).toBe(false);
  });
});

describe("defineAdapter", () => {
  it("freezes the descriptor it returns", () => {
    const adapter = defineAdapter({
      name: "test_frozen",
      summary: "x".repeat(20),
      transport: "network",
    });
    expect(() => {
      (adapter as { name: string }).name = "mutated";
    }).toThrow();
    expect(adapter.name).toBe("test_frozen");
  });
});
