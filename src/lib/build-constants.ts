// Build constants — fixed by this version, not configurable (SCHEMA.md
// §17.6).
//
// **None of these is a setting, and the reason is the same for all of them:
// they describe what this build implements.** A protocol version is not a
// preference — setting a required version to one the build does not speak
// produces a system that refuses everything for a reason nobody can act on.
// They are exposed read-only (a settings page, `standup doctor`) because
// knowing them is useful and changing them is not, which is why they live in
// a module rather than in the settings registry that `/settings` renders as
// editable fields.
//
// ── Two numbers per variant, not one ───────────────────────────────────
//
// "You should update" and "I cannot talk to you" are different statements,
// and collapsing them into a single number makes every version bump a
// breaking one. `current` is what this build speaks; `min_supported` is the
// oldest it still accepts. Raising `min_supported` is the deliberate act in
// a release that makes an update mandatory — see §21 for what each answer
// does to a session.
//
// ── Two variants, versioned independently ──────────────────────────────
//
// The HTTP hook and the command-line hook change independently, and a fix to
// one must not force every session using the other to reinstall. So they
// carry separate numbers rather than one shared number that would have to be
// bumped for both whenever either moved.

/** The two hook variants a session can be running. `transport` decides which one it gets (§21). */
export const HOOK_VARIANTS = ["cli", "http"] as const;
export type HookVariant = (typeof HOOK_VARIANTS)[number];

export function isHookVariant(value: unknown): value is HookVariant {
  return typeof value === "string" && (HOOK_VARIANTS as readonly string[]).includes(value);
}

/** The pair of numbers this build carries for one hook variant. */
export interface ProtocolRange {
  /** The version of this protocol this build speaks. */
  readonly current: number;
  /** The oldest version this build still accepts. */
  readonly minSupported: number;
}

/**
 * The protocol versions this build carries, per hook variant.
 *
 * Integers rather than a dotted string. A protocol version's only job here
 * is to be *compared* — "at or above `current`", "below `min_supported`" —
 * and a dotted string cannot be compared without a parser, which is a second
 * thing that can be wrong about what a version means. There is exactly one
 * ordering question, so there is exactly one number.
 *
 * Both variants start at `1` with a `minSupported` of `1`, which is the only
 * honest starting point: no earlier version of either protocol was ever
 * published, so there is nothing below `1` for this build to have an opinion
 * about.
 */
export const HOOK_PROTOCOL: Readonly<Record<HookVariant, ProtocolRange>> = Object.freeze({
  cli: Object.freeze({ current: 1, minSupported: 1 }),
  http: Object.freeze({ current: 1, minSupported: 1 }),
});

/**
 * The protocol version the shipped hook script declares it speaks.
 *
 * The hook is built from this repository (`src/bin/standup-hook.ts`), so its
 * declared version and the server's `current` are two statements about one
 * artefact and must agree. They are two constants rather than one because
 * the hook and the server are separately *installed* — a machine can be
 * running one release's hook against another release's server, which is the
 * entire situation §21's version comparison exists to describe. A single
 * shared constant would make that skew inexpressible.
 *
 * Both being written here means a bump is one edit, and
 * `tests/hook-protocol-version.test.ts` asserts they have not drifted apart
 * so nobody has to remember which one to bump.
 */
export const SHIPPED_HOOK_PROTOCOL_VERSION = 1;

/**
 * The published version of this build.
 *
 * Read from `package.json` at build time by the release pipeline
 * (`scripts/version-from-tag.mjs`); the literal here is what a working tree
 * that has never been released reports.
 */
export const APP_VERSION = "0.1.0";
