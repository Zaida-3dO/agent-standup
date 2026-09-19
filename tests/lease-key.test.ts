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
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
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
    expect(() => encodeLeaseKey(identity({ holderId: "a\u001fb" }))).toThrow(LeaseKeyError);
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
        ["root-session-1", "worker-session-2", "agent", "somebody-else"].join("\u001f"),
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
// The migration's backfill computes this same key in SQL. Two implementations
// of one encoding is exactly the arrangement that drifts, so the
// correspondence is asserted rather than trusted.
// ---------------------------------------------------------------------------

describe("the migration backfill agrees with the encoder", () => {
  const migration = readFileSync(
    new URL(
      "../prisma/migrations/20260919090000_assignment_lease_key/migration.sql",
      import.meta.url,
    ),
    "utf8",
  );

  /**
   * The migration with its comments stripped.
   *
   * Every assertion below reads THIS rather than the raw file. The
   * distinction is not pedantry: this migration's comments quote the SQL
   * they explain, so a `toContain` against the raw text passes on the
   * strength of a comment even after the statement it describes has been
   * deleted. Verified by mutation — removing the real `WHERE` clause left
   * the raw-text version of this suite entirely green.
   */
  const statements = migration
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n");

  /**
   * The backfill's SQL expression, reimplemented in JavaScript.
   *
   * This is NOT a second copy of the encoder — it is a transcription of
   * what Postgres does with the SQL in the migration file, step for step:
   * `convert_to(..., 'UTF8')`, `encode(..., 'base64')`, `replace` to strip
   * MIME line wrapping, `translate('+/', '-_')`, `rtrim('=')`, and
   * `substr(encode(sha256(...), 'hex'), 1, 8)`. If the two agree on values
   * that exercise every one of those steps, the SQL and the encoder produce
   * the same string.
   */
  /**
   * The separator and the `translate` mapping are READ OUT OF THE SQL
   * rather than restated here, so this transcription follows the migration
   * instead of merely agreeing with it once.
   *
   * That is what makes these assertions able to fail: with the arguments
   * hardcoded, changing `translate('+/', '-_')` to anything else left this
   * suite green, because the transcription went on doing what the SQL used
   * to do. Both were checked by mutation.
   */
  const separatorCode = Number(/chr\((\d+)\)/.exec(statements)?.[1]);
  // The two single-quoted arguments that CLOSE the `translate(...)` call —
  // matched from its closing paren backwards, because `translate`'s first
  // argument is the whole nested `replace(encode(...))` expression and a
  // forward match would capture that inner call's quotes instead. Getting
  // this wrong is not silent: the transcription then drops characters and
  // the comparison below fails loudly, which is how it was caught.
  const translateArgs = /'([^']*)',\s*'([^']*)'\s*\)\s*,\s*\n\s*'='/.exec(statements);

  function asTheMigrationComputesIt(id: LeaseIdentity): string {
    const payload = [id.rootSessionId, id.sessionId, id.holderType, id.holderId].join(
      String.fromCharCode(separatorCode),
    );
    const bytes = Buffer.from(payload, "utf8");

    const [, from = "", to = ""] = translateArgs ?? [];
    let body = bytes.toString("base64").replace(/\n/g, "");
    body = [...body]
      .map((char) => {
        const at = from.indexOf(char);
        return at === -1 ? char : (to[at] ?? "");
      })
      .join("");
    body = body.replace(/=+$/, "");

    return `lk1.${body}.${createHash("sha256").update(bytes).digest("hex").slice(0, 8)}`;
  }

  it.each([
    ["a realistic uuid-and-slug claim", identity()],
    [
      "single characters, which pad hardest in base64",
      identity({ rootSessionId: "a", sessionId: "b", holderType: "person", holderId: "c" }),
    ],
    [
      "values long enough that Postgres would wrap base64 output",
      identity({
        rootSessionId: "r".repeat(80),
        sessionId: "s".repeat(80),
        holderId: "h".repeat(80),
      }),
    ],
    [
      "multibyte text, where convert_to and Buffer must agree",
      identity({ rootSessionId: "café-root", sessionId: "sesión-2", holderId: "holder-ü" }),
    ],
  ])("matches on %s", (_label, id) => {
    expect(asTheMigrationComputesIt(id)).toBe(encodeLeaseKey(id));
  });

  it("translates standard base64 into base64url, rather than some other mapping", () => {
    // The correspondence test above cannot catch a wrong `translate`: the
    // transcription reads its arguments out of the SQL, so it follows the
    // migration into being wrong and the two still agree. Confirmed by
    // mutation — changing `translate('+/', '-_')` to `translate('', '')`
    // left every `matches on ...` case green.
    //
    // So the MAPPING ITSELF is asserted here, against the only values that
    // make the output base64url and therefore decodable by
    // `decodeLeaseKey`. This is a property of the answer, not a restatement
    // of the question.
    expect(translateArgs).not.toBeNull();
    const [, from, to] = translateArgs ?? [];
    expect(from).toBe("+/");
    expect(to).toBe("-_");
  });

  it("uses chr(31) and never chr(0), which Postgres refuses inside text", () => {
    // The mistake this catches cost a CI round: `chr(0)` raises `null
    // character not permitted` rather than concatenating, so the whole
    // backfill statement fails and the migration cannot apply at all.
    // Asserting against the migration's own text means a later edit that
    // reaches for the intuitive separator fails here instead of in CI.
    expect(statements).toContain("chr(31)");
    expect(statements).not.toContain("chr(0)");
  });

  it("guards its backfill so a re-run rewrites nothing", () => {
    expect(statements).toContain('WHERE "leaseKey" IS NULL');
  });

  it("adds the column without a NOT NULL constraint that would need a default", () => {
    expect(statements).toContain('ALTER TABLE "Assignment" ADD COLUMN "leaseKey" TEXT;');
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
