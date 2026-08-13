// The backfill env gate. These are the tests that matter most in this
// change: a gate proven only in its enabled state has never actually been
// run against the thing it exists to refuse.
//
// The failure mode being guarded is a gate that is *open* for every value
// its author did not think of — `value !== "false"`, or a truthiness test
// on a raw string (in JavaScript every non-empty string is truthy,
// including `"false"`). So the enabled case is one test and the disabled
// cases are many.
import { describe, expect, it } from "vitest";
import { backfillWarning } from "../scripts/entrypoint.mjs";
import {
  BACKFILL_DISABLE_REMINDER,
  BACKFILL_ENABLED_VALUE,
  BACKFILL_ENV_VAR,
  backfillStartupWarning,
  isBackfillEnabled,
} from "@/lib/backfill/enabled";

/** Every spelling that must NOT open the window. */
const DISABLED_VALUES: [string, string | undefined][] = [
  ["unset", undefined],
  ["empty string", ""],
  ["a single space", " "],
  ["whitespace", "   "],
  ["the string false", "false"],
  ["the number one", "1"],
  ["zero", "0"],
  ["yes", "yes"],
  ["on", "on"],
  ["enabled", "enabled"],
  ["uppercase TRUE", "TRUE"],
  ["title case True", "True"],
  ["true with a trailing space", "true "],
  ["true with a leading space", " true"],
  ["true with a newline", "true\n"],
  ["truthy-looking garbage", "definitely"],
  ["a JSON boolean", '"true"'],
];

describe("isBackfillEnabled", () => {
  it("opens the window for the one exact affirmative", () => {
    expect(isBackfillEnabled({ [BACKFILL_ENV_VAR]: BACKFILL_ENABLED_VALUE })).toBe(true);
    expect(isBackfillEnabled({ [BACKFILL_ENV_VAR]: "true" })).toBe(true);
  });

  it.each(DISABLED_VALUES)("keeps the window CLOSED for %s", (_label, value) => {
    // Every one of these is a value a `!== "false"` gate would have let
    // through. Changing the comparison in enabled.ts from `===` to `!==`
    // flips this whole table red, which is the point.
    expect(isBackfillEnabled(value === undefined ? {} : { [BACKFILL_ENV_VAR]: value })).toBe(false);
  });

  it("ignores every other variable in the environment", () => {
    expect(isBackfillEnabled({ ENABLE_BACKFILLS: "true", BACKFILL: "true" })).toBe(false);
  });

  it("is case-sensitive on the variable name too", () => {
    expect(isBackfillEnabled({ enable_backfill: "true" })).toBe(false);
  });
});

describe("backfillStartupWarning", () => {
  it("says nothing at all when the window is closed", () => {
    // Silence is what gives the warning its meaning — a line printed on
    // every boot is a line nobody reads.
    expect(backfillStartupWarning({})).toBeNull();
    expect(backfillStartupWarning({ [BACKFILL_ENV_VAR]: "false" })).toBeNull();
  });

  it("names the variable and says how to close the window", () => {
    const warning = backfillStartupWarning({ [BACKFILL_ENV_VAR]: "true" });
    expect(warning).toContain("ENABLED");
    expect(warning).toContain(BACKFILL_ENV_VAR);
    expect(warning).toContain("bypasses the state machine");
  });
});

describe("the entrypoint's copy of the rule", () => {
  // `scripts/entrypoint.mjs` is plain JavaScript run before anything is
  // built, so it cannot import the TypeScript module — it restates the
  // rule. This is the mechanism that stops the two drifting: they are run
  // against the same table and must agree on every row.
  const ALL_VALUES: (string | undefined)[] = [...DISABLED_VALUES.map(([, value]) => value), "true"];

  it.each(ALL_VALUES.map((value) => [String(value), value] as const))(
    "agrees with isBackfillEnabled for %s",
    (_label, value) => {
      const env = value === undefined ? {} : { [BACKFILL_ENV_VAR]: value };
      expect(backfillWarning(env) !== null).toBe(isBackfillEnabled(env));
    },
  );

  it("produces the same message as the library when the window is open", () => {
    const env = { [BACKFILL_ENV_VAR]: "true" };
    expect(backfillWarning(env)).toBe(backfillStartupWarning(env));
  });
});

describe("BACKFILL_DISABLE_REMINDER", () => {
  it("tells the caller how to close the window it just used", () => {
    expect(BACKFILL_DISABLE_REMINDER).toContain(BACKFILL_ENV_VAR);
    expect(BACKFILL_DISABLE_REMINDER).toContain("restart");
  });
});
