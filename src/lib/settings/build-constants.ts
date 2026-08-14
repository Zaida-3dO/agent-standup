// Build constants — SCHEMA.md §17.6: "fixed by this version, not
// configurable… exposed read-only on `/settings`".
//
// The third configuration tier (§17). A value belongs here when it describes
// what this build *implements* rather than how it is configured: setting a
// required protocol version to one the build does not speak produces a
// system that refuses everything for a reason nobody can act on, so the only
// honest way to change one is to ship a new version.
//
// Declared as data rather than scattered as literals so `/settings` can
// render the panel by iterating, exactly as it renders the settings
// themselves from the registry — a constant added here appears in the panel
// with no edit to the page.

/**
 * A protocol variant's two numbers. §17.6: "Two numbers per variant, not
 * one, because 'you should update' and 'I cannot talk to you' are different
 * statements, and collapsing them makes every version bump a breaking one."
 */
export interface ProtocolVersions {
  /** The version this build speaks. */
  readonly current: number;
  /** The oldest it still accepts. Raising this is what makes an update mandatory. */
  readonly minSupported: number;
}

/**
 * The two hook protocol variants, versioned independently — §17.6: "a fix to
 * one must not force every session using the other to reinstall."
 */
export const HOOK_PROTOCOL: Readonly<Record<"http" | "cli", ProtocolVersions>> = Object.freeze({
  http: Object.freeze({ current: 1, minSupported: 1 }),
  cli: Object.freeze({ current: 1, minSupported: 1 }),
});

/**
 * The published version of this build.
 *
 * Read from the environment at build time where the release pipeline sets it
 * (`scripts/version-from-tag.mjs` derives it from the release tag), falling
 * back to a development marker. The fallback is a visible string rather than
 * an empty one, because a panel that renders a blank version reads as broken
 * rather than as "not a released build".
 */
export const APP_VERSION: string = process.env.APP_VERSION ?? "0.0.0-dev";

/** One constant, rendered for the read-only panel. */
export interface RenderedConstant {
  readonly name: string;
  readonly value: string;
  readonly meaning: string;
}

/**
 * Every build constant, in the order §17.6's table lists them.
 *
 * A function rather than a frozen array so the `APP_VERSION` row reflects the
 * value at call time — which is what a test that sets the environment needs,
 * and what makes the panel's contents provable rather than fixed at module
 * load in whatever order the test files happened to import.
 */
export function renderBuildConstants(): RenderedConstant[] {
  return [
    {
      name: "HOOK_PROTOCOL.http.current",
      value: String(HOOK_PROTOCOL.http.current),
      meaning: "The version of the HTTP hook protocol this build speaks.",
    },
    {
      name: "HOOK_PROTOCOL.http.min_supported",
      value: String(HOOK_PROTOCOL.http.minSupported),
      meaning: "The oldest HTTP hook protocol version this build still accepts.",
    },
    {
      name: "HOOK_PROTOCOL.cli.current",
      value: String(HOOK_PROTOCOL.cli.current),
      meaning: "The version of the command-line hook protocol this build speaks.",
    },
    {
      name: "HOOK_PROTOCOL.cli.min_supported",
      value: String(HOOK_PROTOCOL.cli.minSupported),
      meaning: "The oldest command-line hook protocol version this build still accepts.",
    },
    {
      name: "APP_VERSION",
      value: APP_VERSION,
      meaning: "The published version of this build.",
    },
  ];
}

/**
 * One bootstrap variable, rendered for the read-only panel — §17.1.
 *
 * **The value is never carried.** `DATABASE_URL` is a connection string with
 * a password in it, and §17.2 is explicit that the bootstrap tier "exists
 * precisely because some values must not be readable from the application".
 * So the panel answers "is it set", never "what is it": `set` is a boolean
 * derived from the environment, and there is no field a value could travel
 * in even by mistake.
 */
export interface RenderedBootstrapVariable {
  readonly name: string;
  readonly set: boolean;
  readonly meaning: string;
}

/** The bootstrap variables §17.1 declares, with the two the command line adds. */
const BOOTSTRAP_VARIABLES: readonly { name: string; meaning: string }[] = Object.freeze([
  {
    name: "DATABASE_URL",
    meaning: "Postgres. The one value nothing else can be read without.",
  },
  { name: "HOSTNAME", meaning: "Interface the server binds to." },
  { name: "PORT", meaning: "Port it listens on." },
  { name: "NODE_ENV", meaning: "Set by the toolchain, not by an operator." },
  {
    name: "SHADOW_DATABASE_URL",
    meaning: "Development and CI only. The disposable database the migration drift check rebuilds.",
  },
  {
    name: "STANDUP_URL",
    meaning:
      "Where a server is, if there is one. Present means commands call the API; absent means they run the service layer in-process.",
  },
  {
    name: "STANDUP_SESSION_ID",
    meaning: "The session a command acts as. Exported by whatever launches a session.",
  },
]);

/**
 * Which bootstrap variables are set, without reading any of their values.
 *
 * A variable set to the empty string counts as **not** set: an empty
 * connection string cannot connect, so reporting it as configured would tell
 * an operator the opposite of what they need to know.
 */
export function renderBootstrapVariables(
  env: Readonly<Record<string, string | undefined>> = process.env,
): RenderedBootstrapVariable[] {
  return BOOTSTRAP_VARIABLES.map((variable) => ({
    name: variable.name,
    set: typeof env[variable.name] === "string" && env[variable.name] !== "",
    meaning: variable.meaning,
  }));
}
