// The backfill runner: option resolution, repo/actor resolution, and the
// end-to-end sequence with its verification pass against a real Postgres.
//
// The database half skips without TEST_DATABASE_URL, mirroring
// tests/import-items.test.ts. Every fixture is invented — this repository is
// public (CLAUDE.md).
import { PrismaClient } from "@prisma/client";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { runMigrations } from "../scripts/lib/run-migrations.mjs";
import { importItems, UnknownRepoAliasError } from "@/lib/import-items";
import { VerdictNotStorableError } from "@/lib/import-assignments-artifacts";
import type { BackfillPayload } from "@/lib/backfill/contract";
import {
  actorsIn,
  deriveActorAliases,
  formatRunReport,
  MissingRunnerOptionError,
  normalizeRepoKey,
  parsePayload,
  repoLabelsIn,
  resolveRunnerOptions,
  runBackfill,
  runBackfillTwice,
  DanglingRepoAliasError,
  UnknownRunnerFlagError,
} from "@/lib/backfill/runner";
import {
  createScratchDatabase,
  dropScratchDatabase,
  scratchDatabaseName,
} from "./helpers/scratch-db";

const TASK_A = "T-19700101-example-one";
const TASK_B = "T-19700102-example-two";

// ---------------------------------------------------------------------------
// Option resolution — pure, no database
// ---------------------------------------------------------------------------

describe("resolveRunnerOptions", () => {
  const env = { BACKFILL_PAYLOAD: "/from/env.json", DATABASE_URL: "postgresql://env/db" };

  it("reads the payload file and database URL from the environment", () => {
    const options = resolveRunnerOptions([], env);
    expect(options.payloadFile).toBe("/from/env.json");
    expect(options.databaseUrl).toBe("postgresql://env/db");
  });

  it("lets an explicit flag win over the environment", () => {
    expect(resolveRunnerOptions(["--payload", "/flag.json"], env).payloadFile).toBe("/flag.json");
  });

  it("REFUSES to run with no payload file rather than defaulting to one", () => {
    // A built-in default path is the failure this refusal exists to
    // prevent: it makes the tool work on exactly one machine.
    expect(() => resolveRunnerOptions([], { DATABASE_URL: "postgresql://env/db" })).toThrow(
      MissingRunnerOptionError,
    );
  });

  it("REFUSES to run with no database URL rather than defaulting to one", () => {
    expect(() => resolveRunnerOptions([], { BACKFILL_PAYLOAD: "/x.json" })).toThrow(
      MissingRunnerOptionError,
    );
  });

  it("REFUSES an unrecognised flag instead of ignoring it", () => {
    expect(() => resolveRunnerOptions(["--dry-run"], env)).toThrow(UnknownRunnerFlagError);
  });

  it("REFUSES a flag whose value is missing", () => {
    expect(() => resolveRunnerOptions(["--payload"], env)).toThrow(UnknownRunnerFlagError);
  });

  it("derives actors by default and stops when asked to be strict", () => {
    expect(resolveRunnerOptions([], env).deriveActors).toBe(true);
    expect(resolveRunnerOptions(["--strict-actors"], env).deriveActors).toBe(false);
    expect(resolveRunnerOptions([], { ...env, BACKFILL_STRICT_ACTORS: "true" }).deriveActors).toBe(
      false,
    );
  });

  it("does not create repos unless asked", () => {
    expect(resolveRunnerOptions([], env).createMissingRepos).toBe(false);
    expect(resolveRunnerOptions(["--create-missing-repos"], env).createMissingRepos).toBe(true);
  });

  it("defaults the sample size, and falls back when the value is not a number", () => {
    expect(resolveRunnerOptions([], env).sampleSize).toBe(20);
    expect(resolveRunnerOptions(["--sample-size", "5"], env).sampleSize).toBe(5);
    expect(resolveRunnerOptions(["--sample-size", "lots"], env).sampleSize).toBe(20);
  });
});

describe("normalizeRepoKey", () => {
  it("collapses case and separators onto one key", () => {
    expect(normalizeRepoKey("  Repo One ")).toBe("repo-one");
    expect(normalizeRepoKey("repo_one")).toBe("repo-one");
  });

  it("strips leading and trailing separators", () => {
    expect(normalizeRepoKey("-repo-")).toBe("repo");
  });

  it("returns empty for a label that normalises to nothing", () => {
    expect(normalizeRepoKey("  -- ")).toBe("");
  });
});

describe("deriveActorAliases", () => {
  it("maps the unattributed actor onto the system actor type with a null id", () => {
    // Mapping it onto an agent would invent an identity the source never
    // had — `events` models "written by the machinery" first-class.
    expect(deriveActorAliases(["system"], {}, true)).toEqual({
      system: { actorType: "system", actorId: null },
    });
  });

  it("maps every other actor onto an agent keyed on its own label", () => {
    expect(deriveActorAliases(["worker-a"], {}, true)).toEqual({
      "worker-a": { actorType: "agent", actorId: "worker-a" },
    });
  });

  it("lets a payload-supplied entry win — the only way an actor becomes a person", () => {
    const explicit = { "worker-a": { actorType: "person" as const, actorId: "user-a" } };
    expect(deriveActorAliases(["worker-a"], explicit, true)["worker-a"]).toEqual({
      actorType: "person",
      actorId: "user-a",
    });
  });

  it("derives NOTHING when derivation is off, restoring the importer's refusal", () => {
    expect(deriveActorAliases(["worker-a", "system"], {}, false)).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// Payload shape helpers
// ---------------------------------------------------------------------------

function payloadFixture(overrides: Partial<BackfillPayload> = {}): BackfillPayload {
  const task = (id: string, status: string) => ({
    id,
    title: `Title for ${id}`,
    body: `# Brief for ${id}\n`,
    status,
    priority: "P1" as const,
    branch: `task/${id}`,
    needsVisualReview: true,
    repo: "repo-one",
    sourceRef: `${id}/source.json@0123456789abcdef`,
    customFields: { source_status: status },
    history: [
      { id: `${id}:h:1`, actor: "system", at: "1970-01-01T00:00:00Z", note: "minted" },
      { id: `${id}:h:2`, actor: "worker-a", at: "1970-01-01T00:01:00Z", note: "claimed" },
    ],
    claims: [
      {
        id: `${id}:role:fm`,
        sessionId: `session-${id}`,
        role: "orchestrator",
        holderType: "agent" as const,
        holderId: "worker-a",
        machine: "machine-one",
        claimedAt: "1970-01-01T00:01:00Z",
        releasedAt: null,
      },
      {
        id: `${id}:role:coder`,
        sessionId: `unclaimed:${id}:coder`,
        role: "builder",
        holderType: "agent" as const,
        holderId: "worker-b",
        machine: "unknown",
        claimedAt: "1970-01-01T00:02:00Z",
        releasedAt: "1970-01-01T00:03:00Z",
      },
    ],
    reviews: [
      {
        id: `${id}:artifact:r01`,
        kind: "code_review",
        verdict: "approved",
        reviewRound: 1,
        commitSha: "abc1234",
        body: '{"verdict":"lgtm"}',
        findings: [
          { text: "a graded finding", severity: "high", where: "src/a.ts:1" },
          { text: "an ungraded finding" },
        ],
        ref: `${id}/reviews/r01-code-worker-a.json`,
        createdByType: "agent" as const,
        createdById: "worker-a",
        createdAt: "1970-01-02T00:00:00Z",
      },
    ],
  });

  return parsePayload({
    version: 1,
    defaultArea: "imported",
    // The caller supplies its own status vocabulary — the application ships
    // its states and no table translating anybody's words into them.
    statusAliases: { executing: "executing", merged: "merged" },
    tasks: [task(TASK_A, "executing"), task(TASK_B, "merged")],
    ...overrides,
  });
}

describe("repoLabelsIn / actorsIn", () => {
  it("collects the distinct labels a payload uses, sorted", () => {
    expect(repoLabelsIn(payloadFixture())).toEqual(["repo-one"]);
    expect(actorsIn(payloadFixture())).toEqual(["system", "worker-a"]);
  });
});

describe("parsePayload", () => {
  it("REFUSES a payload whose version is not the one this build accepts", () => {
    expect(() => parsePayload({ version: 2, defaultArea: "a", tasks: [] })).toThrow(/version/);
  });

  it("REFUSES an unrecognised key rather than ignoring it", () => {
    // A converter with a typo'd field name finds out here, not by
    // discovering afterwards that the data never arrived.
    expect(() => parsePayload({ version: 1, defaultArea: "a", tasks: [], extra: true })).toThrow(
      /backfill contract/,
    );
  });

  it("REFUSES a defaultArea that normalises to nothing", () => {
    expect(() => parsePayload({ version: 1, defaultArea: " -- ", tasks: [] })).toThrow(
      /defaultArea/,
    );
  });

  it("REFUSES a history entry with an unparseable timestamp", () => {
    expect(() =>
      parsePayload({
        version: 1,
        defaultArea: "a",
        tasks: [
          {
            id: "t",
            title: "t",
            body: "",
            status: "executing",
            history: [{ id: "h1", actor: "system", at: "not a date", note: "x" }],
          },
        ],
      }),
    ).toThrow(/timestamp/);
  });

  it("REFUSES an actor alias that is not `system` and carries no id", () => {
    expect(() =>
      parsePayload({
        version: 1,
        defaultArea: "a",
        tasks: [],
        actorAliases: { "worker-a": { actorType: "agent", actorId: null } },
      }),
    ).toThrow(/actorId/);
  });

  it("accepts a system alias with a null id — the one case that is legal", () => {
    const payload = parsePayload({
      version: 1,
      defaultArea: "a",
      tasks: [],
      actorAliases: { system: { actorType: "system", actorId: null } },
    });
    expect(payload.actorAliases!.system).toEqual({ actorType: "system", actorId: null });
  });
});

// ---------------------------------------------------------------------------
// The end-to-end sequence — real Postgres
// ---------------------------------------------------------------------------

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const describeDb = testDatabaseUrl ? describe : describe.skip;

const RUN_OPTIONS = { createMissingRepos: true, deriveActors: true, sampleSize: 20 };

describeDb("runBackfill (real database)", () => {
  const databaseName = scratchDatabaseName("backfill_runner");
  let prisma: PrismaClient;

  beforeAll(async () => {
    const url = createScratchDatabase(testDatabaseUrl!, databaseName);
    const result = await runMigrations({ env: { ...process.env, DATABASE_URL: url } });
    if (!result.ok) throw new Error("migrations failed against the scratch database");
    prisma = new PrismaClient({ datasources: { db: { url } } });
  }, 180_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    dropScratchDatabase(testDatabaseUrl!, databaseName);
  });

  afterEach(async () => {
    // Order matters — every child table references Item.
    await prisma.$executeRawUnsafe('DELETE FROM "Event"');
    await prisma.$executeRawUnsafe('DELETE FROM "Artifact"');
    await prisma.$executeRawUnsafe('DELETE FROM "Assignment"');
    await prisma.$executeRawUnsafe('DELETE FROM "Item"');
    await prisma.$executeRawUnsafe('DELETE FROM "Repo"');
  });

  it("lands items, events, assignments and artifacts and verifies clean", async () => {
    const report = await runBackfill(prisma, payloadFixture(), RUN_OPTIONS);

    expect(report.counts.itemsImported).toBe(2);
    // TASK_B is terminal (`merged`), so its two history entries collapse to
    // one row; TASK_A is in flight and keeps both.
    expect(report.counts.eventsImported).toBe(3);
    expect(report.counts.claimsImported).toBe(4);
    expect(report.counts.artifactsImported).toBe(2);

    expect(report.verification.items.matches).toBe(true);
    expect(report.verification.events.matches).toBe(true);
    expect(report.verification.assignmentsArtifacts.matches).toBe(true);
    expect(report.verification.spotCheck.allMatch).toBe(true);
  }, 120_000);

  it("lands the brief as the item body and every optional typed column", async () => {
    await runBackfill(prisma, payloadFixture(), RUN_OPTIONS);

    const item = await prisma.item.findFirst({
      where: { customFields: { path: ["legacy_id"], equals: TASK_B } },
    });
    expect(item?.body).toBe(`# Brief for ${TASK_B}\n`);
    expect(item?.priority).toBe("P1");
    expect(item?.branch).toBe(`task/${TASK_B}`);
    expect(item?.needsVisualReview).toBe(true);
    expect(item?.sourceRef).toBe(`${TASK_B}/source.json@0123456789abcdef`);
    expect(item?.state).toBe("merged");
    // The escape hatch carries what has no column, and `legacy_id` survives.
    expect((item?.customFields as Record<string, unknown>).source_status).toBe("merged");
    expect((item?.customFields as Record<string, unknown>).legacy_id).toBe(TASK_B);
  }, 120_000);

  it("attributes an unattributed history row to the system actor with no actor id", async () => {
    await runBackfill(prisma, payloadFixture(), RUN_OPTIONS);

    const rows = await prisma.$queryRawUnsafe<{ actorType: string; actorId: string | null }[]>(
      `SELECT "actorType"::text AS "actorType", "actorId" FROM "Event" WHERE "body" = 'minted'`,
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.actorType).toBe("system");
      expect(row.actorId).toBeNull();
    }
  }, 120_000);

  it("keeps a never-released claim live and a released one released", async () => {
    await runBackfill(prisma, payloadFixture(), RUN_OPTIONS);

    const rows = await prisma.$queryRawUnsafe<{ role: string; releasedAt: Date | null }[]>(
      `SELECT "role"::text AS "role", "releasedAt" FROM "Assignment"`,
    );
    expect(rows.filter((r) => r.releasedAt === null).every((r) => r.role === "orchestrator")).toBe(
      true,
    );
    expect(rows.filter((r) => r.role === "builder").every((r) => r.releasedAt !== null)).toBe(true);
  }, 120_000);

  it("is IDEMPOTENT — a second run inserts nothing", async () => {
    const check = await runBackfillTwice(prisma, payloadFixture(), RUN_OPTIONS);

    expect(check.reinserted).toEqual([]);
    expect(check.idempotent).toBe(true);
    expect(check.second.counts.itemsSkipped).toBe(2);
    expect(check.second.counts.eventsSkipped).toBe(3);
    expect(check.second.counts.artifactsSkipped).toBe(2);
  }, 180_000);

  it("REFUSES a repo label with no mapping when repo creation was not asked for", async () => {
    // Repos are deliberate-create only: an unmapped label is a mapping gap
    // to fix, not license to mint a repo the merge gate would then aim at.
    await expect(
      runBackfill(prisma, payloadFixture(), { ...RUN_OPTIONS, createMissingRepos: false }),
    ).rejects.toThrow(UnknownRepoAliasError);
  }, 120_000);

  it("accepts a payload-supplied repo alias without creating anything", async () => {
    await prisma.repo.create({
      data: { id: "mapped-repo", displayName: "Mapped", defaultBranch: "main" },
    });
    const payload = payloadFixture({ repoAliases: { "repo-one": "mapped-repo" } });

    const report = await runBackfill(prisma, payload, {
      ...RUN_OPTIONS,
      createMissingRepos: false,
    });
    expect(report.repos.created).toEqual([]);
    expect(report.repos.unmapped).toEqual([]);
    expect(report.counts.itemsImported).toBe(2);
  }, 120_000);

  it("REFUSES an alias whose target repo does not exist, naming label, target and remedy", async () => {
    // The defect this closes: an aliased label was assumed to point at an
    // existing repo and never checked, so the run died later on a bare
    // `Item_repo_fkey` violation naming neither the task, the label, nor
    // the target. Deleting the findUnique check restores that.
    const payload = payloadFixture({ repoAliases: { "repo-one": "no-such-repo" } });

    await expect(runBackfill(prisma, payload, RUN_OPTIONS)).rejects.toThrow(DanglingRepoAliasError);
    await expect(runBackfill(prisma, payload, RUN_OPTIONS)).rejects.toThrow(/repo-one/);
    await expect(runBackfill(prisma, payload, RUN_OPTIONS)).rejects.toThrow(/no-such-repo/);
    // Actionable, not just named: it says what to do about it.
    await expect(runBackfill(prisma, payload, RUN_OPTIONS)).rejects.toThrow(/standup repo create/);
  }, 120_000);

  it("does NOT mint an alias target even under --create-missing-repos", async () => {
    // The flag means "mint the labels my payload uses". An alias asserts an
    // existing repo; minting its target would invent the row the caller
    // said was already there and hide a typo instead of reporting it.
    const payload = payloadFixture({ repoAliases: { "repo-one": "typo-target" } });
    await expect(
      runBackfill(prisma, payload, { ...RUN_OPTIONS, createMissingRepos: true }),
    ).rejects.toThrow(DanglingRepoAliasError);

    const repo = await prisma.repo.findUnique({ where: { id: "typo-target" } });
    expect(repo).toBeNull();
  }, 120_000);

  it("reports EVERY dangling alias target in one run, not the first one it hits", async () => {
    const payload = payloadFixture({
      repoAliases: { "repo-one": "missing-a", "repo-two": "missing-b" },
      tasks: [
        ...payloadFixture().tasks.map((task) => ({ ...task, repo: "repo-one" })),
        { ...payloadFixture().tasks[0]!, id: "T-19700103-three", repo: "repo-two" },
      ],
    });
    await expect(runBackfill(prisma, payload, RUN_OPTIONS)).rejects.toThrow(/missing-a/);
    await expect(runBackfill(prisma, payload, RUN_OPTIONS)).rejects.toThrow(/missing-b/);
  }, 120_000);

  it("lands caller-supplied timestamps, origin and merge authority in their real columns", async () => {
    // Without these slots every imported row is stamped at the import
    // moment, which destroys the ordering an imported backlog is read by.
    const base = payloadFixture();
    const payload = parsePayload({
      ...base,
      tasks: [
        {
          ...base.tasks[0]!,
          createdAt: "1999-03-04T05:06:07Z",
          updatedAt: "2001-09-10T11:12:13Z",
          originType: "auto",
          mergeAuthority: "pre_approved",
        },
        base.tasks[1]!,
      ],
    });

    await runBackfill(prisma, payload, RUN_OPTIONS);
    const item = await prisma.item.findFirst({
      where: { customFields: { path: ["legacy_id"], equals: TASK_A } },
    });
    expect(item?.createdAt.toISOString()).toBe("1999-03-04T05:06:07.000Z");
    expect(item?.updatedAt.toISOString()).toBe("2001-09-10T11:12:13.000Z");
    expect(item?.originType).toBe("auto");
    expect(item?.mergeAuthority).toBe("pre_approved");

    // The task that supplied none of them keeps the documented defaults.
    const other = await prisma.item.findFirst({
      where: { customFields: { path: ["legacy_id"], equals: TASK_B } },
    });
    expect(other?.originType).toBe("source");
    expect(other?.mergeAuthority).toBe("needs_approval");
  }, 120_000);

  it("resolves a status through a CALLER-SUPPLIED alias the application has never heard of", async () => {
    // The portability property: a caller's state machine is translated by
    // the payload, not by a table inside the application.
    const base = payloadFixture();
    const payload = parsePayload({
      ...base,
      statusAliases: { ...base.statusAliases, "awaiting-sign-off": "paused" },
      tasks: [{ ...base.tasks[0]!, status: "awaiting-sign-off" }, base.tasks[1]!],
    });

    const report = await runBackfill(prisma, payload, RUN_OPTIONS);
    expect(report.verification.spotCheck.allMatch).toBe(true);

    const item = await prisma.item.findFirst({
      where: { customFields: { path: ["legacy_id"], equals: TASK_A } },
    });
    expect(item?.state).toBe("paused");
  }, 120_000);

  it("REFUSES a status in neither the payload's aliases nor the application's own vocabulary", async () => {
    const base = payloadFixture();
    const payload = parsePayload({
      ...base,
      tasks: [{ ...base.tasks[0]!, status: "invented-status" }, base.tasks[1]!],
    });
    await expect(runBackfill(prisma, payload, RUN_OPTIONS)).rejects.toThrow(/invented-status/);
  }, 120_000);

  it("REFUSES up front a verdict the database's own enum cannot store", async () => {
    // Merge-order safety. This build knows the tiered verdicts; a database
    // whose migration adding them has not been applied does not. Without
    // this pre-flight the mismatch surfaces partway through a bulk insert
    // as `invalid input value for enum "Verdict"`, naming no artifact and
    // no remedy, after part of the import has already run.
    //
    // Simulated by asking for a label this database genuinely does not
    // have, which is exactly the shape of the real case.
    const base = payloadFixture();
    const payload = parsePayload({
      ...base,
      verdictAliases: { "some-future-verdict": "lgtm_with_followups" },
      tasks: base.tasks.map((task) => ({
        ...task,
        reviews: (task.reviews ?? []).map((review) => ({
          ...review,
          verdict: "some-future-verdict",
        })),
      })),
    });

    const labels = await prisma.$queryRawUnsafe<{ label: string }[]>(
      `SELECT e.enumlabel AS label FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
        WHERE t.typname = 'Verdict'`,
    );
    const available = labels.map((row) => row.label);

    if (available.includes("lgtm_with_followups")) {
      // The migration has landed: the value stores, and nothing is refused.
      const report = await runBackfill(prisma, payload, RUN_OPTIONS);
      expect(report.counts.artifactsImported).toBeGreaterThan(0);
    } else {
      // The migration has not landed: refused BEFORE anything is written,
      // naming the value and the remedy.
      await expect(runBackfill(prisma, payload, RUN_OPTIONS)).rejects.toThrow(
        VerdictNotStorableError,
      );
      await expect(runBackfill(prisma, payload, RUN_OPTIONS)).rejects.toThrow(
        /lgtm_with_followups/,
      );
      const artifacts = await prisma.artifact.count();
      expect(artifacts).toBe(0);
    }
  }, 120_000);

  it("imports a caller's hyphenated verdict spelling through verdictAliases", async () => {
    // The 36-artifact case: a source writing `lgtm-with-nits` maps it in
    // the payload rather than this application knowing that spelling.
    const base = payloadFixture();
    const payload = parsePayload({
      ...base,
      verdictAliases: { "changes-required": "changes_required" },
      tasks: base.tasks.map((task) => ({
        ...task,
        reviews: (task.reviews ?? []).map((review) => ({
          ...review,
          verdict: "changes-required",
        })),
      })),
    });

    const report = await runBackfill(prisma, payload, RUN_OPTIONS);
    expect(report.counts.artifactsImported).toBe(2);
    const rows = await prisma.$queryRawUnsafe<{ verdict: string }[]>(
      `SELECT "verdict"::text AS verdict FROM "Artifact"`,
    );
    expect(rows.every((row) => row.verdict === "changes_required")).toBe(true);
  }, 120_000);

  it("stores each review's findings WITH their severity, and keeps ungraded ones ungraded", async () => {
    // The storage for findings existed before any writer did, so the
    // findings were being dropped as silently as the history prose was.
    // Removing `findings` from the INSERT fails this outright.
    const payload = payloadFixture();
    const report = await runBackfill(prisma, payload, RUN_OPTIONS);

    expect(report.counts.findingsIn).toBe(4); // two artifacts, two findings each
    expect(report.counts.findingsWritten).toBe(4);
    expect(report.counts.findingsWithoutSeverity).toBe(2);

    const rows = await prisma.$queryRawUnsafe<{ findings: unknown }[]>(
      `SELECT "findings" FROM "Artifact" WHERE "findings" IS NOT NULL`,
    );
    expect(rows).toHaveLength(2);
    const first = rows[0]!.findings as { text: string; severity?: string; where?: string }[];
    expect(first).toHaveLength(2);
    expect(first[0]).toEqual({
      text: "a graded finding",
      severity: "high",
      where: "src/a.ts:1",
    });
    // The ungraded one keeps NO severity key — not null, not a default.
    expect(first[1]).toEqual({ text: "an ungraded finding" });
    expect("severity" in first[1]!).toBe(false);
  }, 120_000);

  it("resolves a caller's severity spelling through severityAliases, including a hedge", async () => {
    // A hedge between two levels, and a word that is not a level at all,
    // are both judgement calls. Putting them in the payload keeps the call
    // declared and reviewable instead of buried in a coercion.
    const base = payloadFixture();
    const payload = parsePayload({
      ...base,
      severityAliases: { "low-medium": "low", note: "info", HIGH: "high" },
      tasks: base.tasks.map((task) => ({
        ...task,
        reviews: (task.reviews ?? []).map((review) => ({
          ...review,
          findings: [
            { text: "a hedged finding", severity: "low-medium" },
            { text: "not a severity at all", severity: "note" },
            { text: "an uppercase level", severity: "HIGH" },
          ],
        })),
      })),
    });

    await runBackfill(prisma, payload, RUN_OPTIONS);
    const rows = await prisma.$queryRawUnsafe<{ s: string; n: bigint }[]>(
      `SELECT f->>'severity' AS s, count(*) AS n
         FROM "Artifact" a, jsonb_array_elements(a."findings") f
        WHERE jsonb_typeof(a."findings") = 'array' GROUP BY 1`,
    );
    const bySeverity = Object.fromEntries(rows.map((r) => [r.s, Number(r.n)]));
    expect(bySeverity).toEqual({ low: 2, info: 2, high: 2 });
  }, 120_000);

  it("REFUSES an unmapped severity outright rather than importing the review without it", async () => {
    const base = payloadFixture();
    await expect(
      runBackfill(
        prisma,
        parsePayload({
          ...base,
          tasks: base.tasks.map((task) => ({
            ...task,
            reviews: (task.reviews ?? []).map((review) => ({
              ...review,
              findings: [{ text: "a hedged finding", severity: "low-medium" }],
            })),
          })),
        }),
        RUN_OPTIONS,
      ),
    ).rejects.toThrow(/low-medium/);
  }, 120_000);

  it("reconciles findings: every one accounted for, and read back from the database", async () => {
    const payload = payloadFixture();
    const report = await runBackfill(prisma, payload, RUN_OPTIONS);

    const accounted = report.counts.findingsWritten + report.counts.findingsOnSkippedArtifacts;
    expect(accounted).toBe(report.counts.findingsIn);

    const retention = report.verification.findingsRetention;
    expect(retention.findingsInDb).toBe(report.counts.findingsIn);
    expect(retention.gradedInDb).toBe(2);
    expect(retention.ungradedInDb).toBe(2);
    expect(retention.matches).toBe(true);

    const text = formatRunReport(report);
    expect(text).toContain("Findings reconciliation");
    expect(text).toContain("(sums)");
    expect(text).toContain("findings retention: COMPLETE");
  }, 120_000);

  it("REFUSES a malformed finding rather than importing the artifact without it", async () => {
    // Refusing beats repairing: a coerced list looks complete and is not.
    const base = payloadFixture();
    await expect(
      runBackfill(
        prisma,
        {
          ...base,
          tasks: base.tasks.map((task) => ({
            ...task,
            reviews: (task.reviews ?? []).map((review) => ({
              ...review,
              findings: [{ text: "ok" }, { text: "" }],
            })),
          })),
        } as typeof base,
        RUN_OPTIONS,
      ),
    ).rejects.toThrow(/findings\[1\]/);
  }, 120_000);

  it("counts findings on an artifact skipped as already present, so the accounting still sums", async () => {
    const payload = payloadFixture();
    await runBackfill(prisma, payload, RUN_OPTIONS);
    const second = await runBackfill(prisma, payload, RUN_OPTIONS);

    expect(second.counts.findingsWritten).toBe(0);
    expect(second.counts.findingsOnSkippedArtifacts).toBe(4);
    expect(second.counts.findingsWritten + second.counts.findingsOnSkippedArtifacts).toBe(
      second.counts.findingsIn,
    );
    // And the database still holds them exactly once.
    expect(second.verification.findingsRetention.findingsInDb).toBe(4);
  }, 120_000);

  it("reconciles history: every source entry is accounted for and none is lost", async () => {
    const payload = payloadFixture();
    const report = await runBackfill(prisma, payload, RUN_OPTIONS);

    const entriesIn = payload.tasks.reduce((n, t) => n + (t.history?.length ?? 0), 0);
    expect(report.counts.historyEntriesIn).toBe(entriesIn);
    // The accounting must SUM: one-for-one imports plus folded entries.
    const own = report.counts.historyEntriesIn - report.counts.historyEntriesCollapsed;
    expect(own + report.counts.historyEntriesCollapsed).toBe(entriesIn);
    // TASK_B is terminal, so its two entries fold into one event.
    expect(report.counts.historyEntriesCollapsed).toBe(2);
    // And nothing was lost, read back from the database.
    expect(report.verification.historyRetention.entriesMissing).toBe(0);
    expect(report.verification.historyRetention.entriesRetained).toBe(entriesIn);
    expect(report.verification.historyRetention.matches).toBe(true);

    const text = formatRunReport(report);
    expect(text).toContain("History reconciliation");
    expect(text).toContain("(sums)");
    expect(text).toContain("history retention : COMPLETE");
  }, 120_000);

  it("REFUSES an actor with no alias when derivation is off", async () => {
    await expect(
      runBackfill(prisma, payloadFixture(), { ...RUN_OPTIONS, deriveActors: false }),
    ).rejects.toThrow(/actorAliases/);
  }, 120_000);

  it("never lets a payload custom field displace the legacy id idempotency keys on", async () => {
    // A displaced key makes every later run re-insert every row it had
    // already written — the exact opposite of the property the whole
    // backfill depends on.
    await importItems(
      prisma,
      [
        {
          id: TASK_A,
          title: "t",
          body: "b",
          status: "executing",
          area: "imported",
          customFields: { legacy_id: "a-different-id", extra: 1 },
        },
      ],
      { repoAliases: {}, statusAliases: { executing: "executing" } },
    );

    const item = await prisma.item.findFirst({
      where: { customFields: { path: ["legacy_id"], equals: TASK_A } },
    });
    expect(item).not.toBeNull();
    expect((item!.customFields as Record<string, unknown>).extra).toBe(1);
  }, 120_000);

  it("reports the counts and the verification result in the formatted report", async () => {
    const report = await runBackfill(prisma, payloadFixture(), RUN_OPTIONS);
    const text = formatRunReport(report);
    expect(text).toContain("Verification");
    expect(text).toContain("item row counts   : MATCH");
    expect(text).toContain("spot check        : ALL MATCH");
  }, 120_000);
});
