// How a service operation becomes an MCP tool. See docs/plans/SCHEMA.md §18,
// §22 and MILESTONES.md #30.
//
// The tool list is *derived*, never written out. `listOperations()` is the
// canonical index (`../service/registry.ts`), so an operation that exists is
// an MCP tool by construction and an operation someone forgot cannot be
// silently missing from this adapter — there is no second list to forget it
// in. That is the property #94's conformance harness asserts across every
// adapter ("identical operations and identical rejections"), and deriving
// rather than listing is how this adapter satisfies the first half without
// any per-operation maintenance at all.
//
// Nothing in this module knows what a transport is. It turns operations into
// descriptors; `./server.ts` registers them; `./http.ts` decides how bytes
// arrive.
import type { z } from "zod";
import type { AnyOperation } from "@/lib/service";

/**
 * One MCP tool, as this adapter describes it to a client.
 *
 * `inputSchema` is the schema a client is *shown*. It is deliberately not
 * the schema anything is rejected by — see `advertisedSchema` below for why
 * that separation exists and what it buys.
 */
export interface McpToolDescriptor {
  /** The tool name a client calls. Identical to the operation's name. */
  readonly name: string;
  /** What the agent reads in its tool list (§18's "Description as the agent reads it"). */
  readonly description: string;
  /** The operation's own schema, for discovery. */
  readonly inputSchema: z.ZodTypeAny;
  /**
   * `read` operations are annotated read-only, which is the one hint a
   * client can act on without understanding what the tool does.
   */
  readonly readOnly: boolean;
}

/**
 * The operation's schema, wrapped so that parsing it can never fail.
 *
 * This looks odd, so it is worth being explicit about what it is for. The
 * MCP SDK validates a tool's declared `inputSchema` *before* it calls the
 * handler, and refuses a bad input by throwing its own error — one that
 * carries no `code` and no offending `fields`. The service layer refuses
 * the same input with `invalid_input` and the exact field paths, and §22's
 * first conformance assertion compares precisely those two things across
 * adapters. So if the SDK were allowed to reject first, MCP's rejection of
 * a malformed input would be structurally different from the web API's for
 * the identical call, and the "thin shell over one service call" claim
 * would be false at the only place it is observable.
 *
 * `.catch((ctx) => ctx.input)` resolves that without giving up discovery:
 *
 *   - **What reaches the handler is unchanged.** On a parse failure the
 *     original input is returned as-is rather than substituted, so the
 *     service sees exactly what the client sent and rejects it on its own
 *     terms.
 *   - **What a client sees is unchanged** — but only with the second step
 *     below, and this is the part that is easy to get wrong. The SDK
 *     renders a tool's JSON Schema by first asking `normalizeObjectSchema`
 *     whether the schema is an object, and falling back to an **empty**
 *     schema when it says no. A `ZodCatch` wraps an object rather than
 *     being one, so the naive wrapper advertises `{}` — every tool
 *     appearing to take no arguments at all, which is a worse outcome than
 *     the problem being solved. `normalizeObjectSchema`'s v3 test is the
 *     presence of a `shape`, so the wrapper is given one that delegates to
 *     the schema it wraps; the SDK then recognises it and renders the real
 *     fields, types, enums and required list.
 *
 * That second step leans on a detail of how the SDK identifies an object
 * schema, so it is guarded by a test rather than by trust:
 * `tests/mcp-server.test.ts`'s "advertises each operation's real input
 * schema" asserts a known field with its enum values survives into
 * `tools/list`, and goes red if a future SDK identifies object schemas
 * differently.
 *
 * The shape has to be found through `shapeOf` below, not read off `schema`
 * directly — see that function's own comment (MILESTONES.md #32) for why an
 * operation validated with `.refine()` has no `.shape` of its own to find.
 *
 * The one cost, stated plainly: on the *success* path the input is parsed
 * twice — once here and once inside `service.call` — so a schema whose
 * `.default()` is not idempotent (a timestamp, a random identifier) would
 * have that default computed on the first parse and then re-derived on the
 * second. No operation declares such a default, and the honest fix if one
 * ever does is for the default to be resolved inside the operation body,
 * where the transaction's clock applies, rather than in its schema.
 */
export function advertisedSchema(schema: z.ZodTypeAny): z.ZodTypeAny {
  const permissive = schema.catch((ctx: { input: unknown }) => ctx.input) as z.ZodTypeAny;
  const shape = shapeOf(schema);
  if (shape !== undefined) {
    Object.defineProperty(permissive, "shape", {
      get: () => shape,
      enumerable: false,
      configurable: true,
    });
  }
  return permissive;
}

/**
 * An object schema's shape, unwrapping `ZodEffects` to find it.
 *
 * `create_item` and `complete_item` (MILESTONES.md #26, #27) each validate a
 * cross-field rule with `.refine()` after `.strict()` — `create_item`
 * requires `originPersonId` alongside `originType: "person"`; `complete_item`
 * forbids smuggling a second `summary` through `fields`. `.refine()` wraps
 * the object in `ZodEffects`, a type with no `.shape` of its own, so reading
 * `schema.shape` directly finds nothing for either — and the SDK falls back
 * to advertising `{}`: no properties, no required list. For `complete_item`
 * that isn't merely a smaller tool description, it defeats the reason the
 * tool exists as its own operation at all — SCHEMA.md §18: "Separate from
 * `transition` on purpose — the required summary shape is in this tool's
 * schema, where the agent can see it."
 *
 * `ZodEffects._def.schema` is the schema being refined — always the object
 * whose shape the caller actually wants advertised, whatever kind of effect
 * wraps it (`.refine()`, `.superRefine()`, `.transform()` all use the same
 * `ZodEffects` wrapper around the same field, and MCP only ever needs the
 * *input* shape, not what a transform produces). Recurses rather than
 * unwrapping once, so a schema refined more than once is found the same way
 * a singly-refined one is.
 */
function shapeOf(schema: z.ZodTypeAny): unknown {
  const direct = (schema as { shape?: unknown }).shape;
  if (direct !== undefined) return direct;
  const inner = (schema as { _def?: { schema?: z.ZodTypeAny } })._def?.schema;
  return inner ? shapeOf(inner) : undefined;
}

/**
 * Every service operation, as an MCP tool.
 *
 * Takes the operation list as a parameter rather than importing the
 * registry, so a test can hand it a set it controls — and so this module
 * has no opinion about which operations exist, only about how one becomes a
 * tool.
 */
export function toolsFromOperations(operations: readonly AnyOperation[]): McpToolDescriptor[] {
  return operations.map((operation) => ({
    name: operation.name,
    description: operation.summary,
    inputSchema: operation.input as unknown as z.ZodTypeAny,
    readOnly: operation.kind === "read",
  }));
}
