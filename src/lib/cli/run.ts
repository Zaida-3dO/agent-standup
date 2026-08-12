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

/** What one run produced: the envelope, the exit code, and how to render it. */
export interface RunOutcome {
  readonly envelope: Envelope;
  readonly exitCode: ExitCode;
  /** Which binding ran, when one did. Absent for a command refused before dispatch. */
  readonly binding?: string;
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
