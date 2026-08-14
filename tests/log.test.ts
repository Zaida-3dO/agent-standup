import { describe, expect, test } from "vitest";
import {
  buildLogRecord,
  DEFAULT_LOG_LEVEL,
  describeError,
  isLevelEnabled,
  LOG_LEVELS,
  resolveLogLevel,
} from "@/lib/log";

describe("resolveLogLevel", () => {
  test("defaults when the variable is unset", () => {
    expect(resolveLogLevel({})).toBe(DEFAULT_LOG_LEVEL);
  });

  test("accepts every level it advertises, case- and space-insensitively", () => {
    for (const level of LOG_LEVELS) {
      expect(resolveLogLevel({ LOG_LEVEL: level })).toBe(level);
      expect(resolveLogLevel({ LOG_LEVEL: ` ${level.toUpperCase()} ` })).toBe(level);
    }
  });

  test("FALLS BACK rather than throwing on an unrecognised value", () => {
    // A typo in a deployment variable must not take the process down, and the
    // fallback direction is the safe one: it logs more than the typo asked
    // for, never less.
    expect(resolveLogLevel({ LOG_LEVEL: "verbose" })).toBe(DEFAULT_LOG_LEVEL);
    expect(resolveLogLevel({ LOG_LEVEL: "" })).toBe(DEFAULT_LOG_LEVEL);
  });
});

describe("isLevelEnabled", () => {
  test("admits its own level and everything above it", () => {
    expect(isLevelEnabled("warn", "warn")).toBe(true);
    expect(isLevelEnabled("error", "warn")).toBe(true);
    expect(isLevelEnabled("fatal", "warn")).toBe(true);
    expect(isLevelEnabled("info", "warn")).toBe(false);
    expect(isLevelEnabled("debug", "warn")).toBe(false);
  });

  test("the default threshold still admits the two levels that need a human", () => {
    expect(isLevelEnabled("warn", DEFAULT_LOG_LEVEL)).toBe(true);
    expect(isLevelEnabled("error", DEFAULT_LOG_LEVEL)).toBe(true);
    expect(isLevelEnabled("debug", DEFAULT_LOG_LEVEL)).toBe(false);
  });
});

describe("describeError", () => {
  test("renders what JSON.stringify would otherwise drop", () => {
    // `JSON.stringify(new Error("x"))` is `{}` — name, message and stack are
    // all non-enumerable. That is its own way of losing the error.
    const described = describeError(new Error("boom")) as Record<string, unknown>;
    expect(described.name).toBe("Error");
    expect(described.message).toBe("boom");
    expect(described.stack).toContain("boom");
    expect(JSON.stringify(new Error("boom"))).toBe("{}");
  });

  test("walks the cause chain to the innermost error", () => {
    // The interesting error is usually the innermost: a driver failure wrapped
    // in an InternalError says nothing useful at the outer layer. This is the
    // exact shape that made a 500 uninvestigable.
    const inner = new Error("FK violation");
    const outer = new Error("The operation failed unexpectedly.", { cause: inner });
    const described = describeError(outer) as Record<string, unknown>;
    expect((described.cause as Record<string, unknown>).message).toBe("FK violation");
  });

  test("carries a driver's own code, which is not part of Error", () => {
    const err = Object.assign(new Error("Raw query failed"), { code: "P2010" });
    expect((describeError(err) as Record<string, unknown>).code).toBe("P2010");
  });

  test("STOPS on a cause cycle rather than hanging", () => {
    // Not a failure to discover in production by wedging the logger.
    const a = new Error("a");
    const b = new Error("b", { cause: a });
    (a as { cause?: unknown }).cause = b;
    expect(() => JSON.stringify(describeError(a))).not.toThrow();
  });

  test("passes a non-Error through untouched", () => {
    expect(describeError("just a string")).toBe("just a string");
    expect(describeError(undefined)).toBe(undefined);
  });
});

describe("buildLogRecord", () => {
  test("returns null below the threshold, so nothing is written", () => {
    expect(buildLogRecord("debug", "noisy", {}, "info")).toBeNull();
    expect(buildLogRecord("error", "loud", {}, "info")).not.toBeNull();
  });

  test("always carries level, msg and a timestamp, plus caller context", () => {
    const at = new Date("2026-08-14T03:00:00.000Z");
    const record = buildLogRecord("warn", "something", { transport: "http" }, "debug", at);
    expect(record).toEqual({
      level: "warn",
      msg: "something",
      at: "2026-08-14T03:00:00.000Z",
      transport: "http",
    });
  });

  test("flattens an Error in the context so the line is real JSON", () => {
    const record = buildLogRecord("error", "failed", { err: new Error("boom") }, "debug");
    const err = record?.err as Record<string, unknown>;
    expect(err.message).toBe("boom");
    expect(() => JSON.stringify(record)).not.toThrow();
    expect(JSON.stringify(record)).toContain("boom");
  });
});
