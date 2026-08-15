// How an operation is spelled on the surface the caller is actually on.
//
// The same operation has three spellings. Over MCP it is a tool name —
// `describe_tool` — called as a tool. Over the command line it is a verb
// pair — `standup tool describe`. Over HTTP it is a method and a path. A
// refusal that names one spelling to a caller reading it on another surface
// is telling them to run something that does not exist where they are, and
// that is not a cosmetic problem: it costs the round trip the refusal was
// supposed to save.
//
// The transport is already known. Every adapter stamps `caller.transport`
// (`service/context.ts`, SCHEMA.md §21's five values) before the service is
// reached, so a refusal can be worded for the reader without anything new
// being threaded through. When it is absent — an in-process caller, a
// script, a test — both spellings are named rather than one guessed, because
// naming the wrong one is the failure being fixed and naming both is never
// wrong.
//
// This sits at `lib/` rather than under `service/` because both sides of the
// service boundary word refusals: the runtime does, and so does `sessions.ts`,
// which the service layer imports rather than the other way round. Putting it
// inside `service/` would have made the pure module depend on the layer that
// depends on it.

/** The three shapes a caller can be told to call something in. */
export type CallSurface = "mcp" | "cli" | "http";

/**
 * The surface a transport is. `undefined` when there is no basis to decide.
 *
 * The five transports collapse to three surfaces here, which is a narrower
 * question than the one `sessions.ts` asks of the same values: that module
 * distinguishes `cli-direct` from `cli-http` because the *hook variant*
 * turns on the binding. How to spell a command does not — both are typed
 * into the same terminal — so both map to `cli`.
 */
export function surfaceForTransport(transport: string | undefined): CallSurface | undefined {
  switch (transport) {
    case "mcp-http":
    case "mcp-stdio":
      return "mcp";
    case "cli-direct":
    case "cli-http":
      return "cli";
    case "http":
      return "http";
    default:
      return undefined;
  }
}

/** How one operation is invoked, per surface. */
export interface SurfaceSpelling {
  readonly mcp: string;
  readonly cli: string;
  readonly http: string;
}

/**
 * The command-line spelling of an operation.
 *
 * Derived from the operation name rather than looked up in a table of every
 * operation's verb: the command line's own dispatcher is the authority on
 * what it accepts, and a table here would be a copy of it that drifts the
 * first time a verb is renamed. `standup <name with underscores as spaces>`
 * is the shape the command line uses, and where a verb differs the operation
 * name is still enough to find it — which is the job, since the reader is
 * being pointed at documentation rather than handed a script to run
 * unattended.
 */
function cliSpelling(operation: string): string {
  return `standup ${operation.replace(/_/g, " ")}`;
}

/** Every spelling of one operation. */
export function spellingsFor(operation: string): SurfaceSpelling {
  return {
    mcp: operation,
    cli: cliSpelling(operation),
    http: `the ${operation} endpoint`,
  };
}

/**
 * How to tell a caller to make a call, worded for where they are.
 *
 * With a known surface this names one spelling, because one is what the
 * reader can act on. With an unknown surface it names the two a person or an
 * agent actually types — MCP and the command line — rather than picking one:
 * an unknown transport means the reader could be either, and a refusal that
 * guesses wrong is the defect this module exists to remove, whereas a
 * refusal that offers both is merely slightly longer.
 */
export function invocationFor(operation: string, surface: CallSurface | undefined): string {
  const spellings = spellingsFor(operation);
  switch (surface) {
    case "mcp":
      return `\`${spellings.mcp}\``;
    case "cli":
      return `\`${spellings.cli}\``;
    case "http":
      return spellings.http;
    default:
      return `\`${spellings.mcp}\` (or \`${spellings.cli}\` on the command line)`;
  }
}

/**
 * A call with one argument, worded for the surface.
 *
 * `describe_tool` is always called with a tool name, and a refusal pointing
 * at it is far more useful naming the tool than naming the call — a reader
 * who has to work out the argument has been given a lookup, not an answer.
 */
export function invocationWithArgumentFor(
  operation: string,
  argument: string,
  surface: CallSurface | undefined,
): string {
  const spellings = spellingsFor(operation);
  switch (surface) {
    case "mcp":
      return `\`${spellings.mcp}("${argument}")\``;
    case "cli":
      return `\`${spellings.cli} ${argument}\``;
    case "http":
      return `${spellings.http} for \`${argument}\``;
    default:
      return `\`${spellings.mcp}("${argument}")\` (or \`${spellings.cli} ${argument}\` on the command line)`;
  }
}
