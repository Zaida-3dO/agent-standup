// The adapter registry — the module the application mounts adapters
// through. See docs/plans/SCHEMA.md §22, DECISIONS.md §13f.
//
// This is the compile-time half of the conformance harness's completeness
// assertion (MILESTONES.md #94): a driver map typed from `AdapterName`
// cannot compile while an adapter is missing, because the key type below is
// derived from this object rather than written out by hand at each call
// site. That property only holds if this registry is genuinely what the
// application mounts through — an adapter that exists but is not entered
// here is invisible to every consumer, which is what `AdapterName` narrows
// against.
//
// Deliberately adapter-agnostic: nothing here assumes a request, a
// response, a status code, or a process boundary. A descriptor names an
// adapter and says what kind of transport it is — `network` (the process
// serving it can outlive any single caller) or `embedded` (it runs inside
// the caller's own process, e.g. the CLI's direct binding) — which is the
// one distinction the conformance harness's spawned-smoke-subset split
// (§22 "Cost, and how it is kept sane") needs to make, and nothing more.
// HTTP status codes, MCP tool shapes and CLI exit codes belong to the
// modules that implement each adapter, never to this one.

/**
 * One adapter the application mounts.
 *
 * `transport` distinguishes a driver the conformance harness can run
 * entirely in-process (calling a route handler or an entry point directly)
 * from one that needs a real process boundary to prove its wiring — §22's
 * "in-process matrix … spawned subset" split reads this field to decide
 * which job a driver belongs in. It says nothing about *how* the adapter
 * talks to a caller, on purpose: that is protocol detail the registry does
 * not need in order to be canonical.
 */
export interface AdapterDescriptor {
  readonly name: string;
  /** One line, as a reviewer or a `standup doctor`-style report would read it. */
  readonly summary: string;
  /**
   * `network` — the server process is a request away, whether or not the
   * caller and the server are the same host. `embedded` — the adapter runs
   * inside the calling process with no server to be reached at all (the
   * command line's `direct` binding, §20's "otherwise it uses
   * `DATABASE_URL` and runs the service layer in-process").
   */
  readonly transport: "network" | "embedded";
}

/**
 * Declares an adapter.
 *
 * A function rather than an object literal, for the same reason
 * `defineOperation` is (`../service/operation.ts`): calling this with an
 * adapter's own name captures it as a literal type, so the registry's key
 * type below is derived from those literals rather than annotated by hand —
 * and a registry entered by hand can drift from a key type entered by hand,
 * which defeats the whole point.
 */
export function defineAdapter<const D extends AdapterDescriptor>(descriptor: D): D {
  return Object.freeze(descriptor);
}

/**
 * Every adapter the application mounts, by name.
 *
 * The four the application is built to mount (MILESTONES.md #26, #30, #79,
 * #84): the web API over HTTP, MCP over streamable HTTP, MCP over stdio, and
 * the `standup` command line. Each is entered once, here, regardless of how
 * many operations or routes it exposes — this registry answers "what
 * adapters exist", not "what can each one do" (that is `OPERATION_REGISTRY`,
 * `../service/registry.ts`, which every adapter reads from instead of
 * declaring its own list).
 *
 * `as const satisfies` for the same reason `OPERATION_REGISTRY` uses it: an
 * annotated type would widen every entry to `AdapterDescriptor` and lose the
 * literal `name`, which is what makes `AdapterName` a union of the actual
 * four strings rather than `string`.
 */
export const ADAPTER_REGISTRY = {
  http: defineAdapter({
    name: "http",
    summary: "The web API — the JSON surface routes under src/app/api mount.",
    transport: "network",
  }),
  mcp_http: defineAdapter({
    name: "mcp_http",
    summary: "The MCP server, reached over streamable HTTP.",
    transport: "network",
  }),
  mcp_stdio: defineAdapter({
    name: "mcp_stdio",
    summary: "The MCP server, reached over stdio.",
    transport: "embedded",
  }),
  cli: defineAdapter({
    name: "cli",
    summary: "The standup command line, on either of its two bindings.",
    transport: "embedded",
  }),
} as const satisfies Record<string, AdapterDescriptor>;

export type AdapterRegistry = typeof ADAPTER_REGISTRY;

/**
 * The name of every registered adapter.
 *
 * This is the type §22 means by "`AdapterName` is its key type, so adding
 * an adapter without adding its driver does not compile" — a driver map
 * declared as `Record<AdapterName, Driver>` gains or loses a required
 * property exactly when this object gains or loses an entry, with no
 * second list to keep in step.
 */
export type AdapterName = keyof AdapterRegistry & string;

/** Every adapter name, enumerable and stable — sorted so it never reorders when an entry is added. */
export const ADAPTER_NAMES: readonly AdapterName[] = Object.freeze(
  (Object.keys(ADAPTER_REGISTRY) as AdapterName[]).sort(),
);

/** Whether a string names a registered adapter. */
export function isAdapterName(value: string): value is AdapterName {
  return Object.prototype.hasOwnProperty.call(ADAPTER_REGISTRY, value);
}

/** One adapter descriptor by name, or `undefined` for a name nothing registered. */
export function getAdapter(name: string): AdapterDescriptor | undefined {
  return isAdapterName(name) ? ADAPTER_REGISTRY[name] : undefined;
}

/** Every registered adapter, in `ADAPTER_NAMES` order. */
export function listAdapters(): readonly AdapterDescriptor[] {
  return ADAPTER_NAMES.map((name) => ADAPTER_REGISTRY[name]);
}
