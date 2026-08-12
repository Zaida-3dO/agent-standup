// The registry's own invariants, as functions over an arbitrary set of
// declarations rather than assertions about this particular registry.
//
// That distinction is the whole design of this file. A check written as
// "for each key in SETTINGS_REGISTRY, assert X" can only ever pass, because
// the registry it reads is the registry it was written against; it names a
// property without being able to fail on one. Written as a function over a
// parameter, the same check can be handed a deliberately broken set and
// asserted to *reject* it — which is the only evidence that it would catch
// a real one.
import type { SettingDefinition } from "./registry";

/** A set of declarations to check. The registry is one instance of this. */
export type Declarations = Readonly<Record<string, SettingDefinition<never>>>;

export interface Violation {
  key: string;
  invariant: "help" | "default" | "credential-shape" | "prefix";
  message: string;
}

/** The shortest help text that could plausibly explain a field. */
export const MIN_HELP_CHARACTERS = 40;

/**
 * Every key has help text, and enough of it to be an explanation.
 *
 * A length floor rather than merely non-empty, because the failure this
 * guards against is not a missing string — it is `help: "The max depth."`,
 * which passes a non-empty check and tells a reader exactly what the label
 * already told them. §17.2's second property is that the editing surfaces
 * are generated, so help text is the *only* explanation a field will ever
 * have; there is no document behind it to fall back on.
 */
export function checkHelpPresent(declarations: Declarations): Violation[] {
  const violations: Violation[] = [];
  for (const [key, definition] of Object.entries(declarations)) {
    const help = definition.help?.trim() ?? "";
    if (help.length === 0) {
      violations.push({ key, invariant: "help", message: "has no help text" });
    } else if (help.length < MIN_HELP_CHARACTERS) {
      violations.push({
        key,
        invariant: "help",
        message: `help text is ${help.length} characters, under the ${MIN_HELP_CHARACTERS}-character floor — a field's help is its only explanation`,
      });
    }
  }
  return violations;
}

/**
 * Every default validates against its own key's schema.
 *
 * The failure mode is a schema tightened without its default being revisited
 * — at which point a fresh database, which stores no overrides at all,
 * resolves to a value the same build would refuse to accept as a write.
 */
export function checkDefaultsValid(declarations: Declarations): Violation[] {
  const violations: Violation[] = [];
  for (const [key, definition] of Object.entries(declarations)) {
    const parsed = definition.schema.safeParse(definition.default);
    if (!parsed.success) {
      violations.push({
        key,
        invariant: "default",
        message: `default fails its own schema: ${parsed.error.issues
          .map((issue) => issue.message)
          .join("; ")}`,
      });
    }
  }
  return violations;
}

/**
 * Word shapes that mark a value as a credential.
 *
 * By shape, never by a list of real values — matching actual secrets would
 * mean writing them into a public repository, which is what the rule exists
 * to prevent. These are the nouns a credential is *called*, which is enough
 * because a key is named by whoever declares it and they will reach for one
 * of these words.
 */
const CREDENTIAL_WORDS = [
  "password",
  "passwd",
  "secret",
  "token",
  "api_key",
  "apikey",
  "access_key",
  "private_key",
  "credential",
  "credentials",
  "auth",
  "bearer",
  "session_key",
  "signing_key",
  "connection_string",
  "dsn",
  "passphrase",
];

/**
 * A key whose name is credential-shaped fails the build.
 *
 * `settings` is never a secret store (§17.2): every value is served to the
 * front end and printed by the command line, and there is no redaction path
 * because a value that cannot be displayed cannot be edited in the surface
 * the table exists to feed. **A registry entry whose value would be unsafe
 * to read aloud is in the wrong tier** — it belongs in the bootstrap
 * environment. This check is what makes that a build failure rather than a
 * convention.
 *
 * Matching is on the key's own words, so `retention.tool_calls_days` does
 * not trip on a substring and `notify.doc` is not a credential for
 * containing neither.
 */
export function checkNoCredentialShapedKey(declarations: Declarations): Violation[] {
  const violations: Violation[] = [];
  for (const key of Object.keys(declarations)) {
    const words = key
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(Boolean);
    const joinedPairs = words.slice(0, -1).map((word, index) => `${word}_${words[index + 1]}`);
    const candidates = new Set([...words, ...joinedPairs]);
    const hit = CREDENTIAL_WORDS.find((word) => candidates.has(word));
    if (hit) {
      violations.push({
        key,
        invariant: "credential-shape",
        message: `is credential-shaped ("${hit}") — settings are served to the front end unredacted, so a value that must not be read aloud belongs in the bootstrap environment instead`,
      });
    }
  }
  return violations;
}

/**
 * The prefixes a setting key may use. Closed: a key is `<prefix>.<name>`
 * and the prefix names a subsystem that exists.
 *
 * The point is not tidiness. `/settings` groups by category, and a key's
 * prefix is what a person types on the command line and greps for in a log;
 * an unmapped prefix is a setting filed under a subsystem the build does
 * not have, which is how two names for one concept start.
 */
export const KEY_PREFIXES: Readonly<Record<string, string>> = {
  items: "Items",
  agents: "Agents",
  liveness: "Liveness",
  dispatch: "Dispatch",
  poll: "Dispatch",
  crew: "Crew",
  budget: "Budget",
  model_picker: "Model picker",
  notify: "Capabilities",
  visual_review: "Capabilities",
  minting: "Minting",
  retention: "Retention",
  hook: "Hook",
};

/**
 * No key carries a prefix outside the map above, and each key's category
 * is the one its prefix maps to.
 *
 * The second half is what makes this worth having: a key can be
 * well-prefixed and still filed in the wrong section of `/settings`, and
 * that is the version nobody notices, because the key looks right
 * everywhere it is read.
 */
export function checkNoUnmappedPrefix(declarations: Declarations): Violation[] {
  const violations: Violation[] = [];
  for (const [key, definition] of Object.entries(declarations)) {
    const separator = key.indexOf(".");
    if (separator <= 0 || separator === key.length - 1) {
      violations.push({
        key,
        invariant: "prefix",
        message: "is not of the form <prefix>.<name>",
      });
      continue;
    }
    const prefix = key.slice(0, separator);
    const expectedCategory = KEY_PREFIXES[prefix];
    if (expectedCategory === undefined) {
      violations.push({
        key,
        invariant: "prefix",
        message: `carries the unmapped prefix "${prefix}" — add it to KEY_PREFIXES with the category it belongs to, or name the key under an existing subsystem`,
      });
      continue;
    }
    if (definition.category !== expectedCategory) {
      violations.push({
        key,
        invariant: "prefix",
        message: `is filed under "${definition.category}" but its prefix "${prefix}" maps to "${expectedCategory}"`,
      });
    }
  }
  return violations;
}

/** Every invariant, in one call. */
export function checkRegistryInvariants(declarations: Declarations): Violation[] {
  return [
    ...checkHelpPresent(declarations),
    ...checkDefaultsValid(declarations),
    ...checkNoCredentialShapedKey(declarations),
    ...checkNoUnmappedPrefix(declarations),
  ];
}
