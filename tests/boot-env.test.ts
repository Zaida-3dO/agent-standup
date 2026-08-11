// Unit-level, no DB and no subprocess needed — see tests/entrypoint.test.ts
// for the black-box proof that these rejections actually stop
// scripts/entrypoint.mjs from hanging (the real bug this exists to fix).
import { describe, expect, it } from "vitest";
import {
  DEFAULT_DB_WAIT_INTERVAL_SECONDS,
  DEFAULT_DB_WAIT_TIMEOUT_SECONDS,
  InvalidDurationEnvError,
  parseDurationSecondsMs,
} from "../scripts/lib/boot-env.mjs";

describe("parseDurationSecondsMs", () => {
  it("resolves to the default * 1000 when the variable is genuinely unset", () => {
    expect(parseDurationSecondsMs({}, "DB_WAIT_TIMEOUT_SECONDS", 60)).toBe(60_000);
  });

  it("parses a valid whole-number string", () => {
    expect(parseDurationSecondsMs({ X: "5" }, "X", 60)).toBe(5000);
  });

  it("parses a valid decimal string", () => {
    expect(parseDurationSecondsMs({ X: "0.3" }, "X", 60)).toBe(300);
  });

  it.each([
    ["empty string — what an unset `${VAR:-}` in Compose yields", ""],
    ["a duration typo with a unit suffix", "60s"],
    ["another duration typo with a unit suffix", "2m"],
    ["non-numeric garbage", "abc"],
    ["zero, explicitly", "0"],
    ["a negative number", "-1"],
    ["whitespace only", "   "],
    ["Infinity, which Number() parses but isn't a bounded duration", "Infinity"],
    ["a seconds value that is itself finite but overflows to Infinity once * 1000", "1e308"],
  ])("rejects %s (%j) rather than silently falling back to the default", (_label, raw) => {
    expect(() => parseDurationSecondsMs({ X: raw }, "X", 60)).toThrow(InvalidDurationEnvError);
  });

  it("names the offending variable and its raw value in the error", () => {
    try {
      parseDurationSecondsMs({ DB_WAIT_TIMEOUT_SECONDS: "60s" }, "DB_WAIT_TIMEOUT_SECONDS", 60);
      throw new Error("expected parseDurationSecondsMs to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(InvalidDurationEnvError);
      const invalidErr = err as InstanceType<typeof InvalidDurationEnvError>;
      expect(invalidErr.varName).toBe("DB_WAIT_TIMEOUT_SECONDS");
      expect(invalidErr.rawValue).toBe("60s");
      expect(invalidErr.message).toContain("DB_WAIT_TIMEOUT_SECONDS");
      expect(invalidErr.message).toContain("60s");
    }
  });

  it("pins the default timeout comfortably above the recorded cold-boot observation", () => {
    // A dedicated pin, not a `toBeGreaterThan(0)` sanity check — that check
    // is satisfied by *any* positive value, so it would not catch a later
    // edit that quietly lowers the default. docker-compose.prod.yml records
    // an observed ~100s cold Postgres boot on slow disk; the default must
    // stay comfortably above that number, not just above zero.
    expect(DEFAULT_DB_WAIT_TIMEOUT_SECONDS).toBe(180);
    expect(DEFAULT_DB_WAIT_TIMEOUT_SECONDS).toBeGreaterThan(100);
    expect(DEFAULT_DB_WAIT_INTERVAL_SECONDS).toBe(2);
  });
});
