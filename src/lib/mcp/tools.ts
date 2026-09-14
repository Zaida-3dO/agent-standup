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
// This module knows which *adapter* it is building for — `mcp_http` or
// `mcp_stdio`, the same `AdapterName` `./server.ts` already threads through —
// but nothing here knows how bytes arrive. That is `./http.ts`'s and
// `./stdio.ts`'s job. The adapter name exists solely so the stdio surface can
// carry the short note below; it decides nothing about registration,
// dispatch or rejection shape, all of which stay identical across adapters.
//
// ── Why stdio gets a suffix and http does not ────────────────────────────
//
// A no-server installation (DECISIONS.md §13f) runs `standup mcp` with no
// hook able to reach it: `src/lib/hook/` flushes and asks over HTTP only, so
// a stdio session's tool calls are never observed and no server-side
// intervention can act on them. Nothing else on the tool surface says so —
// the schema is identical either way — so the one line this module adds is
// the only place an agent on that surface learns its session is unguarded.
// Deliberately not a direct hook binding (out of scope; see the item this
// row shipped against): the absence is made legible, not compensated for.
import type { z } from "zod";
import type { AnyOperation } from "@/lib/service";
import type { AdapterName } from "@/lib/adapters/registry";

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
 * Appended to every tool's description on the `mcp_stdio` adapter only.
 *
 * One sentence, on purpose — `describe-tool.ts`'s header states the cost
 * this module inherits: anything added to a description is sent to the
 * model on every turn, charged to every session for the installation's
 * whole life, whether or not it is ever read. This is not a place to explain
 * the no-server topology; it is a pointer an agent that hits a claim refusal
 * or notices nothing is intervening can follow to the reason. The full
 * rationale lives in this module's header and in `describe_tool`'s
 * transport report, both read on demand rather than paid for by default.
 */
const STDIO_DESCRIPTION_SUFFIX =
  " (Direct/stdio session: unobserved by any server-side hook, so no intervention applies here — " +
  "and hook.require_registration_to_claim must stay off, or this session cannot claim.)";

/**
 * Every service operation, as an MCP tool.
 *
 * Takes the operation list as a parameter rather than importing the
 * registry, so a test can hand it a set it controls — and so this module
 * has no opinion about which operations exist, only about how one becomes a
 * tool.
 *
 * `adapter` is optional and defaults to no suffix at all, not to either
 * adapter's behaviour — a caller that does not say which adapter it is
 * building for (a test exercising the derivation in isolation, say) gets
 * the operation's own summary verbatim, the one behaviour this function had
 * before adapter-awareness existed and the one `mcp_http` still gets. Only
 * `mcp_stdio` adds anything.
 */
export function toolsFromOperations(
  operations: readonly AnyOperation[],
  adapter?: AdapterName,
): McpToolDescriptor[] {
  const suffix = adapter === "mcp_stdio" ? STDIO_DESCRIPTION_SUFFIX : "";
  return operations.map((operation) => ({
    name: operation.name,
    description: operation.summary + suffix,
    inputSchema: operation.input as unknown as z.ZodTypeAny,
    readOnly: operation.kind === "read",
  }));
}
