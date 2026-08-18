// Configuration resolution: which binding, acting as whom (SCHEMA.md §17.1, §20).
//
// "Precedence throughout is flag, then environment, then the configuration
// file." That is one rule applied to every resolved value, so it is written
// once here as `firstDefined` rather than re-implemented per value — three
// hand-written precedence chains are three chances to order one of them
// differently, and the one that is wrong is the one nobody tested.
//
// **Nothing in this module prints, logs or returns a connection string in a
// human-facing field.** §20: "the connection string is read from the
// environment or written by `init` into that file with owner-only
// permissions, and is never printed by any command." `describeResolution`
// below is the report `standup doctor` renders, and it deliberately carries
// *whether* a value is present, never the value.
import { EXIT, malformed, type ErrorEnvelope } from "./envelope";
import { isBindingName, type BindingName } from "./binding";

/**
 * The bootstrap variables the command line reads (§17.1).
 *
 * An index signature rather than four exact properties, so `process.env`
 * satisfies it directly: `ProcessEnv` is `Record<string, string | undefined>`
 * and has no properties in common with an exact type, which would force the
 * entry point to hand-copy four variables and silently drop a fifth the day
 * one is added. The four below are documentation and autocompletion; the
 * signature is what makes the real environment assignable.
 */
export interface CliEnvironment {
  readonly STANDUP_URL?: string;
  readonly DATABASE_URL?: string;
  readonly STANDUP_SESSION_ID?: string;
  readonly STANDUP_ACTOR?: string;
  readonly STANDUP_TOKEN?: string;
  readonly [name: string]: string | undefined;
}

/** What `standup init` writes into the local configuration file (row #80 owns writing it). */
export interface CliFileConfig {
  readonly standupUrl?: string;
  readonly databaseUrl?: string;
  readonly sessionId?: string;
  readonly actor?: string;
  readonly token?: string;
}

/** The flags that participate in precedence. */
export interface CliFlags {
  /** `--as` — the person the command acts as. A claim, not a credential (§20). */
  readonly as?: string;
  /** `--session` — the session the command acts as. */
  readonly session?: string;
  /** `--direct` — forces the in-process binding even with a server reachable. */
  readonly direct?: boolean;
  /** `--url` — overrides where the server is. */
  readonly url?: string;
}

/**
 * The first value that is actually supplied.
 *
 * An empty string counts as absent on purpose: `STANDUP_URL=` in a shell
 * profile is how a person turns a variable *off*, and treating it as a base
 * URL would send every command to a server at the empty string. Treating it
 * as unset instead makes unsetting work the way it looks like it works.
 */
export function firstDefined(...values: readonly (string | undefined)[]): string | undefined {
  for (const value of values) {
    if (value !== undefined && value.trim() !== "") return value.trim();
  }
  return undefined;
}

/** Everything a command needs resolved, before a binding is built. */
export interface ResolvedConfig {
  readonly binding: BindingName;
  /** Present exactly when `binding` is `http`. */
  readonly standupUrl?: string;
  /** Present exactly when `binding` is `direct`. Never rendered. */
  readonly databaseUrl?: string;
  readonly sessionId?: string;
  readonly actor?: string;
  /**
   * The bearer token presented to the server, when one is configured.
   *
   * Only ever meaningful on the `http` binding — the `direct` binding *is*
   * the trust boundary rather than a caller crossing one, and has nothing
   * to present a token to.
   *
   * **Deliberately has no flag.** Every other value here can be overridden
   * on the command line, and this one cannot, because a credential typed as
   * an argument is written to shell history and visible in the process list
   * to every other user on the machine. The environment and the
   * configuration file are both places a secret can live without being
   * recorded by the act of using it.
   */
  readonly token?: string;
}

export interface ResolveInputs {
  readonly flags?: CliFlags;
  readonly env?: CliEnvironment;
  readonly file?: CliFileConfig;
}

/** A resolution that could not be completed — the process is not configured. */
export interface UnconfiguredResolution {
  readonly ok: false;
  readonly envelope: ErrorEnvelope;
  readonly exitCode: typeof EXIT.UNCONFIGURED;
}

export type Resolution =
  { readonly ok: true; readonly config: ResolvedConfig } | UnconfiguredResolution;

/**
 * Resolves the binding and the identity, per §17.1 and §20.
 *
 * The binding rule, stated exactly as §17.1 states it: **`STANDUP_URL`
 * present → commands call the API; absent → they use `DATABASE_URL` and run
 * the service layer in-process.** `--direct` forces the second even when a
 * URL resolved, because §20 says it does — an operator who wants to bypass a
 * server they can reach needs a way to say so that does not involve editing
 * their environment.
 *
 * "Either `DATABASE_URL` or `STANDUP_URL` must resolve, or the process has
 * no idea what it is talking to — in which case it says so and stops, rather
 * than starting up half-configured." That is the `UNCONFIGURED` branch, and
 * it is the reason exit code `4` exists separately from `1`: a script can
 * tell "this machine was never set up" from "the thing I asked for failed",
 * and only the first is fixed by running `standup init`.
 */
export function resolveConfig({ flags = {}, env = {}, file = {} }: ResolveInputs = {}): Resolution {
  const standupUrl = firstDefined(flags.url, env.STANDUP_URL, file.standupUrl);
  const databaseUrl = firstDefined(env.DATABASE_URL, file.databaseUrl);
  const sessionId = firstDefined(flags.session, env.STANDUP_SESSION_ID, file.sessionId);
  const actor = firstDefined(flags.as, env.STANDUP_ACTOR, file.actor);
  const token = firstDefined(env.STANDUP_TOKEN, file.token);

  const identity = {
    ...(sessionId === undefined ? {} : { sessionId }),
    ...(actor === undefined ? {} : { actor }),
  };

  if (flags.direct === true) {
    if (databaseUrl === undefined) {
      return unconfigured(
        "--direct needs a database to talk to, and neither DATABASE_URL nor the local configuration supplied one. Run `standup init` first.",
        ["DATABASE_URL"],
      );
    }
    return { ok: true, config: { binding: "direct", databaseUrl, ...identity } };
  }

  if (standupUrl !== undefined) {
    // The token rides only on this branch. Adding it to a `direct`
    // resolution would put a credential on a config object that never
    // presents one, and the two `direct` returns above are the reason it is
    // spread here rather than folded into `identity`.
    return {
      ok: true,
      config: {
        binding: "http",
        standupUrl,
        ...identity,
        ...(token === undefined ? {} : { token }),
      },
    };
  }

  if (databaseUrl !== undefined) {
    return { ok: true, config: { binding: "direct", databaseUrl, ...identity } };
  }

  return unconfigured(
    "Neither STANDUP_URL nor DATABASE_URL resolved, so there is nothing to talk to. Run `standup init` first.",
    ["STANDUP_URL", "DATABASE_URL"],
  );
}

function unconfigured(message: string, fields: readonly string[]): UnconfiguredResolution {
  return { ok: false, envelope: malformed(message, fields), exitCode: EXIT.UNCONFIGURED };
}

/** One resolved value, as a report renders it: where it came from, never what it is. */
export interface ResolutionNote {
  readonly name: string;
  readonly present: boolean;
  /** Which layer supplied it — `flag`, `environment`, `file`, or `none`. */
  readonly source: "flag" | "environment" | "file" | "none";
}

function sourceOf(
  flag: string | undefined,
  env: string | undefined,
  file: string | undefined,
): ResolutionNote["source"] {
  if (firstDefined(flag) !== undefined) return "flag";
  if (firstDefined(env) !== undefined) return "environment";
  if (firstDefined(file) !== undefined) return "file";
  return "none";
}

/**
 * What `standup doctor` reports about configuration.
 *
 * **This is the function that must never leak a secret**, so it is the one
 * place that is written to make leaking impossible rather than merely
 * avoided: it returns `present` and `source`, and there is no field on
 * `ResolutionNote` a connection string could be put in even by a later
 * change that was not thinking about it. A report that carried the value and
 * relied on a renderer to redact it would leak the first time someone
 * rendered it a second way.
 */
export function describeResolution({
  flags = {},
  env = {},
  file = {},
}: ResolveInputs = {}): readonly ResolutionNote[] {
  const entries: readonly [string, string | undefined, string | undefined, string | undefined][] = [
    ["STANDUP_URL", flags.url, env.STANDUP_URL, file.standupUrl],
    ["DATABASE_URL", undefined, env.DATABASE_URL, file.databaseUrl],
    ["STANDUP_SESSION_ID", flags.session, env.STANDUP_SESSION_ID, file.sessionId],
    ["STANDUP_ACTOR", flags.as, env.STANDUP_ACTOR, file.actor],
  ];

  return entries.map(([name, flag, envValue, fileValue]) => {
    const source = sourceOf(flag, envValue, fileValue);
    return { name, present: source !== "none", source };
  });
}

/** Whether a string names a binding — re-exported so commands need one import. */
export { isBindingName };
