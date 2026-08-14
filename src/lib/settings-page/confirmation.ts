// The typed-confirmation gate — SCHEMA.md §17.8: a `sensitive` setting
// "requires typing the setting's key to confirm", and `irreversible` is
// "everything `sensitive` does, plus…".
//
// **This is a refusal, and the refusal is the feature.** A gate that never
// says no passes a happy-path suite and protects nothing (CLAUDE.md's
// testing tenet), so everything here is written to be provable in both
// directions: it allows exactly the input it should and refuses everything
// else, including the near-misses that a lenient comparison would wave
// through.
//
// **Which keys are gated is read off the registry**, never a second list —
// the same rule the command line applies in `src/lib/cli/config-command.ts`.
// A key becomes gated by having its flag set in the registry, and no edit
// here is needed or possible to change that.
import { getDefinition, isSettingKey } from "@/lib/settings";

/** What a write is asking to do. Clearing a guarded key is gated too — §17.8 makes no exception for it. */
export type WriteVerb = "set" | "reset";

export type ConfirmationDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: string; readonly needsTyped: string };

/**
 * Whether a key needs typed confirmation at all.
 *
 * A key this build does not declare returns `false` — not because it is
 * safe, but because a name the registry has never heard of cannot be *known*
 * to be sensitive, and the write is refused anyway further down by the
 * service's own `requireSettingKey`. Inventing a gate for it here would be a
 * guess dressed as a safety check, and it would be the wrong guess in the
 * one case that matters: an unrecognised row's remove action, which §17.3
 * offers plainly and which no flag can be read for.
 */
export function requiresConfirmation(key: string): boolean {
  if (!isSettingKey(key)) return false;
  const definition = getDefinition(key);
  return definition.sensitive || definition.irreversible;
}

/** Why this key is gated, in the words the confirmation prompt uses. */
export function guardReason(key: string): string | null {
  if (!isSettingKey(key)) return null;
  const definition = getDefinition(key);
  if (definition.irreversible) {
    return "This setting can destroy data that cannot be recreated.";
  }
  if (definition.sensitive) {
    return "This setting relaxes something the system enforces.";
  }
  return null;
}

/**
 * Decides whether a write may proceed.
 *
 * The comparison is **exact**: the typed text must equal the key character
 * for character. Not trimmed, not case-folded, not prefix-matched. Every one
 * of those relaxations is individually reasonable-sounding and collectively
 * turns "type the key to confirm" into "type something roughly like it",
 * which is the state the gate exists to prevent — the point of typing the
 * key is that it cannot be done by accident, and an accident is precisely
 * what a forgiving comparison lets through.
 *
 * An empty confirmation is refused for the same reason and by the same
 * comparison: no key is the empty string, so there is no special case to
 * write and none that could be bypassed by one.
 */
export function confirmWrite(args: {
  readonly key: string;
  readonly verb: WriteVerb;
  /** Exactly what the person typed into the confirmation box. `null` when they typed nothing. */
  readonly typed: string | null;
}): ConfirmationDecision {
  if (!requiresConfirmation(args.key)) return { allowed: true };

  if (args.typed === args.key) return { allowed: true };

  const why = guardReason(args.key) ?? "This setting is guarded.";
  const action = args.verb === "reset" ? "reset it to its default" : "change it";
  return {
    allowed: false,
    reason: `${why} Type ${args.key} to confirm you want to ${action}.`,
    needsTyped: args.key,
  };
}
