// `standup mcp` (SCHEMA.md §20, MILESTONES.md #84) — MCP over stdio, for a
// no-server installation. DECISIONS.md §13f: "Everything else is substituted
// rather than lost: MCP moves to stdio, which is the standard local
// transport anyway."
//
// **Direct-only, deliberately.** The substitution §13f describes is
// specifically the no-server case, which is exactly `--direct`'s own
// condition: a `DATABASE_URL` to run the service layer in this process, no
// `STANDUP_URL` required. A server-backed installation already has MCP over
// HTTP (`../mcp/http.ts`); bridging stdio to a remote server as well would
// mean re-deriving `bindings/http.ts`'s request shape behind a second,
// harder-to-test path for a case this row was not asked to cover. If a
// bridged mode is ever wanted, it is a new row, not a silent addition here.
//
// This module does the two things `standup mcp` needs beyond the core
// itself: resolve whether a database is configured at all (the same
// preflight every other command does, via `resolveConfig`), and load the
// live service the same deferred way `run.ts`'s `direct` binding does, so a
// process that never runs `mcp` never pays for importing the database
// client.
import { EXIT, ok, type Envelope, type ExitCode } from "./envelope";
import { resolveConfig, type CliEnvironment, type CliFileConfig } from "./config";
import type { CallableService } from "./bindings/direct";
import { serveMcpStdio, type StdioServeOptions } from "@/lib/mcp/stdio";

export interface RunMcpStdioOptions extends StdioServeOptions {
  readonly env?: CliEnvironment;
  readonly file?: CliFileConfig;
  /**
   * How to build the in-process runtime. A parameter for the same reason
   * `run.ts`'s `RunCliOptions.loadService` is one: it lets a test drive this
   * command without a database, and keeps the composition root
   * (`@/lib/service/live`) out of this module's own import graph.
   */
  readonly loadService?: () => Promise<CallableService>;
}

export interface McpStdioOutcome {
  readonly envelope: Envelope;
  readonly exitCode: ExitCode;
}

/**
 * Runs `standup mcp`: preflights a database exactly as `--direct` does, then
 * serves one stdio connection until the client closes it.
 *
 * Returns rather than exits, for the reason `main.ts`'s own doc comment
 * gives for the entry point as a whole: a function that called
 * `process.exit` could not be tested for its exit code without a subprocess.
 * In the real binary this resolves only when stdin ends, which in practice
 * is when the process is about to end anyway.
 */
export async function runMcpStdio(options: RunMcpStdioOptions = {}): Promise<McpStdioOutcome> {
  const resolution = resolveConfig({
    flags: { direct: true },
    env: options.env,
    file: options.file,
  });
  if (!resolution.ok) {
    return { envelope: resolution.envelope, exitCode: resolution.exitCode };
  }

  const loadService =
    options.loadService ??
    (async () => (await import("@/lib/service/live")).service as CallableService);
  const service = await loadService();

  await serveMcpStdio((name, input, callOptions) => service.call(name, input, callOptions), {
    input: options.input,
    output: options.output,
  });

  return { envelope: ok({ transport: "mcp-stdio" }), exitCode: EXIT.OK };
}
