// The error taxonomy. See docs/plans/SCHEMA.md §22.
//
// What is worth testing here is not that a constructor sets a field. It is
// the three properties adapters depend on: every refusal carries a code
// from a closed set, the comparable part of a refusal excludes message
// text, and nothing escapes the taxonomy as a bare Error.
import { describe, expect, it } from "vitest";
import {
  ConflictError,
  INTERNAL_KINDS,
  SERVICE_FAULTS,
  classifyCause,
  faultFor,
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

// ── The fault axis (MILESTONES.md #97) ──────────────────────────────────
//
// What these assert is not "the table has the values it has" — a test that
// restates a table is a test that changes whenever the table does and
// catches nothing. It is the two properties the table exists to give: the
// classification is TOTAL over the closed union, and it does not contradict
// the other table in this repository that already splits the same codes.
describe("the fault axis", () => {
  it("classifies every code in the closed set, into one of exactly two faults", () => {
    // The property that matters: totality. A code added to
    // `SERVICE_ERROR_CODES` without a `FAULT_BY_CODE` entry is a compile
    // error, and this is the runtime half of that same claim — it fails if
    // a lookup ever yields `undefined`.
    for (const code of SERVICE_ERROR_CODES) {
      expect(SERVICE_FAULTS).toContain(faultFor(code));
    }
    // Both arms are populated. A table that classified everything as one
    // fault would satisfy the loop above and be useless.
    const faults = new Set(SERVICE_ERROR_CODES.map(faultFor));
    expect([...faults].sort()).toEqual(["caller", "server"]);
  });

  it("agrees with the exit codes about which refusals a caller cannot fix", () => {
    // The regression this is really for. `EXIT_BY_CODE` (lib/cli/envelope)
    // already reasons about "nothing the caller typed would have worked"
    // and puts `internal` and `not_implemented` on EXIT.FAILURE. Two
    // tables encoding the same judgement will eventually be edited apart,
    // and the failure would be silent: a code whose exit status says
    // "unfixable" while its log line says "the caller's fault".
    const serverFaults = SERVICE_ERROR_CODES.filter((code) => faultFor(code) === "server");
    expect([...serverFaults].sort()).toEqual(["internal", "not_implemented"]);
  });

  it("reads the fault off an instance without it being a settable field", () => {
    expect(new NotFoundError("gone").fault).toBe("caller");
    expect(new GuardRejectedError("rule.id", "no").fault).toBe("caller");
    expect(new InternalError(new Error("boom")).fault).toBe("server");
    expect(new NotImplementedError("later").fault).toBe("server");
  });

  it("keeps the fault OFF the wire, because it is derivable from the code", () => {
    // The decision this pins: `toRejection()` is a wire format that the
    // CLI's http binding and the conformance drivers both rebuild by hand,
    // so a key added here has to be added at every one of those points or
    // two adapters disagree about an identical refusal. `fault` is a pure
    // function of `code`, which is already there.
    expect(Object.keys(new NotFoundError("gone").toRejection()).sort()).toEqual(["code", "fields"]);
    expect("fault" in new InternalError(new Error("boom")).toRejection()).toBe(false);
    expect("internalKind" in new InternalError(new Error("boom")).toRejection()).toBe(false);
  });
});

describe("the internal sub-bucket", () => {
  it("buckets an unreachable store apart from a refused write", () => {
    expect(classifyCause({ code: "P1001" })).toBe("database_unavailable");
    expect(classifyCause({ code: "P2002" })).toBe("constraint_violation");
  });

  it("treats a pool timeout as a timeout rather than a constraint", () => {
    // P2024 is in the query family by number and is a timeout by meaning.
    // Prefix order is what decides it, so this fails if the `P2` prefix
    // test is ever moved above the specific one.
    expect(classifyCause({ code: "P2024" })).toBe("timeout");
    expect(classifyCause({ code: "P1002" })).toBe("timeout");
  });

  it("never carries schema names out of the driver's metadata", () => {
    // The redaction claim, as an assertion rather than a comment. Prisma
    // puts constraint and column names in `meta.target`; the bucket is
    // derived from the code prefix and can only ever be one of four fixed
    // strings, so no schema text can travel inside one.
    const leaky = { code: "P2002", meta: { target: ["User_secret_email_key"] } };
    const kind = classifyCause(leaky);
    expect(kind).toBe("constraint_violation");
    expect(INTERNAL_KINDS).toContain(kind);
    expect(JSON.stringify(kind)).not.toContain("User_secret_email_key");
  });

  it("calls an unrecognised failure a bug rather than guessing a cause", () => {
    // The safe direction. An unknown driver code bucketing as `unexpected`
    // costs a reader a glance at the `cause` logged beside it; claiming a
    // specific cause the code does not support would mislead them.
    expect(classifyCause(new TypeError("undefined is not a function"))).toBe("unexpected");
    expect(classifyCause("just a string")).toBe("unexpected");
    expect(classifyCause(undefined)).toBe("unexpected");
    expect(classifyCause(null)).toBe("unexpected");
    expect(classifyCause({ code: 42 })).toBe("unexpected");
  });

  it("computes the bucket once, for anything the boundary wrapped", () => {
    // The overwhelming majority of internals are not constructed
    // deliberately — they are whatever a driver threw, wrapped by
    // `toServiceError`. Those must be bucketed on the same rule.
    const wrapped = toServiceError({ code: "P1001", message: "unreachable" });
    expect(wrapped.code).toBe("internal");
    expect((wrapped as InternalError).internalKind).toBe("database_unavailable");
  });
});
