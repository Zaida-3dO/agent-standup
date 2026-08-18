// One driver per adapter, behind one interface. SCHEMA.md §22, MILESTONES.md #94.
//
// The map below is typed `Record<AdapterName, ConformanceDriver>`, where
// `AdapterName` is the adapter registry's key type — so **adding an adapter
// without adding its driver does not compile**. That is the compile-time
// half of assertion 4, and it is why the registry has to be genuinely what
// the application mounts through rather than a list kept for a test.
//
// Every driver runs **in-process**: a route handler is an exported async
// function, `callTool` is the MCP tool dispatch with no transport under it,
// and `runCommand` takes an argument vector. §22 asks for exactly this —
// run in-process wherever the process boundary is not the thing being
// tested — because the alternative is a suite whose cost grows with the
// case table and which therefore stops being run.
//
// What every driver shares, and why that isolates the variable: all four
// are handed the **same `ServiceRuntime` instance**. `ServiceRuntime`
// satisfies the direct binding's `CallableService` and MCP's `ServiceCall`
// structurally, and the HTTP routes reach it through a mocked composition
// root. So a difference in outcome cannot be a difference in service state,
// database or settings — the only variable left is the adapter, which is
// the claim being tested.
import { ADAPTER_NAMES, type AdapterName } from "../adapters/registry";
import { exposedOperations } from "../adapters/waivers";
import type { CallableService } from "../cli/bindings/direct";
import { HTTP_ROUTES } from "../cli/bindings/http";
import { COMMANDS } from "../cli/commands";
import { callTool } from "../mcp/server";
import { MCP_HTTP_TRANSPORT } from "../mcp/http";
import { MCP_STDIO_TRANSPORT } from "../mcp/stdio";
import { withRehearsalUnwrapping } from "../mcp/rehearsal";
import { listOperations } from "../service/registry";
import { toServiceError, type Rejection } from "../service/errors";

/** What a driver reports back. Deliberately the comparable part only. */
export type DriverOutcome =
  { readonly accepted: true } | { readonly accepted: false; readonly rejection: Rejection };

/**
 * One way into the application, reduced to what conformance compares.
 *
 * `invoke` takes an operation name and an input rather than a
 * transport-shaped request, because the case table is authored once per
 * operation and the driver is what knows how to say it in its own dialect.
 */
export interface ConformanceDriver {
  readonly name: AdapterName;
  /** Whether this adapter exposes the operation at all — a waived one is skipped, not failed. */
  exposes(operation: string): boolean;
  invoke(operation: string, input: unknown): Promise<DriverOutcome>;
}

/** Normalises any throw into the comparable refusal shape. */
function rejectionFrom(error: unknown): DriverOutcome {
  return { accepted: false, rejection: toServiceError(error).toRejection() };
}

/**
 * The MCP driver, for either transport.
 *
 * `mcp_http` and `mcp_stdio` differ in-process by exactly two things: the
 * transport string stamped on the caller, and the adapter name the waiver
 * filter reads. The tool set and the result shape are one code path, which
 * is why they are two registry entries over one implementation here rather
 * than two implementations that would drift.
 *
 * `withRehearsalUnwrapping` is applied because both real mount points apply
 * it. Without it a `transition_item` dry run — which rolls its transaction
 * back by throwing — reads as `internal` on MCP and as a success everywhere
 * else, and the harness would report a disagreement the product does not
 * have.
 */
function mcpDriver(adapter: "mcp_http" | "mcp_stdio", service: CallableService): ConformanceDriver {
  const transport = adapter === "mcp_http" ? MCP_HTTP_TRANSPORT : MCP_STDIO_TRANSPORT;
  const call = withRehearsalUnwrapping((name, input, options) =>
    service.call(name, input, options),
  );
  const exposed = new Set(
    exposedOperations(adapter, listOperations()).map((operation) => operation.name),
  );

  return {
    name: adapter,
    exposes: (operation) => exposed.has(operation),
    async invoke(operation, input) {
      const result = await callTool(call, transport, operation, input);
      if (result.isError !== true) return { accepted: true };
      // The rejection is recovered from `structuredContent`, never by
      // parsing the text block: the text is a rendering for a reader and
      // the structured half is the contract.
      const structured = result.structuredContent as Partial<Rejection> | undefined;
      return {
        accepted: false,
        rejection: {
          code: structured?.code ?? "internal",
          fields: structured?.fields ?? [],
          ...(structured?.guard === undefined ? {} : { guard: structured.guard }),
        },
      };
    },
  };
}

/**
 * The command-line driver.
 *
 * Drives `runCommand` from a real argument vector rather than calling a
 * binding directly, so the parse, the alias resolution and `buildInput` are
 * all in the path — those are adapter code, and an adapter that refuses
 * before the service sees the call is exactly the divergence §22 exists to
 * catch.
 *
 * `binding` is a parameter because §20 gives the command line two of them,
 * and "the command line on each of its two" is what §22 asks for: `direct`
 * runs the service in-process, `http` goes through the routes. They are one
 * adapter with two sub-drivers rather than two registry entries, because
 * the surface a user types is identical.
 */
/** Operation names the command line exposes, derived from its own command table. */
export function cliOperations(): Set<string> {
  return new Set(COMMANDS.map((command) => command.operation));
}

/** Operation names the web API exposes, derived from its own route table. */
export function httpOperations(): Set<string> {
  return new Set(Object.keys(HTTP_ROUTES));
}

/**
 * Builds the driver map.
 *
 * Typed as a total record over `AdapterName`, which is the assertion that
 * cannot be forgotten: a fifth adapter entered in the registry makes this
 * function stop compiling until its driver exists.
 */
export interface DriverMapOptions {
  readonly service: CallableService;
  /** The web API driver, supplied by the suite because it needs the route table mocked. */
  readonly http: ConformanceDriver;
  /** The command-line driver, supplied because it chooses a binding. */
  readonly cli: ConformanceDriver;
}

export function buildDriverMap({
  service,
  http,
  cli,
}: DriverMapOptions): Record<AdapterName, ConformanceDriver> {
  return {
    http,
    cli,
    mcp_http: mcpDriver("mcp_http", service),
    mcp_stdio: mcpDriver("mcp_stdio", service),
  };
}

/** Every driver in the map, in `ADAPTER_NAMES` order so a report never reorders. */
export function listDrivers(
  map: Record<AdapterName, ConformanceDriver>,
): readonly ConformanceDriver[] {
  return ADAPTER_NAMES.map((name) => map[name]);
}

export { rejectionFrom };
