// Two claims this row makes that only a scan can check (MILESTONES.md #30):
//
//   1. **Tools are derived from the operation registry, not hand-listed** —
//      so a new service operation cannot be silently missing from MCP.
//   2. **The adapter is mounted through row #26's adapter registry** — so
//      the name this route serves is the registry's, not a string typed
//      into a route file.
//
// The first is the one that is easy to fake. A test that enumerates the
// registry and asserts the tool list matches it passes trivially, because
// both sides come from the same object — it would keep passing if the
// adapter *did* hand-list its tools, as long as the hand-list happened to
// be right on the day it was written. So the expectation here is taken from
// somewhere the adapter cannot consult: a real operation file planted on
// disk, and a real operation object the adapter is handed. This is the
// pattern `tests/service-registry.test.ts` and `tests/adapter-registry.test.ts`
// established, applied to the derivation rather than to the registry.
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ADAPTER_REGISTRY, isAdapterName } from "@/lib/adapters";
import { defineOperation, listOperations } from "@/lib/service";
import { advertisedSchema, toolsFromOperations } from "@/lib/mcp";
import { MCP_HTTP_TRANSPORT } from "@/lib/mcp/http";
import { MCP_HTTP_ADAPTER } from "@/app/api/mcp/route";

/**
 * The real, git-tracked repo root — deliberately NOT `import.meta.dirname`.
 * See `tests/service-registry.test.ts`'s `repoRoot()` for the full
 * rationale (Stryker's instrumented sandbox).
 */
function repoRoot(): string {
  return execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf-8" }).trim();
}

const OPERATIONS_DIR = path.join(repoRoot(), "src/lib/service/operations");

/**
 * Every operation name declared in a directory, read from source.
 *
 * The same crude regex `service-registry.test.ts` uses, and crude for the
 * same reason: it must be unable to consult the registry it is checking.
 *
 * **Known limitation, inherited deliberately:** the pattern cannot see
 * through a constant — `defineOperation({ name: SOME_CONSTANT` is
 * invisible to it. Every operation in this repository writes the name as a
 * string literal, and the planted file below does too, so the limitation
 * does not weaken what is asserted here; it is recorded because a future
 * operation written the other way would be missed silently.
 */
function declaredOperationNamesIn(dir: string): string[] {
  const names: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".ts")) continue;
    const source = readFileSync(path.join(dir, entry.name), "utf-8");
    for (const match of source.matchAll(/defineOperation\(\{\s*name:\s*"([a-z0-9_]+)"/g)) {
      const name = match[1];
      if (name) names.push(name);
    }
  }
  return names.sort();
}

describe("MCP tools are derived from the operation registry", () => {
  it("exposes a tool for every operation the source tree declares", () => {
    // The expectation comes from the *files*, not from the registry the
    // adapter derives from — so an operation someone wrote and forgot to
    // register fails here as a missing tool, which is the failure this
    // criterion exists to make impossible.
    const declared = declaredOperationNamesIn(OPERATIONS_DIR);
    expect(declared.length).toBeGreaterThan(0);
    const toolNames = toolsFromOperations(listOperations())
      .map((tool) => tool.name)
      .sort();
    expect(toolNames).toEqual(declared);
  });

  it("would expose a tool for an operation planted on disk, once registered", () => {
    // Plants a real operation file that declares a name nothing has, and
    // proves two things at once: the source scan finds it (so the
    // assertion above is checking something real), and the derivation
    // would carry it through to a tool with no adapter change at all.
    const scratchDir = mkdtempSync(path.join(tmpdir(), "mcp-derivation-scan-"));
    try {
      writeFileSync(
        path.join(scratchDir, "planted-operation.ts"),
        `import { z } from "zod";\n` +
          `import { defineOperation } from "../operation";\n` +
          `export const plantedOperation = defineOperation({\n` +
          `  name: "planted_operation",\n` +
          `  kind: "read",\n` +
          `  summary: "A real operation declaration nothing registered.",\n` +
          `  input: z.object({}).strict(),\n` +
          `  async handler() {\n` +
          `    return { reached: true };\n` +
          `  },\n` +
          `});\n`,
      );

      // The scan sees it — proving the scan is capable of finding a gap.
      expect(declaredOperationNamesIn(scratchDir)).toEqual(["planted_operation"]);

      // And it is genuinely absent from what the adapter exposes, so the
      // gap is real rather than self-referential.
      const liveToolNames = toolsFromOperations(listOperations()).map((tool) => tool.name);
      expect(liveToolNames).not.toContain("planted_operation");

      // The derivation needs no adapter change to pick it up: handed the
      // operation, it produces the tool. That is the whole content of
      // "derived, not hand-listed" — there is no second list to edit.
      const planted = defineOperation({
        name: "planted_operation",
        kind: "read",
        summary: "A real operation declaration nothing registered.",
        input: z.object({}).strict(),
        async handler() {
          return { reached: true };
        },
      });
      const derived = toolsFromOperations([...listOperations(), planted]);
      expect(derived.map((tool) => tool.name)).toContain("planted_operation");
      const plantedTool = derived.find((tool) => tool.name === "planted_operation");
      expect(plantedTool?.description).toBe("A real operation declaration nothing registered.");
      expect(plantedTool?.readOnly).toBe(true);
    } finally {
      rmSync(scratchDir, { recursive: true, force: true });
    }
  });

  it("contains no hand-written tool name anywhere in the adapter", () => {
    // The structural half: if a tool name were ever typed into the adapter,
    // the derivation would have a competitor. Scanning for the real
    // operation names is the direct check — none of them may appear as a
    // literal in `src/lib/mcp/` or in the route.
    const root = repoRoot();
    const adapterFiles = [
      ...readdirSync(path.join(root, "src/lib/mcp"), { withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
        .map((entry) => path.join(root, "src/lib/mcp", entry.name)),
      path.join(root, "src/app/api/mcp/route.ts"),
    ];
    const operationNames = listOperations().map((operation) => operation.name);
    expect(operationNames.length).toBeGreaterThan(0);

    const offenders: string[] = [];
    for (const file of adapterFiles) {
      const source = readFileSync(file, "utf-8");
      for (const name of operationNames) {
        if (source.includes(`"${name}"`)) offenders.push(`${path.basename(file)}: "${name}"`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe("the MCP adapter is mounted through the adapter registry", () => {
  it("serves the registry's own mcp_http descriptor, not a string", () => {
    // The route exports the descriptor it took from `ADAPTER_REGISTRY`, so
    // this is identity, not equality: a route that had typed "mcp_http"
    // into a literal would fail here even though the name matched.
    expect(MCP_HTTP_ADAPTER).toBe(ADAPTER_REGISTRY.mcp_http);
    expect(MCP_HTTP_ADAPTER.name).toBe("mcp_http");
    expect(isAdapterName(MCP_HTTP_ADAPTER.name)).toBe(true);
  });

  it("is registered as a network adapter, which is what #94's driver split reads", () => {
    // §22's "in-process matrix … spawned subset" split turns on this field.
    // MCP over HTTP is a request away; #84's stdio binding is `embedded`.
    expect(MCP_HTTP_ADAPTER.transport).toBe("network");
    expect(ADAPTER_REGISTRY.mcp_stdio.transport).toBe("embedded");
  });

  it("stamps a transport name matching the session values SCHEMA §21 lists", () => {
    // §21's five values are `cli-direct · cli-http · mcp-stdio · mcp-http ·
    // http` — hyphenated, unlike the registry's snake_case adapter keys.
    // The two are deliberately different vocabularies, so this pins the one
    // the service actually receives.
    expect(MCP_HTTP_TRANSPORT).toBe("mcp-http");
  });
});

describe("the advertised schema", () => {
  it("never rejects, whatever it is handed", () => {
    // The property the whole wrapper exists for: the SDK must not refuse a
    // bad input before the service sees it, or MCP's rejection would carry
    // no code and no fields.
    const strict = z.object({ title: z.string().min(1) }).strict();
    const advertised = advertisedSchema(strict);

    expect(strict.safeParse({ nope: 1 }).success).toBe(false);
    const permissive = advertised.safeParse({ nope: 1 });
    expect(permissive.success).toBe(true);
    // And the original input survives, unsubstituted, so the service can
    // name the fields it objected to.
    expect(permissive.success && permissive.data).toEqual({ nope: 1 });
  });

  it("delegates the shape of an object schema, which is what makes it discoverable", () => {
    // `normalizeObjectSchema` decides whether the SDK renders a tool's real
    // JSON Schema or falls back to an empty one, and for a v3 schema it
    // decides by looking for `shape`. Without this delegation every tool
    // advertises `{}` — see `advertisedSchema`'s comment.
    const strict = z.object({ title: z.string(), count: z.number() }).strict();
    const advertised = advertisedSchema(strict) as unknown as { shape: Record<string, unknown> };
    expect(Object.keys(advertised.shape).sort()).toEqual(["count", "title"]);
  });

  it("adds no shape to a schema that is not an object", () => {
    // The other arm of that branch. A non-object schema has no shape to
    // delegate, and inventing one would make `normalizeObjectSchema` claim
    // an object where there is none.
    const scalar = z.string();
    const advertised = advertisedSchema(scalar);
    expect((advertised as unknown as { shape?: unknown }).shape).toBeUndefined();
    // It still must not reject — that property is independent of shape.
    expect(advertised.safeParse(12345).success).toBe(true);
  });
});
