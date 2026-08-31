// A usage reading and its age — MILESTONES.md #56, SCHEMA.md §15.
//
// The distinctions under test are the ones the schema says matter: a stale
// reading must be tellable from a fresh one, and both from no reading at
// all. Every fixture below therefore uses *different* clock values on the
// two sides of the comparison — a fixture whose "taken at" and "now" are
// the same instant cannot tell a threshold that moves from one that does
// not, and would pass against an implementation ignoring the age entirely.
import { describe, it, expect } from "vitest";
import { resolveReading, actionableValue, type UsageReading } from "@/lib/budget/reading";

/** A fixed server clock. Every expectation below is relative to this. */
const NOW = new Date("2026-08-31T12:00:00.000Z");

/** How many seconds before NOW, as an instant. */
function ago(seconds: number): Date {
  return new Date(NOW.getTime() - seconds * 1000);
}

const STALE_AFTER = 900;

describe("resolveReading — fresh", () => {
  it("reports a recent reading as fresh, carrying its value and age", () => {
    const reading = resolveReading({ value: 42.5, takenAt: ago(60) }, NOW, STALE_AFTER);

    expect(reading.status).toBe("fresh");
    // Narrowed so the value and age fields are reachable; absent has neither.
    if (reading.status === "absent") throw new Error("expected a value");
    expect(reading.value).toBe(42.5);
    expect(reading.ageSeconds).toBe(60);
    expect(reading.takenAt.toISOString()).toBe(ago(60).toISOString());
  });

  it("reads a NUMERIC returned as a string, which is what the raw driver gives", () => {
    // Not hypothetical: service/admin/account-row.ts documents that Prisma
    // raw returns NUMERIC as a string and deliberately keeps it that way.
    const reading = resolveReading({ value: "83.25", takenAt: ago(10) }, NOW, STALE_AFTER);

    if (reading.status === "absent") throw new Error("expected a value");
    expect(reading.value).toBe(83.25);
    expect(reading.status).toBe("fresh");
  });

  it("accepts an ISO string timestamp as well as a Date", () => {
    const reading = resolveReading({ value: 10, takenAt: ago(30).toISOString() }, NOW, STALE_AFTER);

    expect(reading.status).toBe("fresh");
    if (reading.status === "absent") throw new Error("expected a value");
    expect(reading.ageSeconds).toBe(30);
  });
});

describe("resolveReading — the staleness boundary", () => {
  // The three cases around the threshold, asserted separately. A single
  // "old readings are stale" test passes against an off-by-one and against
  // a threshold read from the wrong variable; these do not.
  it("is fresh one second inside the threshold", () => {
    const reading = resolveReading({ value: 50, takenAt: ago(899) }, NOW, STALE_AFTER);
    expect(reading.status).toBe("fresh");
  });

  it("is fresh exactly AT the threshold — stale means older than, not as old as", () => {
    const reading = resolveReading({ value: 50, takenAt: ago(900) }, NOW, STALE_AFTER);
    expect(reading.status).toBe("fresh");
    if (reading.status === "absent") throw new Error("expected a value");
    expect(reading.ageSeconds).toBe(900);
  });

  it("is stale one second past the threshold", () => {
    const reading = resolveReading({ value: 50, takenAt: ago(901) }, NOW, STALE_AFTER);
    expect(reading.status).toBe("stale");
  });

  it("moves with the threshold it is given, not with a baked-in constant", () => {
    // The same reading, two different thresholds, two different answers.
    // This is what fails if the threshold parameter is ever ignored in
    // favour of a hardcoded number.
    const raw = { value: 50, takenAt: ago(600) };

    expect(resolveReading(raw, NOW, 300).status).toBe("stale");
    expect(resolveReading(raw, NOW, 900).status).toBe("fresh");
  });

  it("moves with the clock, not only with the threshold", () => {
    // The same stored reading, read at two different moments. An
    // implementation measuring age from anything other than now would
    // answer identically here.
    const takenAt = ago(600);

    expect(resolveReading({ value: 50, takenAt }, NOW, STALE_AFTER).status).toBe("fresh");
    const muchLater = new Date(NOW.getTime() + 3600 * 1000);
    expect(resolveReading({ value: 50, takenAt }, muchLater, STALE_AFTER).status).toBe("stale");
  });
});

describe("resolveReading — a stale reading keeps its value", () => {
  it("carries the number and the age, so it can be shown as an as-of figure", () => {
    const reading = resolveReading({ value: 77, takenAt: ago(7200) }, NOW, STALE_AFTER);

    expect(reading.status).toBe("stale");
    if (reading.status === "absent") throw new Error("expected a value");
    // The whole reason stale is not collapsed into absent: the last known
    // figure and its age both survive.
    expect(reading.value).toBe(77);
    expect(reading.ageSeconds).toBe(7200);
  });
});

describe("resolveReading — absent", () => {
  it("is absent, never-reported, when there is no value", () => {
    const reading = resolveReading({ value: null, takenAt: ago(10) }, NOW, STALE_AFTER);
    expect(reading).toEqual({ status: "absent", reason: "never-reported" });
  });

  it("is absent, no-timestamp, when a value has no time beside it", () => {
    // Representable in the schema (both columns are independently
    // nullable) and untrustworthy: a value that cannot be aged cannot be
    // shown to be current, so it is refused rather than assumed.
    const reading = resolveReading({ value: 60, takenAt: null }, NOW, STALE_AFTER);
    expect(reading).toEqual({ status: "absent", reason: "no-timestamp" });
  });

  it("is absent when the timestamp is unparseable rather than missing", () => {
    const reading = resolveReading({ value: 60, takenAt: "not a date" }, NOW, STALE_AFTER);
    expect(reading).toEqual({ status: "absent", reason: "no-timestamp" });
  });

  it("is absent when the value is not a finite number", () => {
    const reading = resolveReading({ value: "banana", takenAt: ago(10) }, NOW, STALE_AFTER);
    expect(reading).toEqual({ status: "absent", reason: "never-reported" });
  });

  it("distinguishes its two reasons, which are different faults", () => {
    // never-reported means nothing is wired up (fix the configuration).
    // no-timestamp means a value arrived without its clock (fix the writer).
    const noValue = resolveReading({ value: null, takenAt: ago(10) }, NOW, STALE_AFTER);
    const noTime = resolveReading({ value: 5, takenAt: null }, NOW, STALE_AFTER);

    if (noValue.status !== "absent" || noTime.status !== "absent") {
      throw new Error("expected both absent");
    }
    expect(noValue.reason).not.toBe(noTime.reason);
  });
});

describe("resolveReading — a reading from the future", () => {
  it("is fresh, and its age is floored at zero rather than going negative", () => {
    // Small clock skew between a machine and the server is ordinary. The
    // failure mode of refusing it is an account that looks unmeasured
    // because a laptop is a minute ahead.
    const future = new Date(NOW.getTime() + 60 * 1000);
    const reading = resolveReading({ value: 20, takenAt: future }, NOW, STALE_AFTER);

    expect(reading.status).toBe("fresh");
    if (reading.status === "absent") throw new Error("expected a value");
    expect(reading.ageSeconds).toBe(0);
  });
});

describe("actionableValue", () => {
  it("hands back the number for a fresh reading", () => {
    const reading = resolveReading({ value: 33, takenAt: ago(5) }, NOW, STALE_AFTER);
    expect(actionableValue(reading)).toBe(33);
  });

  it("refuses a stale reading even though it has a number", () => {
    // The point of the function: may I treat this as current — answers no.
    const reading = resolveReading({ value: 33, takenAt: ago(99999) }, NOW, STALE_AFTER);
    expect(reading.status).toBe("stale");
    expect(actionableValue(reading)).toBeNull();
  });

  it("refuses an absent reading", () => {
    const reading: UsageReading = { status: "absent", reason: "never-reported" };
    expect(actionableValue(reading)).toBeNull();
  });

  it("hands back zero rather than null for a genuine zero reading", () => {
    // A nothing-used-yet account reads 0, and 0 is falsy — an
    // implementation using a truthiness check would report it unusable.
    const reading = resolveReading({ value: 0, takenAt: ago(5) }, NOW, STALE_AFTER);
    expect(actionableValue(reading)).toBe(0);
  });
});
