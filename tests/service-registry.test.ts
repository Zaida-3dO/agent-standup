// The operation registry is canonical, not documentation.
//
// The trap this file exists to avoid: a test that enumerates the registry
// and asserts the registry contains what it enumerated passes forever and
// proves nothing. So the interesting assertions here get their expectation
// from somewhere *other* than the registry object —
//
//   - from the source tree, by reading every operation declared under
//     `src/lib/service/operations/` and requiring each to be registered
//     (this is the one that catches an operation someone wrote and forgot
//     to add, which is the actual failure mode);
//   - from the runtime, by requiring that an unregistered operation is
//     genuinely unreachable rather than merely unlisted.
import { readdirSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  OPERATION_NAMES,
  OPERATION_REGISTRY,
  ServiceRuntime,
  defineOperation,
  describeOperations,
  getOperation,
  isOperationName,
  listOperations,
  operationsOfKind,
  type TransactionHandle,
} from "@/lib/service";
import { defaultSnapshot } from "@/lib/settings";
import { z } from "zod";

/**
 * The real, git-tracked repo root — deliberately NOT `import.meta.dirname`.
 *
 * This test scans real source files on disk, so it needs the root of the
 * actual working tree rather than wherever this module happens to sit.
 * `git rev-parse --show-toplevel` walks up from the process's cwd and lands
 * on the real repo root, which is correct however the suite is invoked —
 * including from a copied or nested tree, where `import.meta.dirname` would
 * resolve to *a* `tests/` directory that is not the one under test — and a
 * scan rooted there would read that copy's source rather than the real one.
 */
function repoRoot(): string {
  return execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf-8" }).trim();
}

const OPERATIONS_DIR = path.join(repoRoot(), "src/lib/service/operations");

/**
 * A transaction handle that notes it was touched, so a test can assert an
 * operation body never ran rather than inferring it from the error alone.
 */
function handleThatRecords(onTouch: () => void): TransactionHandle {
  return {
    $queryRawUnsafe: async <T = unknown>(): Promise<T> => {
      onTouch();
      return [] as T;
    },
    $executeRawUnsafe: async (): Promise<number> => {
      onTouch();
      return 0;
    },
  };
}

/**
 * Every operation name declared in the source tree, found by reading the
 * files rather than by importing the registry.
 *
 * A regex over source is crude, and it is crude on purpose: it has to be
 * unable to consult the thing it is checking. Importing the modules and
 * reading their exports would work too, but it would pass for an operation
 * whose module is never imported by anything — which is exactly the file a
 * forgotten registration produces.
 */
function declaredOperationNames(): string[] {
  const names: string[] = [];
  for (const entry of readdirSync(OPERATIONS_DIR, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".ts")) continue;
    const source = readFileSync(path.join(OPERATIONS_DIR, entry.name), "utf-8");
    for (const match of source.matchAll(/defineOperation\(\{\s*name:\s*"([a-z0-9_]+)"/g)) {
      const name = match[1];
      if (name) names.push(name);
    }
  }
  return names.sort();
}

describe("the registry is canonical", () => {
  it("registers every operation declared in the operations directory", () => {
    const declared = declaredOperationNames();
    // Guards the guard: an empty scan would make the comparison below
    // vacuous, and §22 asks for exactly this assertion about the registry
    // it is computed against.
    expect(declared.length).toBeGreaterThan(0);
    expect([...OPERATION_NAMES].sort()).toEqual(declared);
  });

  it("exposes a non-empty registry", () => {
    // §22: "plus a direct assertion that the guard registry is not empty,
    // because an assertion evaluated over an empty set passes forever and
    // silently." The same reasoning applies to this registry, which every
    // conformance assertion is computed over.
    expect(OPERATION_NAMES.length).toBeGreaterThan(0);
    expect(listOperations().length).toBe(OPERATION_NAMES.length);
  });

  it("makes an unregistered operation unreachable, not merely unlisted", async () => {
    // This is what "canonical" means operationally: absence from the index
    // is not a documentation gap, it is a call that cannot be made. An
    // operation object that exists and is fully valid still cannot be
    // invoked while it is not registered.
    const orphan = defineOperation({
      name: "test_orphan",
      kind: "read",
      summary: "A perfectly valid operation that nothing registered.",
      input: z.object({}).strict(),
      async handler() {
        return { reached: true };
      },
    });

    expect(isOperationName(orphan.name)).toBe(false);
    expect(getOperation(orphan.name)).toBeUndefined();

    let bodyRan = false;
    const runtime = new ServiceRuntime({
      transaction: (body) =>
        body(
          handleThatRecords(() => {
            bodyRan = true;
          }),
        ),
      resolveSnapshot: async () => defaultSnapshot(),
    });

    const error = await runtime.call(orphan.name, {}).catch((e: unknown) => e);
    expect((error as { code: string }).code).toBe("not_found");
    expect(bodyRan).toBe(false);
  });

  it("reaches a registered operation through the same lookup", async () => {
    // The negative above is only meaningful if the positive works — that
    // the refusal is about registration and not about the runtime refusing
    // everything.
    const runtime = new ServiceRuntime({
      transaction: (body) => body(handleThatRecords(() => {})),
      resolveSnapshot: async () => defaultSnapshot(),
    });
    const result = await runtime.call("service_info", {});
    expect(result.operations.length).toBe(OPERATION_NAMES.length);
  });
});

describe("the registry's shape", () => {
  it("names each operation consistently with its registry key", () => {
    // A key and a `name` that disagree would make a lookup by name find an
    // operation that reports a different one — and conformance compares
    // by name, so the mismatch would be invisible on one side.
    for (const name of OPERATION_NAMES) {
      expect(OPERATION_REGISTRY[name].name).toBe(name);
    }
  });

  it("gives every operation a kind and a usable summary", () => {
    for (const operation of listOperations()) {
      expect(["read", "write"]).toContain(operation.kind);
      // The summary is what an adapter renders as a tool description or a
      // `--help` line, so an empty one is a broken adapter, not a nit.
      expect(operation.summary.trim().length).toBeGreaterThan(10);
    }
  });

  it("uses snake_case names, as every adapter's surface does", () => {
    for (const name of OPERATION_NAMES) {
      expect(name).toMatch(/^[a-z][a-z0-9_]*$/);
    }
  });

  it("partitions operations into read and write with nothing left over", () => {
    const reads = operationsOfKind("read");
    const writes = operationsOfKind("write");
    // §22's waiver rule turns on this partition: an adapter is read-only
    // by declaration or fully covered. A third kind would leave operations
    // the rule says nothing about.
    expect(reads.length + writes.length).toBe(OPERATION_NAMES.length);
  });

  it("describes operations with exactly what a catalogue consumer needs", () => {
    const described = describeOperations();
    expect(described.length).toBe(OPERATION_NAMES.length);
    for (const entry of described) {
      expect(Object.keys(entry).sort()).toEqual(["kind", "name", "summary"]);
      // Never the handler or the schema object: a catalogue is serialised
      // over a wire, and a function is not serialisable.
      expect(entry).not.toHaveProperty("handler");
    }
  });

  it("returns names in a stable order", () => {
    expect([...OPERATION_NAMES]).toEqual([...OPERATION_NAMES].sort());
    expect(listOperations().map((o) => o.name)).toEqual([...OPERATION_NAMES]);
  });
});
