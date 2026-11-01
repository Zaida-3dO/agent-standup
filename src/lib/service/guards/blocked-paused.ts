// Guards for entering `blocked` and `paused`. See docs/plans/MILESTONES.md
// #16, SCHEMA.md §16:
//
//   | Entering  | Required |
//   |-----------|----------|
//   | `blocked` | `blocked_reason` + `blocked_on_type`; plus `blocked_on_person`
//   |           | iff type is `person`, or `unblock_at` iff type is `time`. |
//   | `paused`  | `pause_reason` + `resume_condition`. |
//
// A guard is a required-field check, never a forbidden move (guard.ts's own
// header) — these two only ever say "you're missing something", never
// "you can't go there". And a missing required field is process, so it
// nudges rather than refuses: the state is entered, and the answer names
// what was not recorded and how to record it now (re-entering the state with
// the fields — these guards run on every entry, `from` included). What still
// refuses is a supplied value outside the legal enum: the call itself is
// malformed, there is no branch to explain, and applying it would store a
// `blocked_on_type` no reader of the row can interpret.
//
// `appliesTo` keys on `to` alone, exactly as the table
// above reads "Entering `blocked`" with no "from" column: it doesn't matter
// where the transition started, including a re-entry from `blocked` itself
// (see transition.ts's own comment on why the clearing step is guarded by
// `to`, not just `from`, for the reason that matters here).
import {
  guardNudged,
  guardOk,
  guardRejected,
  type Guard,
  type GuardInput,
} from "../state-machine/guard";
// The literal key names come from the accepted-key table, not from string
// literals here: a key this guard consumes but that table does not declare
// would be refused at the door by `assertTransitionFieldsAccepted` and then
// demanded by this guard — the contradiction the table exists to make
// unrepresentable. See `../state-machine/transition-fields.ts`.
import { TRANSITION_FIELD } from "../state-machine/transition-fields";

const BLOCKED_ON_TYPES = ["person", "external_process", "time"] as const;
const BLOCKED_ON_TYPES_SET: ReadonlySet<string> = new Set(BLOCKED_ON_TYPES);

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Requires `blocked_reason` and `blocked_on_type` on every entry to
 * `blocked`, plus the field that `blocked_on_type` itself demands:
 * `blocked_on_person` when the type is `person`, `unblock_at` when it's
 * `time`. `external_process` needs nothing further — SCHEMA.md §16 only
 * names an extra requirement for the other two.
 *
 * ── Why every missing requirement is named at once ──────────────────────
 *
 * Row a7f39116-9281-4269-8938-539b5bbbb987. A chain of early returns that
 * each named one field would make a caller supplying nothing pay three
 * round trips to learn `blocked_reason`, then `blocked_on_type`, then the
 * conditional field. **The requirements are a static property of the
 * state, not something discovered by evaluating the input** — this guard
 * knows before it reads a single field that a person-shaped block will
 * need a person named. Naming them all costs the same one message.
 *
 * The bar is this codebase's own `summaries/validate.ts`, which reports the
 * field, the offending value and the cap together and says outright that it
 * will not truncate for you, so a one-character overrun is fixable on the
 * first retry. This now matches it.
 *
 * **What it must not do is over-report**, which is this defect in reverse
 * and worse: demanding `blocked_on_person` for an `external_process` block
 * sends a caller looking for a person who does not exist, and there is no
 * value they can supply that helps. So the conditional requirement is only
 * ever named when the supplied `blocked_on_type` actually implies it. When
 * the type is absent entirely, neither conditional field is *demanded* —
 * the message explains the branch ("if you block on a person…") in prose
 * while `fields` stays limited to what is genuinely required right now.
 * That keeps `fields` a list a caller can act on literally.
 *
 * An invalid (rather than absent) `blocked_on_type` still refuses on its
 * own, because until the type is a legal value there is no branch to
 * report and listing a conditional field alongside it would be a guess —
 * and unlike a missing field, a value already supplied wrong cannot be
 * completed by a later call: it has to be corrected at the source. That is
 * the line this file draws — missing evidence nudges, a malformed supplied
 * value refuses.
 */
export const blockedRequiredFieldsGuard: Guard = {
  id: "state-machine.blocked_required_fields",
  description:
    "Entering blocked nudges when required fields are missing: blocked_reason and " +
    "blocked_on_type, plus blocked_on_person when the type is person or unblock_at when the " +
    "type is time. Re-enter blocked with the fields to record them. A blocked_on_type that is " +
    "not one of the three legal values is refused.",
  appliesTo: (_from, to) => to === "blocked",
  check(input: GuardInput) {
    const onType = input.fields[TRANSITION_FIELD.blocked_on_type];
    const onTypeSupplied = onType !== undefined && onType !== null && onType !== "";

    // An invalid *value* is its own refusal — see the doc comment. Named
    // values, not just the field name, matching the convention
    // `NOT_DONE_REASONS` validation already uses (summaries/validate.ts).
    // Row c1ee5fbc-2926-4315-87dd-6d4ad2ab69e9: a caller who hit this with
    // an internal-work blocker got refused twice with no hint that
    // `person`, `external_process` and `time` are the only legal values.
    if (onTypeSupplied && (typeof onType !== "string" || !BLOCKED_ON_TYPES_SET.has(onType))) {
      return guardRejected(
        `blocked requires a valid blocked_on_type: must be one of ${BLOCKED_ON_TYPES.join(", ")}; got ${JSON.stringify(onType)}.`,
        { fields: ["blocked_on_type"] },
      );
    }

    const missing: string[] = [];
    if (!isNonEmptyString(input.fields[TRANSITION_FIELD.blocked_reason])) {
      missing.push(TRANSITION_FIELD.blocked_reason);
    }
    if (!onTypeSupplied) missing.push(TRANSITION_FIELD.blocked_on_type);
    if (
      onType === "person" &&
      !isNonEmptyString(input.fields[TRANSITION_FIELD.blocked_on_person])
    ) {
      missing.push(TRANSITION_FIELD.blocked_on_person);
    }
    if (onType === "time" && !isPresentValue(input.fields[TRANSITION_FIELD.unblock_at])) {
      missing.push(TRANSITION_FIELD.unblock_at);
    }

    if (missing.length === 0) return guardOk;

    // A nudge, not a refusal: the block itself is applied and the item is
    // genuinely blocked — what is missing is the record of why, and the
    // caller can supply it on this same item without undoing anything.
    return guardNudged(blockedMissingMessage(missing, onTypeSupplied ? String(onType) : null));
  },
};

/**
 * The one message that names everything missing and how to record it now.
 *
 * Built here rather than inline so the branch explanation and the
 * already-satisfied case read as one piece of prose. `missing` is never
 * empty when this is called.
 */
function blockedMissingMessage(missing: readonly string[], onType: string | null): string {
  const list = missing.join(", ");
  const head = `blocked requires ${list}.`;
  // Re-entering the state re-runs this guard with the fields, which is how a
  // blocked item gets its missing record after the fact — spelled out
  // because "supply them together" is no use to a caller whose item is
  // already sitting in `blocked`.
  const howToFix =
    " The block was applied without them — enter blocked again (blocked → blocked) with the " +
    "missing fields supplied to record them.";

  if (onType === null) {
    // No type supplied, so the conditional requirement is not yet
    // determined — explain the branch without demanding either field.
    return (
      `${head} blocked_on_type must be one of ${BLOCKED_ON_TYPES.join(", ")}; ` +
      "a person block also requires blocked_on_person, and a time block also requires " +
      "unblock_at. external_process requires nothing further. " +
      "Supply them together — this will not be accepted one field at a time." +
      howToFix
    );
  }

  if (onType === "person") {
    return (
      `${head} blocked_on_type is person, which requires blocked_on_person (a person id).` +
      howToFix
    );
  }
  if (onType === "time") {
    return `${head} blocked_on_type is time, which requires unblock_at (a timestamp).` + howToFix;
  }
  return `${head} blocked_on_type of ${onType} requires nothing further.` + howToFix;
}

/**
 * Nudges when `pause_reason` or `resume_condition` is missing on entry to
 * `paused` — the pause is applied either way, and the answer says how to
 * record what was skipped (enter `paused` again with the field, which
 * re-runs this guard). See this file's header for the nudge/refusal line.
 */
export const pausedRequiredFieldsGuard: Guard = {
  id: "state-machine.paused_required_fields",
  description:
    "Entering paused nudges when pause_reason or resume_condition is missing. Re-enter " +
    "paused with the field to record it.",
  appliesTo: (_from, to) => to === "paused",
  check(input: GuardInput) {
    if (!isNonEmptyString(input.fields[TRANSITION_FIELD.pause_reason])) {
      return guardNudged(
        "paused requires pause_reason. The pause was applied without it — enter paused " +
          "again (paused → paused) with pause_reason to record it.",
      );
    }
    if (!isNonEmptyString(input.fields[TRANSITION_FIELD.resume_condition])) {
      return guardNudged(
        "paused requires resume_condition. The pause was applied without it — enter paused " +
          "again (paused → paused) with resume_condition to record it.",
      );
    }
    return guardOk;
  },
};

/**
 * `unblock_at` is a timestamp, not prose — a caller may supply it as a `Date`
 * (an in-process call) or an ISO string (over an adapter that has already
 * deserialised JSON), so this checks presence and a parseable value rather
 * than assuming one representation. An empty string is rejected the same as
 * `undefined`.
 */
function isPresentValue(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (value instanceof Date) return !Number.isNaN(value.getTime());
  if (typeof value === "string") return value.trim().length > 0 && !Number.isNaN(Date.parse(value));
  return false;
}

/** Both guards, for the registration module to install in one call. */
export const BLOCKED_PAUSED_GUARDS: readonly Guard[] = [
  blockedRequiredFieldsGuard,
  pausedRequiredFieldsGuard,
];
