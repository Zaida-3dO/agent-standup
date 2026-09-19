// The lease key: encoding, decoding, and the four ways a claim can state
// its identity (acceptance criterion 5).
//
// Everything here is a pure unit — no database — so it runs in every
// environment rather than skipping without `TEST_DATABASE_URL`. That is
// deliberate for this file specifically: the four-case matrix is the
// behaviour the change is *for*, and it should not be in the set of suites
// a run can silently skip. The database-backed consequences (that a claimed
// row carries the key, that the backfill derives the same string) belong to
// the DB-gated files and are asserted there.
import { describe, expect, it } from "vitest";

import {
  LEASE_KEY_PREFIX,
  LeaseKeyError,
  decodeLeaseKey,
  encodeLeaseKey,
  looksLikeLeaseKey,
  type LeaseIdentity,
} from "@/lib/lease-key";
import { LEASE_KEY_CONFLICT_GUARD, LEASE_KEY_GUARD, resolveLease } from "@/lib/lease-resolution";
import { GuardRejectedError } from "@/lib/service";

/** A complete identity, overridable per case. */
function identity(overrides: Partial<LeaseIdentity> = {}): LeaseIdentity {
  return {
    rootSessionId: "root-session-1",
    sessionId: "worker-session-2",
    holderType: "agent",
    holderId: "crewmate-7",
    ...overrides,
  };
}

describe("encodeLeaseKey / decodeLeaseKey", () => {
  it("round-trips every field", () => {
    const original = identity();
    expect(decodeLeaseKey(encodeLeaseKey(original))).toEqual(original);
  });

  it("round-trips multibyte and long values, which base64 wrapping would break", () => {
    // 80+ character fields push the payload past the 76-character line
    // length at which Postgres's `encode(..., 'base64')` inserts newlines.
    // The migration strips them; this asserts the Node side has nothing to
    // strip and still agrees, so the two producers cannot drift apart on
    // exactly the inputs that are hardest to eyeball.
    const original = identity({
      rootSessionId: "café-" + "r".repeat(80),
      sessionId: "sesión-" + "s".repeat(80),
      holderId: "hölder-" + "h".repeat(80),
    });
    const key = encodeLeaseKey(original);
    expect(key).not.toContain("\n");
    expect(decodeLeaseKey(key)).toEqual(original);
  });

  it("is a pure function — the same identity always gives the same key", () => {
    // This is the property the migration's backfill depends on for
    // re-runnability, so it is asserted rather than assumed.
    expect(encodeLeaseKey(identity())).toBe(encodeLeaseKey(identity()));
  });

  it("gives different keys to identities differing in any single field", () => {
    const base = encodeLeaseKey(identity());
    expect(encodeLeaseKey(identity({ rootSessionId: "other" }))).not.toBe(base);
    expect(encodeLeaseKey(identity({ sessionId: "other" }))).not.toBe(base);
    expect(encodeLeaseKey(identity({ holderType: "person" }))).not.toBe(base);
    expect(encodeLeaseKey(identity({ holderId: "other" }))).not.toBe(base);
  });

  it("does not confuse a field boundary shift", () => {
    // `a|bc` and `ab|c` must not collide. Without a separator that cannot
    // appear in a field, they would — this is what `FIELD_SEPARATOR` and
    // the encoder's rejection of it are protecting.
    const left = encodeLeaseKey(identity({ rootSessionId: "a", sessionId: "bc" }));
    const right = encodeLeaseKey(identity({ rootSessionId: "ab", sessionId: "c" }));
    expect(left).not.toBe(right);
  });

  it("refuses a field containing the separator rather than encoding it ambiguously", () => {
    expect(() => encodeLeaseKey(identity({ holderId: "a\u0000b" }))).toThrow(LeaseKeyError);
  });

  it("refuses a holder type outside the vocabulary", () => {
    expect(() =>
      encodeLeaseKey(identity({ holderType: "robot" as LeaseIdentity["holderType"] })),
    ).toThrow(LeaseKeyError);
  });

  describe("rejects a damaged key, saying which way it is damaged", () => {
    it("empty", () => {
      expect(() => decodeLeaseKey("   ")).toThrow(
        expect.objectContaining({ defect: "empty" }) as Error,
      );
    });

    it("not a lease key at all — the wrong-field paste", () => {
      // The single most likely mistake during dual-accept: a session id
      // pasted into `leaseKey`. It must be diagnosed as that rather than as
      // a base64 problem.
      expect(() => decodeLeaseKey("85a5b0b7-a198-48cc-b877-60681836a992")).toThrow(
        expect.objectContaining({ defect: "not_a_lease_key" }) as Error,
      );
    });

    it("truncated in the body, keeping its shape", () => {
      // A body that lost characters but still has three dot-separated
      // parts: the checksum is what catches this, and it is the case a
      // shape check alone would wave through.
      const [prefix, body, sum] = encodeLeaseKey(identity()).split(".") as [string, string, string];
      expect(() => decodeLeaseKey(`${prefix}.${body.slice(0, body.length - 6)}.${sum}`)).toThrow(
        expect.objectContaining({ defect: "checksum" }) as Error,
      );
    });

    it("truncated so hard it loses a part", () => {
      // Cutting the checksum off entirely leaves two parts, which is a
      // shape problem rather than a checksum one — and gets the sentence
      // about copying, not the one about alteration.
      const key = encodeLeaseKey(identity());
      expect(() => decodeLeaseKey(key.slice(0, key.length - 12))).toThrow(
        expect.objectContaining({ defect: "malformed" }) as Error,
      );
    });

    it("wrong number of parts", () => {
      expect(() => decodeLeaseKey(`${LEASE_KEY_PREFIX}.onlytwo`)).toThrow(
        expect.objectContaining({ defect: "malformed" }) as Error,
      );
    });

    it("a body altered under an unchanged checksum", () => {
      const [prefix, body, sum] = encodeLeaseKey(identity()).split(".") as [string, string, string];
      const tamperedBody = Buffer.from(
        ["root-session-1", "worker-session-2", "agent", "somebody-else"].join("\u0000"),
        "utf8",
      ).toString("base64url");
      expect(body).not.toBe(tamperedBody);
      expect(() => decodeLeaseKey(`${prefix}.${tamperedBody}.${sum}`)).toThrow(
        expect.objectContaining({ defect: "checksum" }) as Error,
      );
    });
  });

  it("looksLikeLeaseKey tells a key apart from a session id", () => {
    expect(looksLikeLeaseKey(encodeLeaseKey(identity()))).toBe(true);
    expect(looksLikeLeaseKey("85a5b0b7-a198-48cc-b877-60681836a992")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Acceptance criterion 5 — the four cases, one describe each.
// ---------------------------------------------------------------------------

describe("resolveLease — key present", () => {
  it("takes all four fields from the key and consults nothing else", () => {
    const resolved = resolveLease({ leaseKey: encodeLeaseKey(identity()) });
    expect(resolved.identity).toEqual(identity());
    expect(resolved.source).toBe("lease_key");
    expect(resolved.leaseKeyDeprecation).toBeNull();
  });

  it("reports the key's own root as stated, so the unknown-root warning still applies", () => {
    expect(resolveLease({ leaseKey: encodeLeaseKey(identity()) }).statedRootSessionId).toBe(
      "root-session-1",
    );
  });

  it("refuses a malformed key under the lease-key guard rather than falling back", () => {
    // The important half of this: a bad key must NOT quietly degrade to the
    // legacy default. That would reintroduce the exact silent
    // misattribution the change removes.
    try {
      resolveLease({ leaseKey: "lk1.garbage.0000" });
      expect.unreachable("a malformed key must be refused");
    } catch (error) {
      expect(error).toBeInstanceOf(GuardRejectedError);
      expect((error as GuardRejectedError).guard).toBe(LEASE_KEY_GUARD);
    }
  });
});

describe("resolveLease — key absent", () => {
  it("refuses when neither a key nor the legacy fields are supplied", () => {
    // Asserting the guard id AND the `absent` defect, not merely that
    // something threw. Removing the absent-check does not make this call
    // succeed — it makes it fail further down, in the encoder, with a
    // message about an empty field that tells the caller nothing about
    // what it actually failed to supply. A bare `toThrow` would pass
    // against that, which is the hollow version of this test.
    try {
      resolveLease({});
      expect.unreachable("a claim with no identity must be refused");
    } catch (error) {
      expect(error).toBeInstanceOf(GuardRejectedError);
      expect((error as GuardRejectedError).guard).toBe(LEASE_KEY_GUARD);
      expect((error as GuardRejectedError).details).toMatchObject({ defect: "absent" });
    }
  });

  it("names what to pass and where to get it", () => {
    // AC2 asks for both, so both are asserted. A refusal that names the
    // field without naming its source is the one a dispatched agent cannot
    // act on, which is the case this whole change is about.
    const message = (() => {
      try {
        resolveLease({});
        return "";
      } catch (error) {
        return (error as Error).message;
      }
    })();
    expect(message).toContain("leaseKey");
    expect(message).toContain("register");
    expect(message).toContain("dispatched");
  });

  it("refuses a half-stated legacy shape rather than guessing the rest", () => {
    // A `sessionId` on its own does not identify a claim: it says which
    // session, and nothing about which crew or which holder. Accepting it
    // would mean inventing the other three.
    try {
      resolveLease({ sessionId: "worker-session-2" });
      expect.unreachable("a partial legacy shape must be refused");
    } catch (error) {
      expect((error as GuardRejectedError).guard).toBe(LEASE_KEY_GUARD);
    }
  });
});

describe("resolveLease — old fields present", () => {
  it("still works, and says it is deprecated", () => {
    const resolved = resolveLease({
      sessionId: "worker-session-2",
      holderType: "agent",
      holderId: "crewmate-7",
      rootSessionId: "root-session-1",
    });
    expect(resolved.identity).toEqual(identity());
    expect(resolved.source).toBe("legacy");
    expect(resolved.leaseKeyDeprecation).toContain("leaseKey");
  });

  it("hands back the key that supersedes the fields it was given", () => {
    // A deprecation belongs in the response rather than in a document, and
    // is only actionable if the response carries the value
    // the caller is being told to switch to.
    const resolved = resolveLease({
      sessionId: "worker-session-2",
      holderType: "agent",
      holderId: "crewmate-7",
      rootSessionId: "root-session-1",
    });
    expect(decodeLeaseKey(resolved.leaseKey)).toEqual(identity());
  });

  it("defaults an omitted root to the caller's own session, and says so", () => {
    // Self-rooting is kept on this path deliberately, so an orchestrator
    // claiming for its own crew keeps working — and it is made audible,
    // because the same default is wrong for a dispatched agent.
    const resolved = resolveLease({
      sessionId: "worker-session-2",
      holderType: "agent",
      holderId: "crewmate-7",
    });
    expect(resolved.identity.rootSessionId).toBe("worker-session-2");
    expect(resolved.statedRootSessionId).toBeNull();
    expect(resolved.leaseKeyDeprecation).toContain("declares you the root of your own crew");
  });
});

describe("resolveLease — both present", () => {
  it("accepts them when they agree", () => {
    const resolved = resolveLease({
      leaseKey: encodeLeaseKey(identity()),
      sessionId: "worker-session-2",
      holderType: "agent",
      holderId: "crewmate-7",
      rootSessionId: "root-session-1",
    });
    expect(resolved.identity).toEqual(identity());
    expect(resolved.source).toBe("both");
  });

  it("accepts a key alongside legacy fields that omit the root", () => {
    // The key already answers the root, so an absent `rootSessionId` is not
    // a disagreement and must not be treated as one.
    const resolved = resolveLease({
      leaseKey: encodeLeaseKey(identity()),
      sessionId: "worker-session-2",
      holderType: "agent",
      holderId: "crewmate-7",
    });
    expect(resolved.source).toBe("both");
    expect(resolved.identity.rootSessionId).toBe("root-session-1");
  });

  it.each([
    ["sessionId", { sessionId: "someone-else" }],
    ["holderType", { holderType: "person" }],
    ["holderId", { holderId: "someone-else" }],
    ["rootSessionId", { rootSessionId: "another-crew" }],
  ])("refuses when %s disagrees with the key", (field, override) => {
    try {
      resolveLease({
        leaseKey: encodeLeaseKey(identity()),
        sessionId: "worker-session-2",
        holderType: "agent",
        holderId: "crewmate-7",
        rootSessionId: "root-session-1",
        ...override,
      });
      expect.unreachable(`a disagreeing ${field} must be refused`);
    } catch (error) {
      expect(error).toBeInstanceOf(GuardRejectedError);
      expect((error as GuardRejectedError).guard).toBe(LEASE_KEY_CONFLICT_GUARD);
      expect((error as Error).message).toContain(field);
    }
  });

  it("names every disagreeing field, not just the first", () => {
    // A caller migrating off the legacy shape usually has several stale
    // values at once; reporting them one round trip at a time would make
    // the migration the slowest possible version of itself.
    try {
      resolveLease({
        leaseKey: encodeLeaseKey(identity()),
        sessionId: "someone-else",
        holderType: "person",
        holderId: "also-wrong",
        rootSessionId: "another-crew",
      });
      expect.unreachable("disagreement must be refused");
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain("sessionId");
      expect(message).toContain("holderType");
      expect(message).toContain("holderId");
      expect(message).toContain("rootSessionId");
    }
  });
});
