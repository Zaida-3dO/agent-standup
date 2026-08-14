// The dispatcher: one command implementation above both bindings
// (SCHEMA.md §20, DECISIONS §13f).
//
// **This is the file that makes AC5 structurally true rather than tested
// into existence.** `runCommand` takes a `Binding` and never asks which one
// it is. There is no branch on `binding.name` anywhere below, and there is
// nothing for one to branch on: a command produces an operation name and an
// input, `invoke` answers, and the answer becomes an envelope. Two bindings
// can only diverge in what `invoke` does, which is exactly the surface the
// conformance suite (§22, row #94) pins.
//
// `runCli` below is the thin layer that *chooses* a binding from the
// environment and then hands it to `runCommand`. Keeping the choosing and
// the running in separate functions is deliberate: it is what lets a test
// drive the identical command path with a binding it constructed, which is
// the only way to prove "the same command works either way" without
// standing up a server inside a unit test.
import { parseArgs, booleanFlag, type ParsedArgs } from "./args";
import { COMMANDS, identityFlags, lookupCommand, nouns } from "./commands";
import { resolveConfig, type CliEnvironment, type CliFileConfig } from "./config";
import { createDirectBinding, type CallableService } from "./bindings/direct";
import { createHttpBinding, type FetchLike } from "./bindings/http";
import {
  EXIT,
  exitCodeFor,
  malformed,
  ok,
  rejected,
  type Envelope,
  type ExitCode,
} from "./envelope";
import type { Binding } from "./binding";
import { doctorReport } from "./doctor";
import { runInitCommand } from "./init";
import { runMcpStdio } from "./mcp";
import { HOOK_VERBS, isHookVerb, runHookCommand, type SpoolStore } from "./hook-command";
import type { RunHookOptions } from "@/lib/hook/run";
import type { SendBatch } from "@/lib/hook/flush";
import type { RenderedResponse } from "@/lib/hook/response";

/** What one run produced: the envelope, the exit code, and how to render it. */
export interface RunOutcome {
  readonly envelope: Envelope;
  readonly exitCode: ExitCode;
  /** Which binding ran, when one did. Absent for a command refused before dispatch. */
  readonly binding?: string;
  /**
   * The verbatim response for an agent tool, set only by `standup hook run`
   * (MILESTONES.md #88). Present *instead of* a meaningful envelope: a hook
   * reader parses a specific JSON shape on stdout and a specific exit code
   * (`@/lib/hook/response`), and neither survives being wrapped in
   * `{ok, data}`. `render` writes this through untouched when it is set,
   * which is what keeps `--json` from being able to change what a guard
   * says.
   */
  readonly hookResponse?: RenderedResponse;
}

/**
 * Runs one already-resolved command against one binding.
 *
 * Takes `argv` rather than a pre-parsed command so that parsing, alias
 * resolution and input building are inside the path a conformance test
 * exercises — a test that started after parsing would prove the bindings
 * agree about `get_item` while saying nothing about whether `show` and
 * `item get` reach it the same way.
 */
export async function runCommand(argv: readonly string[], binding: Binding): Promise<RunOutcome> {
  const parsed = parseArgs(argv);
  if (!parsed.ok) return refuse(parsed.envelope);

  const found = lookupCommand(parsed.parsed.words);
  if (!found.ok) return refuse(found.envelope);

  const built = found.match.command.buildInput(found.match.rest, parsed.parsed.flags);
  if (!built.ok) return refuse(built.envelope);

  const result = await binding.invoke(found.match.command.operation, built.input);

  if (result.ok) {
    const envelope = ok(result.data);
    return { envelope, exitCode: exitCodeFor(envelope), binding: binding.name };
  }

  const envelope = rejected(result.rejection, result.message);
  return { envelope, exitCode: exitCodeFor(envelope), binding: binding.name };
}

function refuse(envelope: Envelope): RunOutcome {
  return { envelope, exitCode: exitCodeFor(envelope) };
}

export interface RunCliOptions {
  readonly env?: CliEnvironment;
  readonly file?: CliFileConfig;
  /**
   * How to build the in-process runtime, called only if the `direct`
   * binding is selected. A function rather than a value so that resolving
   * to `http` never loads the composition root — which is what keeps a
   * command against a server from needing a database client in the process
   * at all.
   */
  readonly loadService?: () => Promise<CallableService>;
  readonly fetch?: FetchLike;
  /**
   * Everything `standup hook` needs from outside this process's control —
   * the payload on stdin, the spool file, and how to send a batch
   * (MILESTONES.md #88). A parameter for the same reason `loadService` is
   * one: it keeps the filesystem out of this module's import graph, and it
   * is what lets a full disk and an unreachable server be tested as values.
   */
  readonly hook?: HookCommandEdges;
}

/** The process edges `standup hook` needs. Supplied by the entry point. */
export interface HookCommandEdges {
  readonly spool: SpoolStore;
  /** Epoch milliseconds. */
  readonly now: number;
  /** Everything the agent tool wrote to stdin. Only `hook run` reads it. */
  readonly stdin?: string;
  readonly hook?: Omit<RunHookOptions, "stdin" | "now">;
  readonly send?: SendBatch;
  readonly batchSize?: number;
  readonly maxRecords?: number;
}

/**
 * `standup hook <verb>`.
 *
 * An unrecognised verb — and a missing one — is refused as malformed rather
 * than defaulting to `run`. Defaulting would mean a typo (`standup hook
 * flsuh`) silently executing the decision path against an empty stdin,
 * which renders a **deny**: a mistyped maintenance command would answer as
 * though it were a guard refusing a tool call.
 *
 * Reaching this command with no edges is likewise refused rather than
 * treated as an empty spool. The binary always supplies them, so their
 * absence means the command line was driven by something that built it
 * wrong, and reporting a successful flush of zero records would hide that.
 */
async function runCliHook(rest: readonly string[], options: RunCliOptions): Promise<RunOutcome> {
  const verb = rest[0];
  if (!isHookVerb(verb)) {
    return refuse(
      malformed(
        `standup hook needs one of: ${HOOK_VERBS.join(", ")}${verb === undefined ? "" : ` (got "${verb}")`}`,
        ["verb"],
      ),
    );
  }

  const edges = options.hook;
  if (edges === undefined) {
    return refuse(malformed("standup hook is not available on this entry point", ["hook"]));
  }

  const outcome = await runHookCommand({
    verb,
    spool: edges.spool,
    now: edges.now,
    ...(edges.stdin === undefined ? {} : { stdin: edges.stdin }),
    ...(edges.hook === undefined ? {} : { hook: edges.hook }),
    ...(edges.send === undefined ? {} : { send: edges.send }),
    ...(edges.batchSize === undefined ? {} : { batchSize: edges.batchSize }),
    ...(edges.maxRecords === undefined ? {} : { maxRecords: edges.maxRecords }),
  });

  if (outcome.kind === "hook-response") {
    // The envelope here is a placeholder that `render` never writes, because
    // `hookResponse` takes precedence. It is still an honest `ok`: the hook
    // ran and answered, and the answer is the response.
    //
    // **The exit code is the hook's own, passed through unchanged.** It is
    // not mapped onto the command line's `EXIT` table, and the fact that
    // `HOOK_EXIT.DENY` and `EXIT.MALFORMED` are both `2` is a coincidence
    // this deliberately does not rely on: the meaning of the code here is
    // "a hook denied", set by `@/lib/hook/response` for the reason its own
    // header gives (agent tools read `2` as "block and feed stderr back to
    // the model"). Mapping it through the envelope table would make a
    // guard's refusal depend on two unrelated enumerations continuing to
    // agree by accident.
    return {
      envelope: ok({ transport: "hook" }),
      exitCode: outcome.response.exitCode as ExitCode,
      hookResponse: outcome.response,
    };
  }

  return { envelope: outcome.envelope, exitCode: outcome.exitCode };
}

/**
 * The whole command line: choose a binding, then run the command.
 *
 * The binding choice is §17.1's rule and nothing more. Note what is *not*
 * here: no command name influences it, and no command is reachable on one
 * binding and not the other. A command that needed a server would be a
 * command that had to know its own transport, which DECISIONS §13f rules
 * out — "a caller that must know its own transport is exactly what goes
 * stale when an installation changes shape."
 */
export async function runCli(
  argv: readonly string[],
  options: RunCliOptions = {},
): Promise<RunOutcome> {
  const parsed = parseArgs(argv);
  if (!parsed.ok) return refuse(parsed.envelope);

  const { words, flags } = parsed.parsed;

  const help = booleanFlag(flags, "help");
  if (!help.ok) return refuse(help.envelope);
  if (help.value || words.length === 0) {
    return { envelope: ok(helpText()), exitCode: EXIT.OK };
  }

  const direct = booleanFlag(flags, "direct");
  if (!direct.ok) return refuse(direct.envelope);

  const identity = identityFlags(flags);
  if (!identity.ok) return refuse(identity.envelope);

  const resolution = resolveConfig({
    flags: { ...identity, direct: direct.value },
    env: options.env,
    file: options.file,
  });

  // `doctor` is the one command that answers *without* a binding, because
  // "not configured" is the answer it exists to give. Every other command
  // preflights and stops (§20: "run `standup init` first"); doctor reports
  // instead of stopping, which is the whole point of having it.
  if (words[0] === "doctor") {
    const report = doctorReport({
      flags: { ...identity, direct: direct.value },
      env: options.env,
      file: options.file,
    });
    return { envelope: ok(report), exitCode: report.configured ? EXIT.OK : EXIT.UNCONFIGURED };
  }

  // `init` is the other command that runs before `resolveConfig`'s "not
  // configured, stop" gate — establishing that configuration is its whole
  // job (MILESTONES.md #80), so it cannot itself require it to already
  // exist. See `src/lib/cli/init/index.ts` for the command.
  if (words[0] === "init") {
    return runInitCommand({ flags, env: options.env, file: options.file });
  }

  // `mcp` is the other command that does not go through `resolution` above:
  // it is not one operation call but a long-lived connection, and it is
  // `--direct`-only by design (`./mcp.ts`'s own header), so it resolves its
  // own binding rather than reusing the identity/`--direct`-flag resolution
  // built for the noun/verb commands below.
  if (words[0] === "mcp") {
    return runMcpStdio({ env: options.env, file: options.file });
  }

  // `hook` is the third command that does not resolve a noun/verb binding
  // (MILESTONES.md #88). Two of its three verbs answer in the ordinary
  // envelope, but `hook run` answers an agent tool in that tool's own JSON
  // shape and exit code — so it cannot be a `COMMANDS` entry, where every
  // result becomes an envelope. `runCliHook` below handles the split; the
  // process edges it needs (stdin, the spool file, the network) arrive as
  // `options.hook`, the same way `loadService` and `fetch` do, so this
  // module still touches none of them.
  if (words[0] === "hook") {
    return await runCliHook(words.slice(1), options);
  }

  if (!resolution.ok) {
    return { envelope: resolution.envelope, exitCode: resolution.exitCode };
  }

  const binding = await buildBinding(resolution.config, options);
  return runCommand(argv, binding);
}

async function buildBinding(
  config: Extract<ReturnType<typeof resolveConfig>, { ok: true }>["config"],
  options: RunCliOptions,
): Promise<Binding> {
  const identity = {
    ...(config.sessionId === undefined ? {} : { sessionId: config.sessionId }),
    ...(config.actor === undefined ? {} : { actor: config.actor }),
  };

  if (config.binding === "http") {
    return createHttpBinding({
      // Non-null by construction: `resolveConfig` returns `http` only when
      // it resolved a URL, and the two are set in the same branch.
      baseUrl: config.standupUrl as string,
      ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      ...identity,
    });
  }

  const loadService =
    options.loadService ??
    (async () => (await import("@/lib/service/live")).service as CallableService);

  return createDirectBinding({ service: await loadService(), ...identity });
}

/** The top-level help, built from the command table rather than written out. */
export function helpText(): {
  usage: string;
  nouns: readonly string[];
  commands: readonly string[];
} {
  return {
    usage: "standup <noun> <verb> [--json] [--direct] [--as <person>] [--session <id>]",
    nouns: nouns(),
    commands: COMMANDS.map((command) => `${command.noun} ${command.verb} — ${command.summary}`),
  };
}

/** Re-exported so the entry point needs one import. */
export type { ParsedArgs };
export { malformed };
