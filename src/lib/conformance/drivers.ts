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
// **Where a driver starts is part of what it proves**, and for the command
// line that turned out to matter. A driver handed the case's input object
// and calling `binding.invoke` begins *after* `parseArgs` and `buildInput`,
// so it cannot see the adapter's own translation layer — which is where the
// `--limit`-as-a-string and `config set … true`-as-a-string bugs both lived.
// `cliArgvDriver` below starts at `argv` for cases that supply one, so that
// layer is inside the comparison rather than beneath it.
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
import type { Binding } from "../cli/binding";
import type { CallableService } from "../cli/bindings/direct";
import { HTTP_ROUTES } from "../cli/bindings/http";
import { COMMANDS } from "../cli/commands";
import { runCommand } from "../cli/run";
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

/**
 * How a case says itself as a command line.
 *
 * A conformance case is authored once as an operation and an input, but the
 * command line is the one adapter that cannot be handed an input object —
 * its caller types words and flags, and **turning those into the operation's
 * input is adapter code that can be wrong on its own** (`buildInput`,
 * `numericFlag`, `parseSettingValue`). A case that wants the command line
 * driven the way a person drives it supplies this; a case that does not
 * gets the binding-level driver, unchanged.
 */
export type ArgvFor = (input: Record<string, unknown>) => readonly string[] | undefined;

/**
 * The command-line driver, driven from a real argument vector.
 *
 * **Why this exists, stated plainly, because the difference is the whole
 * point.** The binding-level driver calls `binding.invoke(operation, input)`
 * with the case's input object — which starts *after* `parseArgs`,
 * `lookupCommand` and `buildInput` have already run. Every one of those is
 * command-line code, and two of the bugs this harness is meant to catch
 * lived in exactly that gap:
 *
 *   - `--limit` reached the operation as the string `"5"` against a
 *     `z.number()` field, so every command taking one was refused with
 *     `invalid_input` while the same operation worked everywhere else. The
 *     conversion that fixes it (`numericFlag`) is in `buildInput`, so a
 *     driver starting after `buildInput` cannot observe either the bug or
 *     the fix.
 *   - `standup config set <key> true` sent the string `"true"` to a
 *     `z.boolean()` setting for the same reason; `parseSettingValue` is
 *     what types it, and it too lives in `buildInput`.
 *
 * So this driver takes `argv` and runs `runCommand`, which is the real
 * entry point — parse, alias resolution, input building and dispatch all
 * in the path. The `Binding` underneath is still the same
 * `ServiceRuntime`, so the variable being isolated is unchanged: only the
 * adapter's own translation layer is added, which is precisely the layer
 * under test.
 *
 * An operation with no argv spelling for a case falls back to `invoke`,
 * rather than being skipped — a case the command line cannot express as
 * words is still a case its binding should agree on, and silently dropping
 * it would shrink the comparison without saying so.
 */
export function cliArgvDriver(options: {
  readonly binding: Binding;
  readonly argvFor: ArgvFor;
  readonly invoke: (operation: string, input: unknown) => Promise<DriverOutcome>;
}): ConformanceDriver {
  const exposed = cliOperations();
  return {
    name: "cli",
    exposes: (operation) => exposed.has(operation),
    async invoke(operation, input) {
      const argv = options.argvFor((input ?? {}) as Record<string, unknown>);
      if (argv === undefined) return options.invoke(operation, input);
      try {
        const outcome = await runCommand(argv, options.binding);
        if (outcome.envelope.ok) return { accepted: true };
        const error = outcome.envelope.error;
        // `malformed_command` is the command line refusing before the
        // service was ever reached. It is deliberately NOT mapped to a
        // service code here: mapping it would be the harness inventing an
        // agreement that does not exist, and a refusal no other adapter
        // makes is exactly the divergence this driver was added to expose.
        return {
          accepted: false,
          rejection: {
            code: error.code === "malformed_command" ? "invalid_input" : error.code,
            fields: [...error.fields],
            ...(error.guard === undefined ? {} : { guard: error.guard }),
          },
        };
      } catch (error) {
        return rejectionFrom(error);
      }
    },
  };
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
