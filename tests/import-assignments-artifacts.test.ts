// Importer — assignments and artifacts (MILESTONES.md #12, SCHEMA.md §2, §6).
// Real Postgres only, per CLAUDE.md's testing tenet. Mirrors
// tests/import-items.test.ts and tests/claims.test.ts for scratch-database
// setup. Skips without TEST_DATABASE_URL.
import type { PrismaClient } from "@prisma/client";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { FINDING_SEVERITIES, InvalidFindingError, parseFindings } from "@/lib/findings";
import { createTestPrismaClient } from "./helpers/test-prisma-client";
import {
  applySeverityAliases,
  UnknownSeverityError,
  importAssignments,
  importArtifacts,
  importAssignmentsAndArtifacts,
  mapSourceRole,
  mapSourceArtifactKind,
  mapSourceVerdict,
  VERDICTS,
  UnknownSourceRoleError,
  UnknownArtifactKindError,
  UnknownVerdictError,
  UnresolvedTaskError,
  type SourceClaim,
  type SourceReview,
  type SourceTaskAssignmentsArtifacts,
} from "@/lib/import-assignments-artifacts";
import {
  createMigratedScratchDatabase,
  dropScratchDatabase,
  scratchDatabaseName,
} from "./helpers/scratch-db";

// ---------------------------------------------------------------------------
// Pure units — no database needed.
// ---------------------------------------------------------------------------

describe("mapSourceRole", () => {
  it("rewrites the one value the two vocabularies disagree on", () => {
    // The source spells this role with a hyphen; the DB enum uses an
    // underscore. Changing ROLE_REMAP's "visual-reviewer" entry to anything
    // other than "visual_reviewer" flips this assertion.
    expect(mapSourceRole("visual-reviewer", "t1")).toBe("visual_reviewer");
  });

  it("passes every other role through unchanged", () => {
    expect(mapSourceRole("orchestrator", "t1")).toBe("orchestrator");
    expect(mapSourceRole("builder", "t1")).toBe("builder");
    expect(mapSourceRole("reviewer", "t1")).toBe("reviewer");
    expect(mapSourceRole("scout", "t1")).toBe("scout");
    expect(mapSourceRole("custom", "t1")).toBe("custom");
  });

  it("rejects a role outside the source vocabulary rather than defaulting silently", () => {
    expect(() => mapSourceRole("team-lead", "t1")).toThrow(UnknownSourceRoleError);
  });
});

describe("mapSourceArtifactKind", () => {
  it("accepts every kind in the closed set", () => {
    for (const kind of [
      "plan",
      "plan_review",
      "code_review",
      "visual_review",
      "test_run",
      "commit",
      "screenshot",
      "other",
    ]) {
      expect(mapSourceArtifactKind(kind, "r1")).toBe(kind);
    }
  });

  it("rejects a kind outside the closed set", () => {
    expect(() => mapSourceArtifactKind("design_doc", "r1")).toThrow(UnknownArtifactKindError);
  });
});

describe("findings on an imported artifact", () => {
  it("refuses a malformed findings list rather than repairing it", () => {
    // parseFindings refuses per entry with the index named. A coercing
    // importer that dropped two bad entries out of fifty would produce a
    // list that looks complete and is not.
    expect(() => parseFindings([{ text: "" }])).toThrow(InvalidFindingError);
    expect(() => parseFindings([{ text: "ok", severity: "HIGH" }])).toThrow(InvalidFindingError);
    expect(() => parseFindings("not an array")).toThrow(InvalidFindingError);
  });

  it("keeps an ungraded finding ungraded — absent severity is not defaulted", () => {
    // "Ungraded" is a different claim from "graded low". Defaulting here
    // would put a level nobody chose into the field the column exists for.
    const [finding] = parseFindings([{ text: "noticed a thing" }]);
    expect(finding).toEqual({ text: "noticed a thing" });
    expect("severity" in finding!).toBe(false);
  });

  it("accepts the whole severity ladder, lowercase", () => {
    for (const severity of FINDING_SEVERITIES) {
      expect(parseFindings([{ text: "t", severity }])[0]!.severity).toBe(severity);
    }
  });
});

describe("applySeverityAliases", () => {
  it("translates a caller's spelling onto this application's ladder", () => {
    const out = applySeverityAliases([{ text: "t", severity: "HIGH" }], "r1", {
      HIGH: "high",
    }) as { severity: string }[];
    expect(out[0]!.severity).toBe("high");
  });

  it("REFUSES an unmapped severity rather than downgrading or dropping it", () => {
    // The whole reason the map exists. A case-folding or punctuation-
    // stripping transform would silently mangle a hedge like `low-medium`
    // into a level nobody chose; this refuses and says where.
    expect(() => applySeverityAliases([{ text: "t", severity: "low-medium" }], "r1")).toThrow(
      UnknownSeverityError,
    );
    expect(() => applySeverityAliases([{ text: "t", severity: "low-medium" }], "r1")).toThrow(
      /findings\[0\]/,
    );
    expect(() => applySeverityAliases([{ text: "t", severity: "HIGH" }], "r1")).toThrow(
      UnknownSeverityError,
    );
  });

  it("accepts a level already in this application's own spelling without an alias", () => {
    const out = applySeverityAliases([{ text: "t", severity: "high" }], "r1") as {
      severity: string;
    }[];
    expect(out[0]!.severity).toBe("high");
  });

  it("leaves an ungraded finding ungraded — absence is not a spelling to translate", () => {
    const out = applySeverityAliases([{ text: "t" }], "r1", { HIGH: "high" }) as object[];
    expect(out[0]).toEqual({ text: "t" });
    expect("severity" in out[0]!).toBe(false);
  });

  it("does not invent an alias target outside the ladder", () => {
    expect(() =>
      applySeverityAliases([{ text: "t", severity: "x" }], "r1", { x: "urgent" }),
    ).toThrow(UnknownSeverityError);
  });
});

describe("mapSourceVerdict", () => {
  it("accepts every verdict in the closed set", () => {
    expect(mapSourceVerdict("approved", "r1")).toBe("approved");
    expect(mapSourceVerdict("changes_required", "r1")).toBe("changes_required");
    expect(mapSourceVerdict("na", "r1")).toBe("na");
  });

  it("accepts the tiered verdicts", () => {
    // A review outcome is tiered: a plain pass, a pass with cosmetic notes,
    // and a pass with follow-up work are different answers.
    expect(mapSourceVerdict("lgtm", "r1")).toBe("lgtm");
    expect(mapSourceVerdict("lgtm_with_nits", "r1")).toBe("lgtm_with_nits");
    expect(mapSourceVerdict("lgtm_with_followups", "r1")).toBe("lgtm_with_followups");
  });

  it("keeps `approved` working as a synonym rather than dropping it", () => {
    // Removing an enum label in Postgres is a type rebuild, not an ALTER —
    // so every verdict already on record has to keep deciding identically.
    expect(mapSourceVerdict("approved", "r1")).toBe("approved");
    expect(VERDICTS.has("approved")).toBe(true);
  });

  it("maps a caller's own spelling through verdictAliases", () => {
    // The hyphenated spelling is a CALLER's, not this application's. It is
    // translated by a map the caller supplies, exactly like a repo or an
    // actor label — never by a table of somebody else's vocabulary here.
    expect(mapSourceVerdict("lgtm-with-nits", "r1", { "lgtm-with-nits": "lgtm_with_nits" })).toBe(
      "lgtm_with_nits",
    );
  });

  it("still REJECTS a verdict outside the set — widening is not a pass-through", () => {
    // The value of this check is precisely that it refuses what nobody
    // taught it. A version that simply returned the verdict unchecked would
    // pass the happy-path cases above and protect nothing.
    expect(() => mapSourceVerdict("pending", "r1")).toThrow(UnknownVerdictError);
    expect(() => mapSourceVerdict("lgtm-with-nits", "r1")).toThrow(UnknownVerdictError);
    expect(() => mapSourceVerdict("LGTM", "r1")).toThrow(UnknownVerdictError);
  });

  it("REJECTS an alias whose target is not one of this application's verdicts", () => {
    // A hyphen-to-underscore transform would happily accept this and fail
    // deep inside an insert instead.
    expect(() => mapSourceVerdict("odd", "r1", { odd: "not_a_verdict" })).toThrow(
      UnknownVerdictError,
    );
  });
});

// ---------------------------------------------------------------------------
// Against a real Postgres.
// ---------------------------------------------------------------------------

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const describeIfDb = testDatabaseUrl ? describe : describe.skip;

describeIfDb("importAssignments / importArtifacts — against a real Postgres", () => {
  const dbName = scratchDatabaseName("import_aa");
  let scratchUrl: string;
  let prisma: PrismaClient;

  beforeAll(async () => {
    scratchUrl = (await createMigratedScratchDatabase(testDatabaseUrl!, dbName)).url;
    prisma = createTestPrismaClient(scratchUrl);
    await prisma.area.create({ data: { id: "test-area", displayName: "Test area" } });
  }, 30_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await dropScratchDatabase(testDatabaseUrl!, dbName);
  });

  afterEach(async () => {
    await prisma.artifact.deleteMany({});
    await prisma.event.deleteMany({});
    await prisma.assignment.deleteMany({});
    await prisma.item.deleteMany({});
  });

  /** Seeds an `items` row the way #10's importer would have — legacy_id and all. */
  async function seedImportedItem(legacyId: string, itemId = `item-${legacyId}`): Promise<string> {
    await prisma.item.create({
      data: {
        id: itemId,
        kind: "task",
        title: "t",
        body: "b",
        state: "on_deck",
        originType: "source",
        area: "test-area",
        mergeAuthority: "needs_approval",
        customFields: { legacy_id: legacyId },
      },
    });
    return itemId;
  }

  function baseClaim(
    overrides: Partial<SourceClaim> & Pick<SourceClaim, "id" | "sessionId">,
  ): SourceClaim {
    return {
      role: "builder",
      holderType: "agent",
      holderId: "crew-member",
      machine: "laptop",
      claimedAt: "2026-08-01T10:00:00.000Z",
      releasedAt: "2026-08-01T12:00:00.000Z",
      ...overrides,
    };
  }

  function baseReview(overrides: Partial<SourceReview> & Pick<SourceReview, "id">): SourceReview {
    return {
      kind: "code_review",
      verdict: "approved",
      createdByType: "agent",
      createdById: "reviewer-crew",
      createdAt: "2026-08-01T13:00:00.000Z",
      ...overrides,
    };
  }

  // -- AC1: claims imported into assignments ------------------------------

  it("imports a claim into assignments, mapping role and preserving holder/session identity", async () => {
    await seedImportedItem("src-1");
    const task: SourceTaskAssignmentsArtifacts = {
      id: "src-1",
      claims: [
        baseClaim({
          id: "claim-1",
          sessionId: "session-a",
          role: "visual-reviewer",
          holderId: "agent-x",
        }),
      ],
    };

    const result = await importAssignments(prisma, [task]);
    expect(result).toEqual({ claimsImported: 1, claimsSkippedExisting: 0, claimsConflicted: 0 });

    const row = await prisma.assignment.findFirstOrThrow({ where: { sessionId: "session-a" } });
    // AC2: role mapped per SCHEMA — the hyphenated source spelling landed as
    // the underscored DB enum value.
    expect(row.role).toBe("visual_reviewer");
    expect(row.holderId).toBe("agent-x");
    expect(row.rootSessionId).toBe("session-a");
    expect(row.releasedAt).not.toBeNull();
  });

  it("a claim the source never marked released imports as still live", async () => {
    await seedImportedItem("src-live");
    const task: SourceTaskAssignmentsArtifacts = {
      id: "src-live",
      claims: [baseClaim({ id: "claim-1", sessionId: "session-live", releasedAt: null })],
    };

    await importAssignments(prisma, [task]);
    const row = await prisma.assignment.findFirstOrThrow({ where: { sessionId: "session-live" } });
    expect(row.releasedAt).toBeNull();
  });

  it("rejects a role outside the source vocabulary rather than importing it", async () => {
    await seedImportedItem("src-badrole");
    const task: SourceTaskAssignmentsArtifacts = {
      id: "src-badrole",
      claims: [baseClaim({ id: "claim-1", sessionId: "session-a", role: "team-lead" })],
    };

    await expect(importAssignments(prisma, [task])).rejects.toBeInstanceOf(UnknownSourceRoleError);
    expect(await prisma.assignment.count()).toBe(0);
  });

  it("throws UnresolvedTaskError when the task has claims but #10 never imported it", async () => {
    // No seedImportedItem call — "src-missing" has no items row.
    const task: SourceTaskAssignmentsArtifacts = {
      id: "src-missing",
      claims: [baseClaim({ id: "claim-1", sessionId: "session-a" })],
    };

    await expect(importAssignments(prisma, [task])).rejects.toBeInstanceOf(UnresolvedTaskError);
  });

  it("a task with an empty claims array is left untouched", async () => {
    await seedImportedItem("src-empty");
    const task: SourceTaskAssignmentsArtifacts = { id: "src-empty", claims: [] };

    const result = await importAssignments(prisma, [task]);
    expect(result).toEqual({ claimsImported: 0, claimsSkippedExisting: 0, claimsConflicted: 0 });
  });

  // -- AC4: the two partial unique indexes are respected, deliberately ----

  it("a second LIVE orchestrator claim on the same item is refused, not silently imported, and counted", async () => {
    const itemId = await seedImportedItem("src-orch");
    const task: SourceTaskAssignmentsArtifacts = {
      id: "src-orch",
      claims: [
        baseClaim({
          id: "claim-1",
          sessionId: "s1",
          role: "orchestrator",
          claimedAt: "2026-08-01T09:00:00.000Z",
          releasedAt: null, // still live
        }),
        baseClaim({
          id: "claim-2",
          sessionId: "s2",
          role: "orchestrator",
          rootSessionId: "s1",
          claimedAt: "2026-08-01T10:00:00.000Z",
          releasedAt: null, // ALSO still live — violates one-live-orchestrator-per-item
        }),
      ],
    };

    const result = await importAssignments(prisma, [task]);
    // Deliberate, not opaque: the transaction survives (see the untargeted
    // ON CONFLICT DO NOTHING in the source) and the loss is a counted
    // outcome, not a crash.
    expect(result.claimsImported).toBe(1);
    expect(result.claimsConflicted).toBe(1);

    // The index actually held: only one live orchestrator row landed.
    const rows = await prisma.assignment.findMany({ where: { itemId, releasedAt: null } });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.sessionId).toBe("s1");
  });

  it("a second LIVE row for the same session on the same item is refused and counted", async () => {
    const itemId = await seedImportedItem("src-session-dup");
    const task: SourceTaskAssignmentsArtifacts = {
      id: "src-session-dup",
      claims: [
        baseClaim({
          id: "claim-1",
          sessionId: "s1",
          role: "builder",
          claimedAt: "2026-08-01T09:00:00.000Z",
          releasedAt: null,
        }),
        baseClaim({
          id: "claim-2",
          sessionId: "s1", // same session, same item, both still live
          role: "reviewer",
          claimedAt: "2026-08-01T09:05:00.000Z",
          releasedAt: null,
        }),
      ],
    };

    const result = await importAssignments(prisma, [task]);
    expect(result.claimsImported).toBe(1);
    expect(result.claimsConflicted).toBe(1);

    const rows = await prisma.assignment.findMany({ where: { itemId, releasedAt: null } });
    expect(rows).toHaveLength(1);
  });

  it("two RELEASED orchestrator claims on the same item both import — the WHERE clause earning its place", async () => {
    // Mirrors claims.test.ts's "a RELEASED orchestrator does not block a new
    // one": a released row must not collide with a later one on the partial
    // index, because previous_sessions are kept, not deleted (§2).
    const itemId = await seedImportedItem("src-both-released");
    const task: SourceTaskAssignmentsArtifacts = {
      id: "src-both-released",
      claims: [
        baseClaim({
          id: "claim-1",
          sessionId: "s1",
          role: "orchestrator",
          claimedAt: "2026-08-01T09:00:00.000Z",
          releasedAt: "2026-08-01T09:30:00.000Z",
        }),
        baseClaim({
          id: "claim-2",
          sessionId: "s2",
          role: "orchestrator",
          claimedAt: "2026-08-01T10:00:00.000Z",
          releasedAt: "2026-08-01T10:30:00.000Z",
        }),
      ],
    };

    const result = await importAssignments(prisma, [task]);
    expect(result).toEqual({ claimsImported: 2, claimsSkippedExisting: 0, claimsConflicted: 0 });
    expect(await prisma.assignment.count({ where: { itemId } })).toBe(2);
  });

  it("an orchestrator and a builder from the same item both import as LIVE — the index is scoped to role", async () => {
    // Negative control for the orchestrator case above: the index only
    // fires on role = 'orchestrator', so a live orchestrator plus a live
    // builder on the same item must NOT conflict.
    const itemId = await seedImportedItem("src-crew");
    const task: SourceTaskAssignmentsArtifacts = {
      id: "src-crew",
      claims: [
        baseClaim({
          id: "claim-1",
          sessionId: "s1",
          role: "orchestrator",
          claimedAt: "2026-08-01T09:00:00.000Z",
          releasedAt: null,
        }),
        baseClaim({
          id: "claim-2",
          sessionId: "s2",
          role: "builder",
          rootSessionId: "s1",
          claimedAt: "2026-08-01T09:05:00.000Z",
          releasedAt: null,
        }),
      ],
    };

    const result = await importAssignments(prisma, [task]);
    expect(result).toEqual({ claimsImported: 2, claimsSkippedExisting: 0, claimsConflicted: 0 });
    expect(await prisma.assignment.count({ where: { itemId, releasedAt: null } })).toBe(2);
  });

  it("preserves an EXPLICIT rootSessionId rather than always defaulting it to the claim's own session", async () => {
    // Distinct from "imports a claim..." above, which only exercises the
    // OMITTED case (root defaults to self) and so cannot tell a real
    // pass-through apart from a hardcoded default. This is the builder half
    // of a two-member crew: its rootSessionId must read back as the
    // orchestrator's session, not its own.
    await seedImportedItem("src-root-explicit");
    const task: SourceTaskAssignmentsArtifacts = {
      id: "src-root-explicit",
      claims: [
        baseClaim({
          id: "claim-1",
          sessionId: "builder-session",
          rootSessionId: "orchestrator-session",
        }),
      ],
    };

    await importAssignments(prisma, [task]);
    const row = await prisma.assignment.findFirstOrThrow({
      where: { sessionId: "builder-session" },
    });
    expect(row.rootSessionId).toBe("orchestrator-session");
    expect(row.rootSessionId).not.toBe("builder-session");
  });

  // -- AC5: re-runnable without duplicating rows --------------------------

  it("is idempotent: importing the SAME claim twice against the same populated database does not duplicate rows", async () => {
    const itemId = await seedImportedItem("src-idempotent");
    const task: SourceTaskAssignmentsArtifacts = {
      id: "src-idempotent",
      claims: [baseClaim({ id: "claim-1", sessionId: "session-a" })],
    };

    const first = await importAssignments(prisma, [task]);
    expect(first).toEqual({ claimsImported: 1, claimsSkippedExisting: 0, claimsConflicted: 0 });

    const second = await importAssignments(prisma, [task]);
    expect(second).toEqual({ claimsImported: 0, claimsSkippedExisting: 1, claimsConflicted: 0 });

    expect(await prisma.assignment.count({ where: { itemId } })).toBe(1);
  });

  // -- AC3: review files imported into artifacts ---------------------------

  it("imports a review into artifacts, preserving kind/verdict/round/commit", async () => {
    const itemId = await seedImportedItem("src-review");
    const task: SourceTaskAssignmentsArtifacts = {
      id: "src-review",
      reviews: [
        baseReview({
          id: "review-1",
          kind: "code_review",
          verdict: "approved",
          reviewRound: 2,
          commitSha: "abc123",
          body: "Looks good.",
        }),
      ],
    };

    const result = await importArtifacts(prisma, [task]);
    expect(result).toEqual({
      reviewsImported: 1,
      reviewsSkippedExisting: 0,
      findingsIn: 0,
      findingsWritten: 0,
      findingsOnSkippedArtifacts: 0,
      findingsWithoutSeverity: 0,
    });

    const row = await prisma.artifact.findFirstOrThrow({ where: { itemId } });
    expect(row.kind).toBe("code_review");
    expect(row.verdict).toBe("approved");
    expect(row.reviewRound).toBe(2);
    expect(row.commitSha).toBe("abc123");
    expect(row.body).toBe("Looks good.");
  });

  it("a plan artifact with no verdict imports with a null verdict", async () => {
    await seedImportedItem("src-plan");
    const task: SourceTaskAssignmentsArtifacts = {
      id: "src-plan",
      reviews: [baseReview({ id: "review-1", kind: "plan", verdict: null })],
    };

    await importArtifacts(prisma, [task]);
    const row = await prisma.artifact.findFirstOrThrow({});
    expect(row.verdict).toBeNull();
  });

  it("rejects an artifact kind outside the closed set", async () => {
    await seedImportedItem("src-badkind");
    const task: SourceTaskAssignmentsArtifacts = {
      id: "src-badkind",
      reviews: [baseReview({ id: "review-1", kind: "design_doc" })],
    };

    await expect(importArtifacts(prisma, [task])).rejects.toBeInstanceOf(UnknownArtifactKindError);
    expect(await prisma.artifact.count()).toBe(0);
  });

  it("throws UnresolvedTaskError when the task has reviews but #10 never imported it", async () => {
    const task: SourceTaskAssignmentsArtifacts = {
      id: "src-review-missing",
      reviews: [baseReview({ id: "review-1" })],
    };

    await expect(importArtifacts(prisma, [task])).rejects.toBeInstanceOf(UnresolvedTaskError);
  });

  it("is idempotent: importing the SAME review twice against the same populated database does not duplicate rows", async () => {
    const itemId = await seedImportedItem("src-review-idempotent");
    const task: SourceTaskAssignmentsArtifacts = {
      id: "src-review-idempotent",
      reviews: [baseReview({ id: "review-1" })],
    };

    const first = await importArtifacts(prisma, [task]);
    expect(first).toEqual({
      reviewsImported: 1,
      reviewsSkippedExisting: 0,
      findingsIn: 0,
      findingsWritten: 0,
      findingsOnSkippedArtifacts: 0,
      findingsWithoutSeverity: 0,
    });

    const second = await importArtifacts(prisma, [task]);
    expect(second).toEqual({
      reviewsImported: 0,
      reviewsSkippedExisting: 1,
      findingsIn: 0,
      findingsWritten: 0,
      findingsOnSkippedArtifacts: 0,
      findingsWithoutSeverity: 0,
    });

    expect(await prisma.artifact.count({ where: { itemId } })).toBe(1);
  });

  // -- combined entry point, and AC5 end to end ----------------------------

  it("importAssignmentsAndArtifacts runs both imports and is idempotent as a whole, twice against the same DB", async () => {
    const itemId = await seedImportedItem("src-combined");
    const task: SourceTaskAssignmentsArtifacts = {
      id: "src-combined",
      claims: [baseClaim({ id: "claim-1", sessionId: "session-a" })],
      reviews: [baseReview({ id: "review-1" })],
    };

    const first = await importAssignmentsAndArtifacts(prisma, [task]);
    expect(first).toEqual({
      claimsImported: 1,
      claimsSkippedExisting: 0,
      claimsConflicted: 0,
      reviewsImported: 1,
      reviewsSkippedExisting: 0,
      findingsIn: 0,
      findingsWritten: 0,
      findingsOnSkippedArtifacts: 0,
      findingsWithoutSeverity: 0,
    });

    const second = await importAssignmentsAndArtifacts(prisma, [task]);
    expect(second).toEqual({
      claimsImported: 0,
      claimsSkippedExisting: 1,
      claimsConflicted: 0,
      reviewsImported: 0,
      reviewsSkippedExisting: 1,
      findingsIn: 0,
      findingsWritten: 0,
      findingsOnSkippedArtifacts: 0,
      findingsWithoutSeverity: 0,
    });

    expect(await prisma.assignment.count({ where: { itemId } })).toBe(1);
    expect(await prisma.artifact.count({ where: { itemId } })).toBe(1);
  });
});
