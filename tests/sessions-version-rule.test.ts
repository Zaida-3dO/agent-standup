// The version rule and the transport vocabulary (SCHEMA.md §21), as pure
// values — no database, no process, no server.
//
// **The rejections are the point of this file.** A version comparison that
// never refuses passes a happy-path suite and protects nothing: it would be
// indistinguishable from `mayClaim: true` returned unconditionally, which is
// exactly what the row exists to stop. So the boundaries are tested from
// both sides — `minSupported - 1` refuses and `minSupported` does not,
// `current - 1` nudges and `current` does not — and every refusal is
// asserted for the two things a caller acts on: `mayClaim` and the verdict.

import { describe, expect, it } from "vitest";
import {
  SESSION_TRANSPORTS,
  assessVersion,
  isSessionTransport,
  resolveVariant,
  transportFromStored,
  transportToStored,
  variantForTransport,
  type SessionTransport,
} from "@/lib/sessions";
import { HOOK_PROTOCOL, HOOK_VARIANTS } from "@/lib/build-constants";

/**
 * A build with room on both sides of every boundary, so the four verdicts
 * are all reachable.
 *
 * The real `HOOK_PROTOCOL` is `{ current: 1, minSupported: 1 }` for both
 * variants, which leaves the advisory band empty — there is no integer
 * strictly between them — so a test that only drove the real constants could
 * not reach `advisory` at all and would silently cover three of the four
 * answers. Driving the comparison with an injected range is what makes the
 * fourth reachable, and the separate "against this build's own constants"
 * block below is what keeps the injected ranges from being the only thing
 * ever tested.
 */
const PROTOCOLS = {
  cli: { current: 7, minSupported: 4 },
  http: { current: 9, minSupported: 5 },
} as const;

describe("the five transports", () => {
  it("is exactly the five §21 names", () => {
    expect([...SESSION_TRANSPORTS]).toEqual([
      "cli-direct",
      "cli-http",
      "mcp-stdio",
      "mcp-http",
      "http",
    ]);
  });

  it("recognises each of them and nothing else", () => {
    for (const transport of SESSION_TRANSPORTS) {
      expect(isSessionTransport(transport)).toBe(true);
    }
    // `cli` was the name the command line stamped before the two bindings
    // were told apart; it is deliberately not one of the five, so a session
    // registering under it is refused rather than quietly recorded as one of
    // the two bindings it might have been.
    for (const notATransport of ["cli", "mcp", "grpc", "", "CLI-DIRECT", "cli_direct"]) {
      expect(isSessionTransport(notATransport)).toBe(false);
    }
    expect(isSessionTransport(undefined)).toBe(false);
    expect(isSessionTransport(7)).toBe(false);
  });

  it("round-trips every transport through its stored spelling", () => {
    for (const transport of SESSION_TRANSPORTS) {
      const stored = transportToStored(transport);
      expect(stored).not.toContain("-");
      expect(transportFromStored(stored)).toBe(transport);
    }
  });

  it("reads an unknown stored value as nothing rather than guessing", () => {
    expect(transportFromStored("smoke_signal")).toBeUndefined();
    expect(transportFromStored("")).toBeUndefined();
  });

  it("maps the two command-line bindings to the cli hook and everything else to http", () => {
    expect(variantForTransport("cli-direct")).toBe("cli");
    expect(variantForTransport("cli-http")).toBe("cli");
    expect(variantForTransport("mcp-stdio")).toBe("http");
    expect(variantForTransport("mcp-http")).toBe("http");
    expect(variantForTransport("http")).toBe("http");
  });

  it("gives every transport a variant this build knows", () => {
    for (const transport of SESSION_TRANSPORTS) {
      expect(HOOK_VARIANTS).toContain(variantForTransport(transport));
    }
  });
});

describe("the variant override", () => {
  it("takes the transport's variant when the payload names none", () => {
    expect(resolveVariant("mcp-http", undefined)).toEqual({ variant: "http", overridden: false });
    expect(resolveVariant("cli-direct", undefined)).toEqual({ variant: "cli", overridden: false });
  });

  it("honours an override and records it as one", () => {
    expect(resolveVariant("http", "cli")).toEqual({ variant: "cli", overridden: true });
    expect(resolveVariant("cli-direct", "http")).toEqual({ variant: "http", overridden: true });
  });

  it("does not call it an override when it names what the transport gives anyway", () => {
    // Recording this as an override would make "this session's variant was
    // overridden" mean "the caller mentioned it", which is not a fact anyone
    // can act on.
    expect(resolveVariant("cli-http", "cli")).toEqual({ variant: "cli", overridden: false });
    expect(resolveVariant("http", "http")).toEqual({ variant: "http", overridden: false });
  });

  it("ignores a variant this build does not have", () => {
    for (const junk of ["mcp", "", 3, null, {}]) {
      expect(resolveVariant("http", junk)).toEqual({ variant: "http", overridden: false });
    }
  });
});

describe("the version comparison", () => {
  for (const variant of HOOK_VARIANTS) {
    const range = PROTOCOLS[variant];

    describe(`the ${variant} variant`, () => {
      it("says nothing at or above current", () => {
        for (const reported of [range.current, range.current + 1, range.current + 100]) {
          const assessment = assessVersion({
            variant,
            reportedVersion: reported,
            protocols: PROTOCOLS,
          });
          expect(assessment.verdict).toBe("current");
          expect(assessment.versionPermitsClaim).toBe(true);
        }
      });

      it("is advisory below current but at or above min_supported", () => {
        for (const reported of [range.minSupported, range.current - 1]) {
          const assessment = assessVersion({
            variant,
            reportedVersion: reported,
            protocols: PROTOCOLS,
          });
          expect(assessment.verdict).toBe("advisory");
          // The whole point of two numbers: an advisory does NOT block.
          expect(assessment.versionPermitsClaim).toBe(true);
          expect(assessment.message).toContain(String(range.current));
        }
      });

      it("REFUSES A CLAIM below min_supported", () => {
        for (const reported of [range.minSupported - 1, 0]) {
          const assessment = assessVersion({
            variant,
            reportedVersion: reported,
            protocols: PROTOCOLS,
          });
          expect(assessment.verdict).toBe("incompatible");
          expect(assessment.versionPermitsClaim).toBe(false);
          // The refusal names both the version it got and the one to move
          // to, so the reader can act rather than go looking.
          expect(assessment.message).toContain(String(reported));
          expect(assessment.message).toContain(String(range.current));
        }
      });

      it("puts the boundary exactly at min_supported, not one either side of it", () => {
        expect(
          assessVersion({
            variant,
            reportedVersion: range.minSupported,
            protocols: PROTOCOLS,
          }).versionPermitsClaim,
        ).toBe(true);
        expect(
          assessVersion({
            variant,
            reportedVersion: range.minSupported - 1,
            protocols: PROTOCOLS,
          }).versionPermitsClaim,
        ).toBe(false);
      });

      it("reports the range it compared against, so a caller need not re-derive it", () => {
        const assessment = assessVersion({
          variant,
          reportedVersion: range.current,
          protocols: PROTOCOLS,
        });
        expect(assessment.variant).toBe(variant);
        expect(assessment.protocol).toEqual(range);
      });
    });
  }

  it("compares each variant against its OWN range, not the other's", () => {
    // `cli` accepts 4 and up; `http` accepts 5 and up. Version 4 is
    // therefore fine for one and refused for the other — which is the whole
    // reason the two are versioned independently, and the assertion that
    // would fail if the lookup used a fixed variant.
    expect(
      assessVersion({ variant: "cli", reportedVersion: 4, protocols: PROTOCOLS })
        .versionPermitsClaim,
    ).toBe(true);
    expect(
      assessVersion({ variant: "http", reportedVersion: 4, protocols: PROTOCOLS })
        .versionPermitsClaim,
    ).toBe(false);
  });

  it("REFUSES A CLAIM when the session never registered", () => {
    const assessment = assessVersion({ variant: undefined, reportedVersion: undefined });
    expect(assessment.verdict).toBe("unregistered");
    expect(assessment.versionPermitsClaim).toBe(false);
    // It has to say what to do instead, or the refusal is a wall — and it
    // has to say it in a spelling the reader can use. With no surface given
    // that means both, because this refusal is reached from every adapter
    // and naming only one is naming the wrong one to somebody
    // (MILESTONES.md #111). The per-surface wording is asserted in
    // `describe-tool.test.ts`.
    expect(assessment.message).toContain("register_session");
    expect(assessment.message).toContain("standup register session");
  });

  it("REFUSES A CLAIM when a registration named no version", () => {
    // Registered, variant known, but no version reported. The absence of a
    // claim is not a claim, and must not be read as a current one.
    for (const reported of [undefined, null]) {
      const assessment = assessVersion({ variant: "http", reportedVersion: reported });
      expect(assessment.verdict).toBe("unregistered");
      expect(assessment.versionPermitsClaim).toBe(false);
    }
  });

  it("REFUSES A CLAIM when a version is reported with no variant to compare it against", () => {
    const assessment = assessVersion({ variant: undefined, reportedVersion: 99 });
    expect(assessment.verdict).toBe("unregistered");
    expect(assessment.versionPermitsClaim).toBe(false);
  });
});

describe("against this build's own constants", () => {
  it("accepts a session running exactly what this build ships", () => {
    for (const variant of HOOK_VARIANTS) {
      const assessment = assessVersion({
        variant,
        reportedVersion: HOOK_PROTOCOL[variant].current,
      });
      expect(assessment.verdict).toBe("current");
      expect(assessment.versionPermitsClaim).toBe(true);
    }
  });

  it("refuses a session below this build's own minimum", () => {
    for (const variant of HOOK_VARIANTS) {
      const assessment = assessVersion({
        variant,
        reportedVersion: HOOK_PROTOCOL[variant].minSupported - 1,
      });
      expect(assessment.verdict).toBe("incompatible");
      expect(assessment.versionPermitsClaim).toBe(false);
    }
  });

  it("keeps min_supported at or below current for every variant", () => {
    // A build whose minimum exceeded what it speaks would refuse every
    // session including one running its own shipped hook — a state nothing
    // else in the system could detect, because every individual comparison
    // would be behaving correctly.
    for (const variant of HOOK_VARIANTS) {
      expect(HOOK_PROTOCOL[variant].minSupported).toBeLessThanOrEqual(
        HOOK_PROTOCOL[variant].current,
      );
    }
  });
});

describe("the type-level vocabulary", () => {
  it("has a stored spelling for every transport that Prisma can name", () => {
    // A Prisma enum member cannot contain a hyphen, so the stored spelling
    // must be a valid identifier. This is the assertion that fails if a
    // sixth transport is added on the wire without its stored counterpart.
    for (const transport of SESSION_TRANSPORTS satisfies readonly SessionTransport[]) {
      expect(transportToStored(transport)).toMatch(/^[a-z][a-z0-9_]*$/);
    }
  });
});
