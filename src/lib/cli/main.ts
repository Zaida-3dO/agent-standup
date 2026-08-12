// The `standup` entry point (SCHEMA.md §20).
//
// Everything a process needs and a test does not: reading `argv`, reading
// the environment, writing to two streams, and setting an exit code. It is
// deliberately the thinnest module here — `main` takes all four as
// parameters, so `bin/standup.ts` is the only thing in this build that
// touches `process`, and the entry point itself is testable without one.
import { runCli, type RunCliOptions, type RunOutcome } from "./run";
import { render, type Streams } from "./render";
import { booleanFlag, parseArgs } from "./args";
import { EXIT, exitCodeFor, type ExitCode } from "./envelope";

export interface MainOptions extends RunCliOptions {
  readonly streams: Streams;
}

/**
 * Runs one command and returns the exit code the process should leave with.
 *
 * Returns rather than exits: a function that called `process.exit` could not
 * be tested for its exit code without a subprocess, and the exit code is
 * half of what §20 specifies about this adapter.
 *
 * `--json` is read here rather than inside `runCli` because it is purely a
 * rendering choice: it must not be able to change what happened, and the
 * cleanest way to guarantee that is for the code that decides what happened
 * never to see it.
 */
export async function main(
  argv: readonly string[],
  { streams, ...options }: MainOptions,
): Promise<ExitCode> {
  const parsed = parseArgs(argv);
  // An argv that cannot be parsed at all is rendered as human text, which is
  // the honest fallback: the flags were not understood, so answering as
  // though `--json` had been is a guess about what the caller wanted.
  // `--json=maybe` is likewise not `--json`; `booleanFlag` refuses a flag
  // given a value, and a refused flag is not a request for JSON.
  const jsonFlag = parsed.ok ? booleanFlag(parsed.parsed.flags, "json") : undefined;
  const json = jsonFlag?.ok === true && jsonFlag.value;

  let outcome: RunOutcome;
  try {
    outcome = await runCli(argv, options);
  } catch (cause) {
    // The last resort. Anything reaching here escaped both bindings'
    // normalisation, so it has no service code — it is `1`, an unexpected
    // failure.
    //
    // **The cause's message is deliberately not rendered**, only its class.
    // An unexpected failure's text is written for whoever is reading the
    // logs and routinely contains a query, a host or a connection string —
    // the same reason `InternalError` fixes its own message rather than
    // taking the underlying one (`service/errors.ts`), and the same rule
    // §20 states for the command line. A person debugging this has the
    // stack; a person reading a terminal must not be shown a credential.
    const envelope = {
      ok: false as const,
      error: {
        code: "internal" as const,
        message: `The command failed unexpectedly (${cause instanceof Error ? cause.name : "unknown error"}).`,
        fields: [] as readonly string[],
      },
    };
    render({ envelope, exitCode: EXIT.FAILURE }, streams, json);
    return exitCodeFor(envelope);
  }

  render(outcome, streams, json);
  return outcome.exitCode;
}
