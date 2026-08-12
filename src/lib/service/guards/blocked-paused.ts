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
// "you can't go there". `appliesTo` keys on `to` alone, exactly as the table
// above reads "Entering `blocked`" with no "from" column: it doesn't matter
// where the transition started, including a re-entry from `blocked` itself
// (see transition.ts's own comment on why the clearing step is guarded by
// `to`, not just `from`, for the reason that matters here).
import { guardOk, guardRejected, type Guard, type GuardInput } from "../state-machine/guard";

const BLOCKED_ON_TYPES = new Set(["person", "external_process", "time"]);

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Requires `blocked_reason` and `blocked_on_type` on every entry to
 * `blocked`, plus the field that `blocked_on_type` itself demands:
 * `blocked_on_person` when the type is `person`, `unblock_at` when it's
 * `time`. `external_process` needs nothing further — SCHEMA.md §16 only
 * names an extra requirement for the other two.
 */
export const blockedRequiredFieldsGuard: Guard = {
  id: "state-machine.blocked_required_fields",
  description:
    "Entering blocked requires blocked_reason and blocked_on_type, plus blocked_on_person " +
    "when the type is person or unblock_at when the type is time.",
  appliesTo: (_from, to) => to === "blocked",
  check(input: GuardInput) {
    const reason = input.fields.blocked_reason;
    if (!isNonEmptyString(reason)) {
      return guardRejected("blocked requires blocked_reason.", {
        fields: ["blocked_reason"],
      });
    }

    const onType = input.fields.blocked_on_type;
    if (typeof onType !== "string" || !BLOCKED_ON_TYPES.has(onType)) {
      return guardRejected("blocked requires a valid blocked_on_type.", {
        fields: ["blocked_on_type"],
      });
    }

    if (onType === "person" && !isNonEmptyString(input.fields.blocked_on_person)) {
      return guardRejected("blocked_on_type of person requires blocked_on_person.", {
        fields: ["blocked_on_person"],
      });
    }

    if (onType === "time" && !isPresentValue(input.fields.unblock_at)) {
      return guardRejected("blocked_on_type of time requires unblock_at.", {
        fields: ["unblock_at"],
      });
    }

    return guardOk;
  },
};

/** Requires `pause_reason` and `resume_condition` on every entry to `paused`. */
export const pausedRequiredFieldsGuard: Guard = {
  id: "state-machine.paused_required_fields",
  description: "Entering paused requires pause_reason and resume_condition.",
  appliesTo: (_from, to) => to === "paused",
  check(input: GuardInput) {
    if (!isNonEmptyString(input.fields.pause_reason)) {
      return guardRejected("paused requires pause_reason.", { fields: ["pause_reason"] });
    }
    if (!isNonEmptyString(input.fields.resume_condition)) {
      return guardRejected("paused requires resume_condition.", {
        fields: ["resume_condition"],
      });
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
