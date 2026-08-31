// A usage reading, and whether it is old enough to stop trusting.
// MILESTONES.md #56; SCHEMA.md §15.
//
// The schema states the requirement in one line and it is the whole of this
// module's reason to exist: `usage_at` is "when that snapshot was taken —
// **a stale reading is worse than none**". A number with no age attached is
// indistinguishable from a current one, so every consumer that read
// `accounts.usage_5h` directly would be deciding on a figure that might have
// been taken days ago, with no way to know it.
//
// So a reading is never handed out as a bare number. It arrives as one of
// three answers, and a caller has to say what it does about each:
//
//   - `fresh`  — a value, taken recently enough to act on.
//   - `stale`  — a value, and how old it is. The number is still carried,
//                because "83% as of six hours ago" is genuinely more
//                information than nothing and a caller may reasonably show
//                it. What a caller must *not* do is treat it as current, and
//                a discriminated union is what makes that a compile error
//                rather than a matter of discipline.
//   - `absent` — no reading at all.
//
// **Why `stale` carries its value rather than collapsing into `absent`.**
// The two are different facts and the difference is actionable. `absent`
// means the account has never been measured — nothing is wired up, and the
// fix is configuration. `stale` means it *was* being measured and has
// stopped, which is a machine that has gone quiet, and the fix is on that
// machine. Collapsing them erases that distinction at exactly the moment
// someone needs it, and throws away the last known figure while doing so.

/** How a reading reads once its age has been taken into account. */
export type UsageReading =
  | {
      readonly status: "fresh";
      /** Percent of the window consumed, as reported. */
      readonly value: number;
      readonly takenAt: Date;
      /** How old the reading was, in seconds, at the moment it was resolved. */
      readonly ageSeconds: number;
    }
  | {
      readonly status: "stale";
      readonly value: number;
      readonly takenAt: Date;
      readonly ageSeconds: number;
    }
  | {
      readonly status: "absent";
      /**
       * Why there is none. `never-reported` is an account carrying no value.
       * `no-timestamp` is the shape that should not occur but is
       * representable in the schema — a value with no `usage_at` beside it,
       * which cannot be aged and therefore cannot be trusted, so it is
       * refused rather than assumed current.
       */
      readonly reason: "never-reported" | "no-timestamp";
    };

/**
 * The raw halves of a reading as they sit on `Account`.
 *
 * `value` accepts `string | number` because Prisma's raw driver returns
 * `NUMERIC` as a string and `service/admin/account-row.ts` deliberately
 * keeps it that way. Both are taken here so a caller need not remember
 * which one it is holding.
 */
export interface RawReading {
  readonly value: string | number | null;
  readonly takenAt: Date | string | null;
}

/**
 * Reads a stored reading, deciding fresh from stale against `now`.
 *
 * `staleAfterSeconds` is a parameter rather than a settings lookup, so this
 * module stays pure and testable at every boundary without a database; the
 * one caller holding a settings snapshot resolves it there.
 *
 * **A reading taken in the future is treated as fresh, not refused.** Clock
 * skew between a machine and the server is ordinary and small, and the
 * failure mode of refusing it — an account that looks unmeasured because a
 * laptop is forty seconds ahead — is worse than the failure mode of taking
 * it. `ageSeconds` is floored at zero so no consumer meets a negative age it
 * would have to reason about.
 */
export function resolveReading(
  raw: RawReading,
  now: Date,
  staleAfterSeconds: number,
): UsageReading {
  if (raw.value === null || raw.value === undefined) {
    return { status: "absent", reason: "never-reported" };
  }
  if (raw.takenAt === null || raw.takenAt === undefined) {
    return { status: "absent", reason: "no-timestamp" };
  }

  const takenAt = raw.takenAt instanceof Date ? raw.takenAt : new Date(raw.takenAt);
  if (Number.isNaN(takenAt.getTime())) {
    return { status: "absent", reason: "no-timestamp" };
  }

  const value = typeof raw.value === "number" ? raw.value : Number(raw.value);
  if (!Number.isFinite(value)) {
    return { status: "absent", reason: "never-reported" };
  }

  const ageSeconds = Math.max(0, (now.getTime() - takenAt.getTime()) / 1000);
  // `>` rather than `>=`: a reading exactly at the threshold has not yet
  // exceeded the age it is allowed to be, and the setting reads as "stale
  // AFTER n seconds". Asserted in the tests precisely because either choice
  // is defensible and only one of them is the one written.
  const status = ageSeconds > staleAfterSeconds ? "stale" : "fresh";
  return { status, value, takenAt, ageSeconds };
}

/**
 * The number a caller may act on, or null.
 *
 * The convenience for the common case — a consumer with no separate
 * behaviour for a stale reading, which must not silently use one anyway.
 * Deliberately returns `null` for `stale` as well as `absent`: this function
 * asks "may I treat this as current", and a stale reading answers no. A
 * caller that wants to *display* a stale figure reads the union directly.
 */
export function actionableValue(reading: UsageReading): number | null {
  return reading.status === "fresh" ? reading.value : null;
}
