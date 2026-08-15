// Wiring the notification evaluator into the mutations — MILESTONES.md #101,
// SCHEMA.md §1.1b, §17.2.
//
// Two halves, deliberately separated. The pure half (casing, parsing) needs
// no database and is where the interesting failure modes live: both are
// silent when wrong, which is exactly why they are asserted directly rather
// than only through an end-to-end path. The DB-backed half proves the
// operations actually call the evaluator, against a real Postgres, because
// "the caller exists" is the entire content of this row and only a real call
// can settle it.
import { PrismaClient } from "@prisma/client";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { ServiceRuntime, guardRegistry, prismaTransactionRunner } from "@/lib/service";
import { ALL_GUARDS } from "@/lib/service/guards";
import {
  IDENTICALLY_NAMED_NOTIFY_FIELDS,
  ITEM_FIELD_TO_NOTIFY_FIELD,
  parseStoredRules,
  snapshotOf,
} from "@/lib/service/notify-on-change";
import { NOTIFY_FIELD_WHITELIST, evaluateRules } from "@/lib/notifications";
import type { ItemRecord } from "@/lib/service/items/row";
import { defaultSnapshot, resolveSettings } from "@/lib/settings";
import {
  createMigratedScratchDatabase,
  dropScratchDatabase,
  scratchDatabaseName,
} from "./helpers/scratch-db";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const describeIfDb = testDatabaseUrl ? describe : describe.skip;

/** A minimal `ItemRecord` — only the fields a notification rule may ask about matter here. */
function itemRecord(overrides: Partial<ItemRecord> = {}): ItemRecord {
  return {
    id: "task-1",
    parentId: null,
    kind: "task",
    title: "Title",
    // The BLUF (MILESTONES.md #107). No notification rule may ask about it,
    // so null is the honest default here rather than a value implying it is
    // part of what a rule sees.
    headline: null,
    body: "",
    state: "executing",
    priority: "P2",
    originType: "person",
    originPersonId: null,
    area: "web",
    // The notification whitelist compares the PRIMARY area only — `areas`
    // is present because `ItemRecord` carries it, not because a rule can
    // ask about it. Kept in step with `area` so the fixture stays coherent.
    areas: ["web"],
    repo: null,
    branch: null,
    needsVisualReview: false,
    driveMode: "autonomous",
    mergeAuthority: "needs_approval",
    blockedReason: null,
    blockedOnType: null,
    blockedOnPersonId: null,
    unblockAt: null,
    pauseReason: null,
    resumeCondition: null,
    resumeAttempts: 0,
    difficulty: null,
    sourceRef: null,
    notify: null,
    estimatedCost: null,
    customFields: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    completedAt: null,
    ...overrides,
  };
}

describe("snapshotOf — the casing bridge the evaluator's header hands to its caller", () => {
  // `notifications.ts` states this explicitly: the whitelist is snake_case,
  // `Item`'s columns are camelCase, four of nine differ, and an unrecognised
  // spelling evaluates to `false` rather than erroring. So getting this wrong
  // produces rules that never fire, with nothing anywhere reporting it —
  // which is why it is asserted head-on and not merely via a passing rule.

  it("emits every whitelisted field name, and nothing else", () => {
    const snapshot = snapshotOf(itemRecord(), null);
    expect(Object.keys(snapshot).sort()).toEqual([...NOTIFY_FIELD_WHITELIST].sort());
  });

  it("maps the four camelCase columns onto their snake_case whitelist names", () => {
    const snapshot = snapshotOf(
      itemRecord({
        blockedOnType: "person",
        blockedOnPersonId: "user-a",
        driveMode: "supervised",
        mergeAuthority: "pre_approved",
      }),
      null,
    );

    expect(snapshot.blocked_on_type).toBe("person");
    expect(snapshot.blocked_on_person).toBe("user-a");
    expect(snapshot.drive_mode).toBe("supervised");
    expect(snapshot.merge_authority).toBe("pre_approved");

    // And the camelCase spellings are absent — a snapshot carrying both
    // would pass the assertion above while still being the bug.
    expect(snapshot).not.toHaveProperty("blockedOnType");
    expect(snapshot).not.toHaveProperty("driveMode");
  });

  it("carries the identically-spelled fields straight through", () => {
    const snapshot = snapshotOf(
      itemRecord({ state: "blocked", area: "infra", repo: "web", priority: "P0" }),
      null,
    );
    expect(snapshot.state).toBe("blocked");
    expect(snapshot.area).toBe("infra");
    expect(snapshot.repo).toBe("web");
    expect(snapshot.priority).toBe("P0");
  });

  it("accounts for the whole whitelist between the map, the identical names, and assignee", () => {
    // The guard against the silent failure: adding a field to the whitelist
    // without deciding how it is sourced fails here rather than shipping a
    // rule that can never fire.
    const accounted = [
      ...Object.values(ITEM_FIELD_TO_NOTIFY_FIELD),
      ...IDENTICALLY_NAMED_NOTIFY_FIELDS,
      "assignee",
    ].sort();
    expect(accounted).toEqual([...NOTIFY_FIELD_WHITELIST].sort());
  });

  it("puts assignee in the snapshot from its argument, not from the row", () => {
    expect(snapshotOf(itemRecord(), "user-b").assignee).toBe("user-b");
    expect(snapshotOf(itemRecord(), null).assignee).toBeNull();
  });

  it("produces snapshots a real rule fires on — the mapping end to end", () => {
    // The point of the mapping, proven through the evaluator itself: a rule
    // written in the whitelist's spelling fires on a snapshot built from a
    // camelCase row. Before the mapping existed, this returned nothing.
    const before = snapshotOf(itemRecord({ driveMode: "autonomous" }), null);
    const after = snapshotOf(itemRecord({ driveMode: "manual" }), null);

    const result = evaluateRules(
      [{ notify: ["user-a"], whenAll: [{ field: "drive_mode", op: "changed" }] }],
      before,
      after,
    );

    expect(result.recipients).toEqual(["user-a"]);
  });

  it("a rule written in the WRONG casing fires on nothing — the failure being prevented", () => {
    // The negative control. This is what every drive_mode/merge_authority
    // rule would silently do if the caller handed `ItemRecord` over directly.
    const before = snapshotOf(itemRecord({ driveMode: "autonomous" }), null);
    const after = snapshotOf(itemRecord({ driveMode: "manual" }), null);

    const result = evaluateRules(
      [{ notify: ["user-a"], whenAll: [{ field: "driveMode", op: "changed" }] }],
      before,
      after,
    );

    expect(result.recipients).toEqual([]);
  });
});

describe("parseStoredRules — stored snake_case buckets into the evaluator's camelCase shape", () => {
  it("maps when_all and when_any onto whenAll and whenAny", () => {
    const rules = parseStoredRules([
      {
        notify: ["user-a"],
        when_all: [{ field: "state", op: "eq", value: "blocked" }],
        when_any: [{ field: "priority", op: "eq", value: "P0" }],
      },
    ]);

    expect(rules).toHaveLength(1);
    expect(rules[0]?.whenAll).toEqual([{ field: "state", op: "eq", value: "blocked" }]);
    expect(rules[0]?.whenAny).toEqual([{ field: "priority", op: "eq", value: "P0" }]);
  });

  it("a stored rule actually fires once parsed — the bucket mapping end to end", () => {
    const rules = parseStoredRules([
      { notify: ["user-a"], when_all: [{ field: "state", op: "eq", value: "blocked" }] },
    ]);

    const result = evaluateRules(
      rules,
      snapshotOf(itemRecord({ state: "executing" }), null),
      snapshotOf(itemRecord({ state: "blocked" }), null),
    );

    expect(result.recipients).toEqual(["user-a"]);
  });

  it("DROPS a rule whose buckets did not survive parsing", () => {
    // `ruleMatches` treats a missing bucket as vacuously true, so a rule that
    // parsed into no conditions would match everything if it ever reached the
    // evaluator. **This `continue` is what stops it reaching one** — which is
    // why the real failure mode of a mis-cased rule is silence rather than a
    // storm (see the case below, which measures it).
    expect(parseStoredRules([{ notify: ["user-a"] }])).toEqual([]);
    expect(parseStoredRules([{ notify: ["user-a"], when_all: [] }])).toEqual([]);
    // Camel-cased buckets are not the stored form — a rule written that way
    // has no recognised conditions and must be dropped, not accepted as
    // match-everything.
    expect(
      parseStoredRules([{ notify: ["user-a"], whenAll: [{ field: "state", op: "changed" }] }]),
    ).toEqual([]);
  });

  it("fires ZERO times for a bucketless rule even if one reaches the evaluator", () => {
    // The second, independent reason the failure is silence — and the one
    // that is easy to get backwards, because `ruleMatches` genuinely *is*
    // vacuously true here. `evaluateRules` is edge-triggered on
    // `matchesAfter && !matchesBefore`, and a rule matching everything
    // matches `before` too, so the edge never occurs.
    //
    // Constructed by hand rather than through `parseStoredRules`, precisely
    // because the parser drops it: this asserts what would happen if the
    // parser's guard were ever removed, which is what makes "silence, not a
    // storm" a measured claim rather than a reading of the code.
    const bucketless = [{ notify: ["user-a"] }] as unknown as Parameters<typeof evaluateRules>[0];
    const result = evaluateRules(
      bucketless,
      { state: "executing", driveMode: "autonomous" },
      { state: "blocked", driveMode: "autonomous" },
    );

    expect(result.fired).toEqual([]);
    expect(result.recipients).toEqual([]);
  });

  it("drops a rule whose only conditions name unwhitelisted fields", () => {
    // Otherwise it survives with an empty bucket, which is match-everything.
    expect(
      parseStoredRules([
        { notify: ["user-a"], when_all: [{ field: "custom_fields", op: "changed" }] },
      ]),
    ).toEqual([]);
    expect(
      parseStoredRules([{ notify: ["user-a"], when_all: [{ field: "title", op: "changed" }] }]),
    ).toEqual([]);
  });

  it("keeps the whitelisted conditions of a rule that also names an unwhitelisted one", () => {
    const rules = parseStoredRules([
      {
        notify: ["user-a"],
        when_all: [
          { field: "state", op: "eq", value: "blocked" },
          { field: "custom_fields", op: "changed" },
        ],
      },
    ]);
    expect(rules[0]?.whenAll).toEqual([{ field: "state", op: "eq", value: "blocked" }]);
  });

  it("drops malformed entries without throwing — one bad row cannot break a mutation", () => {
    expect(parseStoredRules(null)).toEqual([]);
    expect(parseStoredRules("not an array")).toEqual([]);
    expect(parseStoredRules([null, 42, "x"])).toEqual([]);
    // `notify` must be an array of strings.
    expect(
      parseStoredRules([{ notify: "user-a", when_all: [{ field: "state", op: "changed" }] }]),
    ).toEqual([]);
    expect(
      parseStoredRules([{ notify: [1, 2], when_all: [{ field: "state", op: "changed" }] }]),
    ).toEqual([]);
  });

  it("rejects an unrecognised operator rather than passing it to the evaluator", () => {
    expect(
      parseStoredRules([{ notify: ["user-a"], when_all: [{ field: "state", op: "matches" }] }]),
    ).toEqual([]);
  });

  it("keeps a valid rule alongside a malformed one", () => {
    const rules = parseStoredRules([
      "garbage",
      { notify: ["user-a"], when_all: [{ field: "state", op: "changed" }] },
    ]);
    expect(rules).toHaveLength(1);
    expect(rules[0]?.notify).toEqual(["user-a"]);
  });
});

describeIfDb("the mutations actually call the evaluator", () => {
  const dbName = scratchDatabaseName("notify_on_change");
  let scratchUrl: string;
  let prisma: PrismaClient;

  /** Settings with `notify.doc` set — the capability on. */
  function notifyOnSnapshot() {
    return resolveSettings({
      overrides: [{ key: "notify.doc", value: "/docs/notify.md" }],
      revision: 1n,
    });
  }

  function runtimeWith(resolveSnapshot: () => Promise<ReturnType<typeof defaultSnapshot>>) {
    return new ServiceRuntime({
      transaction: prismaTransactionRunner(prisma),
      resolveSnapshot,
    });
  }

  beforeAll(async () => {
    scratchUrl = (await createMigratedScratchDatabase(testDatabaseUrl!, dbName)).url;
    prisma = new PrismaClient({ datasourceUrl: scratchUrl });
    await prisma.area.create({ data: { id: "web", displayName: "web" } });
    for (const guard of ALL_GUARDS) {
      if (!guardRegistry.has(guard.id)) guardRegistry.register(guard);
    }
  }, 60_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await dropScratchDatabase(testDatabaseUrl!, dbName);
  });

  afterEach(async () => {
    await prisma.$executeRawUnsafe(`DELETE FROM "Event"`);
    await prisma.item.deleteMany({});
    await prisma.person.deleteMany({});
  });

  let counter = 0;
  async function createTask(overrides: Partial<{ state: string; priority: string }> = {}) {
    counter += 1;
    const id = `task-${counter}`;
    await prisma.item.create({
      data: {
        id,
        kind: "task",
        title: `Task ${counter}`,
        body: "body",
        state: (overrides.state ?? "executing") as never,
        priority: (overrides.priority ?? "P2") as never,
        originType: "auto",
        area: "web",
        mergeAuthority: "needs_approval",
      },
    });
    return id;
  }

  async function personWithRules(id: string, rules: unknown) {
    await prisma.person.create({
      data: { id, displayName: id, notifyRules: rules as never },
    });
  }

  it("transition_item fires a rule watching state, and names the recipient", async () => {
    // The row's headline claim: before this, `people.notify_rules` was never
    // read by anything and this returned no notifications at all.
    const id = await createTask({ state: "executing" });
    await personWithRules("watcher", [
      { notify: ["user-a"], when_all: [{ field: "state", op: "eq", value: "someday" }] },
    ]);

    const result = (await runtimeWith(async () => notifyOnSnapshot()).call("transition_item", {
      id,
      to: "someday",
    })) as { notifications?: { recipients: string[]; firedCount: number } };

    expect(result.notifications?.recipients).toEqual(["user-a"]);
    expect(result.notifications?.firedCount).toBe(1);
  });

  it("transition_item reports nobody when no rule matches", async () => {
    const id = await createTask({ state: "executing" });
    await personWithRules("watcher", [
      { notify: ["user-a"], when_all: [{ field: "state", op: "eq", value: "merged" }] },
    ]);

    const result = (await runtimeWith(async () => notifyOnSnapshot()).call("transition_item", {
      id,
      to: "someday",
    })) as { notifications?: { recipients: string[]; skipped: string | null } };

    // Evaluated (not skipped) and matched nobody — a different answer from
    // the capability being off, which is the distinction the result carries.
    expect(result.notifications?.recipients).toEqual([]);
    expect(result.notifications?.skipped).toBeNull();
  });

  it("skips entirely when notify.doc is unset — SCHEMA.md §17.2's null means off", async () => {
    const id = await createTask({ state: "executing" });
    await personWithRules("watcher", [
      { notify: ["user-a"], when_all: [{ field: "state", op: "eq", value: "someday" }] },
    ]);

    const result = (await runtimeWith(async () => defaultSnapshot()).call("transition_item", {
      id,
      to: "someday",
    })) as { notifications?: unknown };

    // Absent, not empty: an installation that never configured the
    // capability must be distinguishable from one where nobody matched.
    expect(result.notifications).toBeUndefined();
  });

  it("update_item fires a rule watching priority — the fields only an edit changes", async () => {
    // Wiring only `transition_item` would leave four whitelisted fields
    // permanently unwatchable, which is why update is wired too.
    const id = await createTask({ priority: "P2" });
    await personWithRules("watcher", [
      { notify: ["user-b"], when_all: [{ field: "priority", op: "eq", value: "P0" }] },
    ]);

    const result = (await runtimeWith(async () => notifyOnSnapshot()).call("update_item", {
      id,
      priority: "P0",
    })) as { priority: string; notifications?: { recipients: string[] } };

    // The item fields are still on the result, unnested — existing callers
    // read them straight off it.
    expect(result.priority).toBe("P0");
    expect(result.notifications?.recipients).toEqual(["user-b"]);
  });

  it("update_item fires a rule on merge_authority — proving the casing bridge in a real call", () => {
    // The mapped fields, exercised through the operation rather than only
    // through `snapshotOf`. `mergeAuthority` is the column; `merge_authority`
    // is what the rule says.
    return (async () => {
      const id = await createTask();
      await personWithRules("watcher", [
        {
          notify: ["user-c"],
          when_all: [{ field: "merge_authority", op: "eq", value: "pre_approved" }],
        },
      ]);

      const result = (await runtimeWith(async () => notifyOnSnapshot()).call("update_item", {
        id,
        mergeAuthority: "pre-approved",
      })) as { notifications?: { recipients: string[] } };

      expect(result.notifications?.recipients).toEqual(["user-c"]);
    })();
  });

  it("is edge-triggered through the operation — a re-edit does not re-fire", async () => {
    // `evaluateRules` is edge-triggered and its own suite proves that. What
    // is proven here is that the CALLER passes a genuine before/after pair,
    // not the same snapshot twice: passing `after` as both would make every
    // rule fire never, and passing `before` as both would make it fire
    // always. Two sequential edits distinguish all three.
    const id = await createTask({ priority: "P2" });
    await personWithRules("watcher", [
      { notify: ["user-a"], when_all: [{ field: "priority", op: "eq", value: "P0" }] },
    ]);
    const runtime = runtimeWith(async () => notifyOnSnapshot());

    const first = (await runtime.call("update_item", { id, priority: "P0" })) as {
      notifications?: { recipients: string[] };
    };
    expect(first.notifications?.recipients).toEqual(["user-a"]);

    // Already P0, now edited elsewhere — the rule is still true but did not
    // BECOME true, so it must not fire again.
    const second = (await runtime.call("update_item", { id, title: "Retitled" })) as {
      notifications?: { recipients: string[] };
    };
    expect(second.notifications?.recipients).toEqual([]);
  });

  it("de-duplicates a recipient named by two different people's rules", async () => {
    const id = await createTask({ state: "executing" });
    await personWithRules("watcher-one", [
      { notify: ["user-a"], when_all: [{ field: "state", op: "eq", value: "someday" }] },
    ]);
    await personWithRules("watcher-two", [
      { notify: ["user-a", "user-b"], when_all: [{ field: "state", op: "changed" }] },
    ]);

    const result = (await runtimeWith(async () => notifyOnSnapshot()).call("transition_item", {
      id,
      to: "someday",
    })) as { notifications?: { recipients: string[]; firedCount: number } };

    expect(result.notifications?.recipients).toEqual(["user-a", "user-b"]);
    expect(result.notifications?.firedCount).toBe(2);
  });

  it("ignores an archived person's rules", async () => {
    const id = await createTask({ state: "executing" });
    await prisma.person.create({
      data: {
        id: "gone",
        displayName: "gone",
        archivedAt: new Date(),
        notifyRules: [
          { notify: ["user-a"], when_all: [{ field: "state", op: "changed" }] },
        ] as never,
      },
    });

    const result = (await runtimeWith(async () => notifyOnSnapshot()).call("transition_item", {
      id,
      to: "someday",
    })) as { notifications?: { recipients: string[] } };

    expect(result.notifications?.recipients).toEqual([]);
  });

  it("a malformed rule does not break the mutation", async () => {
    // The failure posture: a bad blob on one person is a data problem with
    // that row, and must not make an unrelated item untransitionable.
    const id = await createTask({ state: "executing" });
    await personWithRules("broken", { not: "an array" });

    const result = (await runtimeWith(async () => notifyOnSnapshot()).call("transition_item", {
      id,
      to: "someday",
    })) as { item: { state: string }; notifications?: { recipients: string[] } };

    expect(result.item.state).toBe("someday");
    expect(result.notifications?.recipients).toEqual([]);

    // And the transition really was written, not merely reported.
    const row = await prisma.item.findUniqueOrThrow({ where: { id } });
    expect(row.state).toBe("someday");
  });

  it("does not read people at all when the capability is off", async () => {
    // A fresh installation defaults `notify.doc` to null; it must not pay a
    // query per mutation for a feature nobody configured. Proven by a person
    // whose rules would certainly have matched.
    const id = await createTask({ state: "executing" });
    await personWithRules("watcher", [
      { notify: ["user-a"], when_all: [{ field: "state", op: "changed" }] },
    ]);

    const result = (await runtimeWith(async () => defaultSnapshot()).call("update_item", {
      id,
      priority: "P0",
    })) as { notifications?: unknown };

    expect(result.notifications).toBeUndefined();
  });
});
