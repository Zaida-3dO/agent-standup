// How an operation is spelled on the surface the caller is actually on.
//
// The same operation has up to three spellings. Over MCP it is a tool name
// — `get_item` — called as a tool. Over the command line it is a `<noun>
// <verb>` pair — `standup item get` (SCHEMA.md §20). Over HTTP it is a
// method and a path. A refusal that names one spelling to a caller reading
// it on another surface is telling them to run something that does not
// exist where they are, and that is not a cosmetic problem: it costs the
// round trip the refusal was supposed to save.
//
// **"Up to" three, not three.** Most operations are not bound on every
// surface — 47 of 100 have no command-line verb and 56 are waived off every
// MCP adapter — so a spelling is looked up in what is really bound and
// omitted when there is nothing to name. Manufacturing one by string
// transformation instead makes all three fields always present and almost
// always false; `spellingsFor` carries the measurement and the reasoning.
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

/**
 * How one operation is invoked, per surface.
 *
 * **Every field is optional, and that is the point.** An operation is not
 * reachable on all three surfaces: 47 of them have no command-line verb at
 * all, and 56 are waived off every MCP adapter. A required field here has
 * no way to say "not reachable from where you are", so the only value it
 * can hold for those is a made-up one — which is how this type came to
 * force a lie rather than merely permit one. An absent key is the honest
 * answer, and a caller reading one surface's key as missing has learned
 * something true; a caller handed a plausible invented command has been
 * sent to run something that does not exist.
 */
export interface SurfaceSpelling {
  readonly mcp?: string;
  readonly cli?: string;
  readonly http?: string;
}

/**
 * What is actually bound where, supplied by the caller.
 *
 * `surfaces.ts` deliberately does not import the command table or the
 * waiver list, for the reason its header already gives about layering: this
 * module sits at `lib/` because `sessions.ts` needs it and the service
 * layer imports `sessions.ts`. `cli/commands.ts` reaches `@/lib/service`
 * through `cli/envelope.ts`, so importing it here would close a cycle —
 * and would pull `node:fs` (via `commands-backfill.ts`) into every web
 * route that words a refusal, none of which reach `lib/cli` at all.
 *
 * So the bindings are a parameter. The service layer, which may import both
 * tables freely, passes the real ones; this module stays pure and stays
 * testable against fakes.
 */
export interface SurfaceBindings {
  /**
   * The command line's `<noun> <verb>` for this operation, or `undefined`
   * when the command line does not bind it.
   */
  readonly cli?: readonly [noun: string, verb: string];
  /** Whether an MCP caller can call this operation as a tool of its own. */
  readonly onMcp: boolean;
  /**
   * The tool an MCP caller reaches a folded operation through — `loop` for
   * `loop_close`, `create_work` for `create_task`. Set only when the
   * operation itself is off MCP but its behaviour is still reachable.
   */
  readonly foldedInto?: string;
}

/**
 * Every spelling of one operation, given what is really bound.
 *
 * ── Why this takes bindings rather than deriving them ───────────────────
 *
 * **A spelling cannot be computed from an operation's name.** The tempting
 * derivation is `standup ${operation.replace(/_/g, " ")}` with `mcp`
 * emitted unconditionally, on the theory that `standup <name with
 * underscores as spaces>` is the shape the command line uses. It is not:
 * the command line is `<noun> <verb>` — `standup item get`, not `standup
 * get item` — as `docs/plans/SCHEMA.md` §20 states and `lookupCommand`
 * enforces. Name and verb coincide only by accident.
 *
 * Measured against the real tables, that derivation gets the `cli` string
 * wrong for **97 of 100** registered operations — 47 have no verb at all,
 * and the rest come out with the words in the wrong order — and the `mcp`
 * string wrong for the **56** waived off every MCP adapter. It lands on
 * three by coincidence: `service_info`, and `claim` and `sweep` through
 * aliases.
 *
 * Nor is "the operation name is still enough to find it" a safe fallback,
 * since that assumes the mismatch is rare when it is universal. The
 * dispatcher is the authority on what the command line accepts, so the
 * only reliable spelling is the one it is asked for — which is what the
 * `bindings` parameter carries.
 */
export function spellingsFor(
  operation: string,
  bindings: SurfaceBindings = { onMcp: true },
): SurfaceSpelling {
  return {
    ...(bindings.onMcp ? { mcp: operation } : {}),
    ...(bindings.cli ? { cli: `standup ${bindings.cli[0]} ${bindings.cli[1]}` } : {}),
    // `http` stays prose. The generated route table
    // (`http-routes.generated.ts`) carries paths and methods but no
    // operation mapping, so naming a real method and path would require a
    // generator this change does not build — and inventing one would be
    // the same guess this function exists to remove.
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
 *
 * ── When the reader's own surface does not bind it ──────────────────────
 *
 * This is not a corner case. `describe_tool` — which two refusal paths
 * point at by name — has **no command-line verb**, so there is nothing to
 * name for a CLI reader on their own surface. Falling back to whatever
 * surface *does* bind it is the honest answer: naming a real call
 * elsewhere tells the reader something true and actionable, where naming
 * an invented call on their own surface costs them the round trip the
 * refusal was supposed to save.
 *
 * Nothing is named when nothing is bound anywhere, which cannot happen for
 * a registered operation but is not worth asserting over inside a refusal
 * path — a message that says less is recoverable; one that throws while
 * explaining another error is not.
 */
export function invocationFor(
  operation: string,
  surface: CallSurface | undefined,
  bindings?: SurfaceBindings,
): string {
  const spellings = spellingsFor(operation, bindings);
  const mcp = spellings.mcp === undefined ? undefined : `\`${spellings.mcp}\``;
  const cli = spellings.cli === undefined ? undefined : `\`${spellings.cli}\``;
  const folded =
    bindings?.foldedInto === undefined
      ? undefined
      : `\`${bindings.foldedInto}\` (which \`${operation}\` is folded into)`;
  switch (surface) {
    case "mcp":
      return mcp ?? folded ?? cli ?? spellings.http ?? `\`${operation}\``;
    case "cli":
      return cli ?? mcp ?? folded ?? spellings.http ?? `\`${operation}\``;
    case "http":
      return spellings.http ?? mcp ?? cli ?? `\`${operation}\``;
    default: {
      // Both of the two a person or an agent types, when both exist.
      const both = [mcp ?? folded, cli].filter((one) => one !== undefined);
      if (both.length === 2) return `${both[0]} (or ${both[1]} on the command line)`;
      return both[0] ?? spellings.http ?? `\`${operation}\``;
    }
  }
}

/**
 * A call with one argument, worded for the surface.
 *
 * `describe_tool` is always called with a tool name, and a refusal pointing
 * at it is far more useful naming the tool than naming the call — a reader
 * who has to work out the argument has been given a lookup, not an answer.
 *
 * Unbound surfaces fall back exactly as `invocationFor` does, and for the
 * same reason — see its note. Both `describe_tool` pointers go through
 * this function, which is where the unbound-CLI case actually arises.
 */
export function invocationWithArgumentFor(
  operation: string,
  argument: string,
  surface: CallSurface | undefined,
  bindings?: SurfaceBindings,
): string {
  const spellings = spellingsFor(operation, bindings);
  const mcp = spellings.mcp === undefined ? undefined : `\`${spellings.mcp}("${argument}")\``;
  const cli = spellings.cli === undefined ? undefined : `\`${spellings.cli} ${argument}\``;
  const http = spellings.http === undefined ? undefined : `${spellings.http} for \`${argument}\``;
  switch (surface) {
    case "mcp":
      return mcp ?? cli ?? http ?? `\`${operation}\` for \`${argument}\``;
    case "cli":
      return cli ?? mcp ?? http ?? `\`${operation}\` for \`${argument}\``;
    case "http":
      return http ?? mcp ?? cli ?? `\`${operation}\` for \`${argument}\``;
    default: {
      const both = [mcp, cli].filter((one) => one !== undefined);
      if (both.length === 2) return `${both[0]} (or ${both[1]} on the command line)`;
      return both[0] ?? http ?? `\`${operation}\` for \`${argument}\``;
    }
  }
}
