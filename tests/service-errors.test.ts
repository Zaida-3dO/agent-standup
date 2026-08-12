// The error taxonomy. See docs/plans/SCHEMA.md §22.
//
// What is worth testing here is not that a constructor sets a field. It is
// the three properties adapters depend on: every refusal carries a code
// from a closed set, the comparable part of a refusal excludes message
// text, and nothing escapes the taxonomy as a bare Error.
import { describe, expect, it } from "vitest";
import {
  ConflictError,
  ForbiddenError,
  GuardRejectedError,
  InternalError,
  InvalidInputError,
  NotFoundError,
  NotImplementedError,
  SERVICE_ERROR_CODES,
  ServiceError,
  isServiceError,
  toServiceError,
} from "@/lib/service";

describe("the taxonomy is closed", () => {
  it("gives every subclass a code from the declared set", () => {
    const instances: ServiceError[] = [
      new InvalidInputError("bad"),
      new NotFoundError("gone"),
      new GuardRejectedError("rule.id", "no"),
      new ConflictError("taken"),
      new ForbiddenError("nope"),
      new NotImplementedError("later"),
      new InternalError(new Error("boom")),
    ];
    // Every subclass is represented, and every code is claimed by one —
    // so a code added to the union without a class, or a class added
    // without a code, is caught here rather than at the first adapter that
    // has to map it.
    expect(instances.map((e) => e.code).sort()).toEqual([...SERVICE_ERROR_CODES].sort());
    for (const instance of instances) {
      expect(isServiceError(instance)).toBe(true);
      expect(instance).toBeInstanceOf(Error);
    }
  });

  it("names each subclass after itself, so a log line identifies it", () => {
    expect(new NotFoundError("gone").name).toBe("NotFoundError");
    expect(new GuardRejectedError("r", "no").name).toBe("GuardRejectedError");
  });
});

describe("what conformance compares", () => {
  it("excludes message text from the comparable rejection", () => {
    // The claim §22 makes: two adapters may word a refusal differently and
    // still be conformant. That is only true if the compared value has no
    // message in it.
    const terse = new GuardRejectedError("items.max_depth", "Too deep.", {
      fields: ["parent_id"],
    });
    const verbose = new GuardRejectedError(
      "items.max_depth",
      "This item would sit 7 levels down, and the configured maximum is 6.",
      { fields: ["parent_id"] },
    );
    expect(terse.message).not.toBe(verbose.message);
    expect(terse.toRejection()).toEqual(verbose.toRejection());
  });

  it("distinguishes two refusals that differ in code or fields", () => {
    const base = new GuardRejectedError("r", "m", { fields: ["a"] });
    expect(base.toRejection()).not.toEqual(
      new GuardRejectedError("r", "m", { fields: ["b"] }).toRejection(),
    );
    expect(base.toRejection()).not.toEqual(
      new GuardRejectedError("other", "m", { fields: ["a"] }).toRejection(),
    );
    expect(base.toRejection()).not.toEqual(new ConflictError("m", { fields: ["a"] }).toRejection());
  });

  it("omits guard entirely for a refusal that is not a guard rejection", () => {
    // Not `guard: undefined` — a driver that serialises the rejection to
    // JSON drops an undefined key, so an adapter comparing a round-tripped
    // rejection against an in-process one would differ on nothing real.
    expect(Object.keys(new NotFoundError("gone").toRejection()).sort()).toEqual(["code", "fields"]);
    expect("guard" in new GuardRejectedError("r", "m").toRejection()).toBe(true);
  });

  it("requires a guard identifier on a guard rejection", () => {
    // §22's third assertion is computed from the identifier the service
    // returned. A guard rejection without one is a rejection that can
    // never satisfy the coverage check for its own rule.
    const rejected = new GuardRejectedError("hierarchy.child_actionable", "A child is live.");
    expect(rejected.guard).toBe("hierarchy.child_actionable");
    expect(rejected.toRejection().guard).toBe("hierarchy.child_actionable");
  });

  it("freezes the fields list so a handler cannot edit a refusal in flight", () => {
    const error = new GuardRejectedError("r", "m", { fields: ["a"] });
    expect(() => (error.fields as string[]).push("b")).toThrow();
    expect(error.fields).toEqual(["a"]);
  });

  it("copies the fields it was given rather than aliasing the caller's array", () => {
    const fields = ["a"];
    const error = new InvalidInputError("bad", { fields });
    fields.push("b");
    // Aliasing would let a caller mutate a refusal after throwing it.
    expect(error.fields).toEqual(["a"]);
  });
});

describe("nothing escapes the taxonomy", () => {
  it("wraps a foreign throw as internal and keeps the original as cause", () => {
    const original = new Error('column "foo" does not exist');
    const wrapped = toServiceError(original);
    expect(wrapped.code).toBe("internal");
    expect(wrapped.message).not.toContain("does not exist");
    expect(wrapped.cause).toBe(original);
  });

  it("wraps a non-Error throw too", () => {
    // A thrown string has no `.message` to read, so a wrapper that assumed
    // Error would itself throw while handling an error.
    expect(toServiceError("just a string").code).toBe("internal");
    expect(toServiceError(undefined).code).toBe("internal");
    expect(toServiceError({ weird: true }).cause).toEqual({ weird: true });
  });

  it("returns a service error unchanged rather than wrapping it twice", () => {
    const refusal = new ConflictError("held by another session");
    expect(toServiceError(refusal)).toBe(refusal);
  });

  it("rejects a foreign value as not one of ours", () => {
    expect(isServiceError(new Error("plain"))).toBe(false);
    expect(isServiceError({ code: "not_found", message: "looks like one" })).toBe(false);
    expect(isServiceError(null)).toBe(false);
  });
});
