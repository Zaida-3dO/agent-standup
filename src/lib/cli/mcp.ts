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
// This module does the three things `standup mcp` needs beyond the core
// itself: resolve whether a database is configured at all (the same
// preflight every other command does, via `resolveConfig`), load the live
// service the same deferred way `run.ts`'s `direct` binding does, so a
// process that never runs `mcp` never pays for importing the database
// client, and — the third, added for the item this row shipped against —
// check the migration-drift report before serving a single call.
//
// ── Why the drift check happens here, and why it warns to stderr ─────────
//
// `standup mcp` is exactly DECISIONS.md §13f's no-server case: "the command
// line *is* the app — hook, rules and migrations are one installed package —
// so … the only remaining question is whether that package is current with
// the database's migration state." With ~N boxes each resolving `npx`
// independently, that question can have a different answer per box, and a
// stale package reading a schema ahead of it fails at the point of first
// use — a Prisma column-not-found error that names nothing about *why*. The
// warning below is what turns that into a diagnosis instead of a puzzle,
// printed once, before any tool call, rather than left for whichever
// operation happens to touch the missing column first.
//
// **stdout carries MCP protocol frames on this transport** (`@/lib/mcp/stdio`'s
// own header — one connection, newline-framed JSON-RPC both ways). Writing
// anything else there corrupts the stream from the client's point of view,
// so every line this module prints goes to stderr, which no MCP client
// reads and which the operator running the process still sees.
//
// **Refuses only on genuine incompatibility**, mirroring §13f's existing
// calibration for the hook ("a stale hook is advisory; an incompatible one
// may not claim"): `compareMigrationState`'s `"incompatible"` severity is
// the one case where this package's own migration history shares no common
// base with what the database has applied, meaning it cannot safely reason
// about the schema in front of it at all. Every other severity — package
// ahead of the database (ordinary pending migrations), database ahead of a
// package that still recognises its lineage, or the comparison could not be
// made — warns and continues, because refusing on an ordinary version bump
// would make every migration a breaking change (§13f's own objection) and
// most migrations are additive (§16's fail-open reasoning).
import { EXIT, ok, rejected, type Envelope, type ExitCode } from "./envelope";
import { resolveConfig, type CliEnvironment, type CliFileConfig } from "./config";
import type { CallableService } from "./bindings/direct";
import { serveMcpStdio, MCP_STDIO_TRANSPORT, type StdioServeOptions } from "@/lib/mcp/stdio";
import type { MigrationDriftReport } from "@/lib/migrations/state";

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
  /**
   * Where the migration-drift warning is written. Defaults to
   * `process.stderr`. A parameter for the same reason `input`/`output` are:
   * a test reads what was printed without touching the real process stream,
   * and — the property that actually matters here — nothing about this
   * module can be accidentally pointed at stdout by a future edit, because
   * stdout is not a value this function has in scope at all.
   */
  readonly stderr?: { write(chunk: string): void };
}

export interface McpStdioOutcome {
  readonly envelope: Envelope;
  readonly exitCode: ExitCode;
}

/**
 * Reads the migration-drift report via `describe_tool`, the same call an
 * agent on this session would make to ask the identical question
 * (`@/lib/service/operations/describe-tool`'s `ServiceFacts.migrations`).
 *
 * **Never throws.** A database reachable enough to answer `resolveConfig`'s
 * preflight but not this call is a real condition (a connection dropped
 * between the two, a permissions issue on `_prisma_migrations` specifically)
 * and refusing startup over it would be exactly the false refusal this row
 * exists to avoid — the honest answer when the check itself fails is "could
 * not be checked", which `severity: "none"` already means for the
 * comparison's own unreadable-history case. This mirrors that.
 */
async function driftReport(service: CallableService): Promise<MigrationDriftReport> {
  try {
    const facts = (await service.call(
      "describe_tool",
      {},
      {
        caller: { transport: MCP_STDIO_TRANSPORT },
      },
    )) as { migrations?: MigrationDriftReport };
    if (facts.migrations) return facts.migrations;
  } catch {
    // Fall through to the "could not be checked" answer below.
  }
  return {
    severity: "none",
    message: "Migration drift could not be checked before startup.",
    packageNewest: null,
    databaseNewest: null,
  };
}

/**
 * Runs `standup mcp`: preflights a database exactly as `--direct` does,
 * checks migration drift and warns or refuses accordingly, then serves one
 * stdio connection until the client closes it.
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
  const stderr = options.stderr ?? process.stderr;

  const drift = await driftReport(service);
  if (drift.severity === "incompatible") {
    // A refusal, not a service rejection — nothing was called that a
    // `Rejection` came back from. Built directly with `forbidden`, the code
    // `EXIT_BY_CODE` already maps to `EXIT.REJECTED`: the installation
    // declining on purpose, the same class `not_found` and `conflict` are
    // in, rather than a malformed command or an unexpected failure.
    stderr.write(`standup mcp: ${drift.message}\n`);
    return {
      envelope: rejected({ code: "forbidden", fields: [] }, drift.message),
      exitCode: EXIT.REJECTED,
    };
  }
  if (drift.severity !== "none") {
    stderr.write(`standup mcp: ${drift.message}\n`);
  }

  await serveMcpStdio((name, input, callOptions) => service.call(name, input, callOptions), {
    input: options.input,
    output: options.output,
  });

  return { envelope: ok({ transport: "mcp-stdio" }), exitCode: EXIT.OK };
}
