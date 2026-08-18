// The historical-verification env gate (#138).
//
// These are the tests that matter most in the change, for the reason the
// backfill gate's own suite gives: a gate proven only in its enabled state
// has never actually been run against the thing it exists to refuse. This
// one carries more weight than most, because while the window is open an
// item can enter `merged` without any review having approved it — so every
// spelling that must NOT open it is a spelling that must not silently widen
// the merge gate.
//
// Deliberately needs no database. The decision is a pure function of one
// environment variable, and keeping it that way is what lets every failure
// mode be enumerated here rather than sampled.
import { describe, expect, it } from "vitest";
import {
  HISTORICAL_VERIFICATION_ENABLED_VALUE,
  HISTORICAL_VERIFICATION_ENV_VAR,
  historicalVerificationStartupWarning,
  isHistoricalVerificationEnabled,
} from "@/lib/service/guards/historical-verification-enabled";

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

describe("the historical-verification window fails closed", () => {
  it("opens on exactly one value", () => {
    const env = { [HISTORICAL_VERIFICATION_ENV_VAR]: HISTORICAL_VERIFICATION_ENABLED_VALUE };
    expect(isHistoricalVerificationEnabled(env)).toBe(true);
  });

  it.each(DISABLED_VALUES)("stays closed for %s", (_label, value) => {
    const env = value === undefined ? {} : { [HISTORICAL_VERIFICATION_ENV_VAR]: value };
    expect(isHistoricalVerificationEnabled(env)).toBe(false);
  });

  it("ignores every other variable in the environment", () => {
    // A gate that could be opened by a neighbouring name would be one more
    // spelling nobody is watching.
    expect(
      isHistoricalVerificationEnabled({
        ENABLE_BACKFILL: "true",
        ENABLE_HISTORICAL_VERIFICATIONS: "true",
        HISTORICAL_VERIFICATION: "true",
      }),
    ).toBe(false);
  });
});

describe("the startup warning", () => {
  it("is silent when the window is closed — which is what gives the line its meaning", () => {
    expect(historicalVerificationStartupWarning({})).toBeNull();
  });

  it.each(DISABLED_VALUES)("is silent for %s", (_label, value) => {
    const env = value === undefined ? {} : { [HISTORICAL_VERIFICATION_ENV_VAR]: value };
    expect(historicalVerificationStartupWarning(env)).toBeNull();
  });

  it("names the variable to unset, so the reader can act on it without looking anything up", () => {
    const warning = historicalVerificationStartupWarning({
      [HISTORICAL_VERIFICATION_ENV_VAR]: HISTORICAL_VERIFICATION_ENABLED_VALUE,
    });
    expect(warning).not.toBeNull();
    expect(warning).toContain(HISTORICAL_VERIFICATION_ENV_VAR);
    // The realistic failure is opening the window for one cleanup and
    // leaving it open, so the line has to say what the open window MEANS,
    // not merely that a flag is set.
    expect(warning).toContain("merge");
  });
});
