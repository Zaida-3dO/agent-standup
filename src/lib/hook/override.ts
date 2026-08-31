// The override channel — making `block-overridable` actually overridable.
//
// `INTERVENTION_LEVELS` has had four members since the engine shipped:
// `nothing`, `nudge`, `block-overridable`, `hard-block`. Three of them
// worked. The third did not, and the way it failed is worth stating
// precisely, because it is not so much a missing feature as a level that
// quietly meant something other than its name.
//
// ── What was actually broken ────────────────────────────────────────────
//
// Nothing anywhere in the wire protocol carried an override. `HookEvent`
// had no field for one, `decide` had no branch for one, and so a finding
// at `block-overridable` produced exactly the same refusal as one at
// `hard-block`: a deny, with no way past it. The two levels were
// indistinguishable at the only point where the distinction is supposed
// to matter.
//
// The evidence that this was a real cost rather than a tidy gap is that
// two built-in entries have already had their remedies **deleted** because
// of it. `broad-process-kill` and `checkout-held-by-another-crew` both
// used to tell the caller to proceed with a written reason, and both had
// that sentence removed, because it promised an exit no caller could take.
// A guard that names a remedy it then refuses is the worst thing in this
// catalogue — it is the failure the scoring scale's 1 was written for, a
// block someone had to route around — and the fix at the time was to stop
// promising. This module is the other fix: make the promise keepable.
//
// ── Block-and-record, not block-and-argue ───────────────────────────────
//
// MILESTONES.md #128 frames this tier as **block-and-record**, and is
// blunt about why: an agent asked to justify itself will always produce a
// justification, so the value is the recorded reason on a reviewable
// event, not the friction.
//
// That framing decides essentially every design question here, and mostly
// by telling us **not** to do things. There is no adjudication of whether
// a reason is good, because there could not be one — no rule can tell a
// considered justification from a merely fluent one, and a check that
// tried would only teach callers to write longer. There is no allowance
// list of acceptable reasons, no reviewer in the loop, no escalation. An
// override succeeds on being *written down and attributed*, and the
// control is that somebody can read it afterwards beside the call it
// excused.
//
// What that leaves worth enforcing is small, and this module holds all of
// it: an override must name **which** finding it overrides, must carry a
// reason with content in it, and must never reach a `hard-block`.
//
// ── The one thing it must never do ──────────────────────────────────────
//
// A `hard-block` is not overridable. That is the whole difference between
// the two blocking levels, and it is enforced here by a function that
// cannot express the alternative: `overrideApplies` returns false for
// `hard-block` before it looks at anything else. A caller can send a
// perfectly-formed override for a hard block and be refused anyway, which
// is the correct and intended outcome.
//
// This is deliberately *not* left to the caller to respect. The service
// side learned the same lesson with `merge_override`, which is scoped so
// it can never satisfy the human-authorisation clause however it is
// written: an escape hatch is only safe when its limits are structural
// rather than advisory.

import { isBlockingLevel, type InterventionLevel } from "../interventions/types";

/**
 * The shortest reason that counts as having said something.
 *
 * Twenty characters, deliberately matching `MIN_REASON_LENGTH` on the
 * service side's `merge_override`: the same judgement is being made about
 * the same kind of statement, and two different floors would mean an
 * override accepted by the hook and refused by the service — precisely the
 * "do the right thing and still be refused" split this system already has
 * one of.
 *
 * A length floor is a crude proxy and does not pretend otherwise: it cannot
 * tell a considered sentence from forty characters of keyboard. What it
 * removes is the one-character reason, which is the form a mandatory field
 * collapses into when nothing checks it. A real reason clears it
 * comfortably; a dismissal does not.
 */
export const MIN_OVERRIDE_REASON_LENGTH = 20;

/**
 * The longest reason that is stored.
 *
 * Bounded because this reaches a database column and rides the hook's
 * critical path, and unbounded free text on both is how a guard becomes the
 * slowest thing in a session. Generous enough that nobody hits it while
 * writing an honest sentence.
 */
export const MAX_OVERRIDE_REASON_LENGTH = 1000;

/** An override as a caller sends it. */
export interface OverrideClaim {
  /**
   * The entry being overridden, e.g. `broad-process-kill`.
   *
   * Required, and this is the field that makes an override a statement
   * rather than a mood. A blanket claim to have a reason would let one
   * written justification excuse every finding on a call — including one
   * the caller never read, and including one that fires later for a
   * different reason. Naming the entry scopes an override to the thing the
   * caller actually looked at, the way `merge_override` is scoped to the
   * commit it was written about rather than standing forever.
   */
  readonly entryId: string;
  /** Why the caller believes proceeding is right. Recorded verbatim. */
  readonly reason: string;
}

/** Why an override was not honoured, in words a caller can act on. */
export type OverrideRefusal =
  "no-override" | "wrong-entry" | "reason-too-short" | "level-not-overridable";

/**
 * Whether an override lets this finding through.
 *
 * The refusals are kept separate rather than collapsed into a boolean
 * because they need different things said back: not sending one, sending
 * one for a different finding, and a finding that cannot be overridden at
 * all are three different next actions, and a caller told only that it was
 * refused would retry the wrong one.
 */
export interface OverrideOutcome {
  readonly applies: boolean;
  readonly refusal?: OverrideRefusal;
  /** The reason, trimmed, when the override stands. */
  readonly reason?: string;
}

/**
 * Whether `claim` overrides a finding on `entryId` at `level`.
 *
 * **`hard-block` is checked first and unconditionally.** Everything after
 * that line concerns a `block-overridable`; nothing after it can reach a
 * hard block, whatever it is sent.
 *
 * A non-blocking level (`nudge`, `nothing`) also yields `applies: false`,
 * and that is not a refusal in any meaningful sense — there was nothing to
 * override, because nothing was being blocked. Callers read `applies` for
 * the decision and consult `refusal` only when something was actually
 * stopped.
 */
export function overrideApplies(
  claim: OverrideClaim | undefined,
  entryId: string,
  level: InterventionLevel,
): OverrideOutcome {
  // Unconditional and first. A hard block is refused before the claim is
  // examined at all, so no property of a well-formed override can reach it.
  if (level === "hard-block") {
    return { applies: false, refusal: "level-not-overridable" };
  }

  // Nothing was blocked, so there is nothing to override. Not a refusal.
  if (!isBlockingLevel(level)) return { applies: false };

  if (claim === undefined) return { applies: false, refusal: "no-override" };

  // Scoped to the named entry. An override written for one finding does not
  // excuse a different one that happened to fire on the same call.
  if (claim.entryId !== entryId) return { applies: false, refusal: "wrong-entry" };

  const reason = claim.reason.trim();
  if (reason.length < MIN_OVERRIDE_REASON_LENGTH) {
    return { applies: false, refusal: "reason-too-short" };
  }

  return { applies: true, reason: reason.slice(0, MAX_OVERRIDE_REASON_LENGTH) };
}

/**
 * Reads an override claim off an arbitrary value — a field on a hook
 * payload.
 *
 * Returns `undefined` for anything malformed rather than throwing or
 * partially accepting. **The direction of that failure is the point**: a
 * garbled override reads as *no override*, so the call stays blocked. The
 * opposite bias — treating an unreadable claim as good enough — would let a
 * malformed payload open the gate, which is the one way an escape hatch
 * turns into a bypass.
 */
export function readOverrideClaim(value: unknown): OverrideClaim | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;

  const entryId = record.entryId ?? record.entry_id;
  const reason = record.reason;

  if (typeof entryId !== "string" || entryId.trim() === "") return undefined;
  if (typeof reason !== "string" || reason.trim() === "") return undefined;

  return { entryId: entryId.trim(), reason: reason.trim() };
}

/**
 * What to tell a caller whose blocked call could have been overridden.
 *
 * The wording is load-bearing in one specific way: it says the reason is
 * **recorded**, because a caller who thinks an override is a free pass
 * writes a different sentence from one who knows it will be read. That is
 * the entire mechanism — there is no other enforcement — so concealing it
 * would not make the control stronger, it would make the recorded reasons
 * useless.
 *
 * Returns `null` for a `hard-block`, because offering an override that
 * cannot be taken is exactly the broken promise this module exists to end.
 * A hard block says nothing about overrides at all.
 */
export function overrideRemedy(entryId: string, level: InterventionLevel): string | null {
  if (level !== "block-overridable") return null;
  return (
    `This block can be overridden. To proceed, re-run the call with an override naming ` +
    `"${entryId}" and a written reason of at least ${MIN_OVERRIDE_REASON_LENGTH} characters ` +
    `saying why it is right to go ahead. The reason is recorded against this finding and can ` +
    `be read later — it is kept as a record, not checked for correctness.`
  );
}
