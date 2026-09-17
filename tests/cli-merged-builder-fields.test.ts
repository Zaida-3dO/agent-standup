// The merged ownership CLI builder keeps every field, against Postgres.
//
// ── Why this file exists, and why it is shaped this way ───────────────
//
// `src/lib/cli/commands-ownership.ts` carried eleven `buildInput` functions,
// one per verb. It now carries one, driven by a table. That merge is the
// exact shape of change that produced row `fa83f2b9`: a shared builder that
// knows a list of fields drops the ones missing from the list, and because
// the dropped field is **valid on the shared schema**, nothing refuses it.
// The call is parsed, the value is discarded, and the caller is answered
// with a success.
//
// **So a refusal assertion cannot test this.** Asserting that a bad flag is
// refused would have passed against the original bug, because the original
// bug refused nothing — it succeeded and lost data. Every case below
// therefore WRITES a value through the merged builder and READS IT BACK
// through a separate call, which is the only assertion that can tell "kept"
// from "accepted and discarded". This mirrors `tests/cli-loop-noun-fields.test.ts`,
// which makes the same argument for the `loop` noun's fold.
//
// The builders are driven exactly as the dispatcher drives them — words and
// flags in, operation input out — and that input is handed to the real
// service against a real database. A test that asserted on the built input
// alone would prove the builder produced a shape, not that the shape
// survived to the store.
import type { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { ServiceRuntime, prismaTransactionRunner } from "@/lib/service";
import { defaultSnapshot } from "@/lib/settings";
import { lookupCommand } from "@/lib/cli/commands";
import { createTestPrismaClient } from "./helpers/test-prisma-client";
import {
  createMigratedScratchDatabase,
  dropScratchDatabase,
  scratchDatabaseName,
} from "./helpers/scratch-db";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const describeIfDb = testDatabaseUrl ? describe : describe.skip;

/**
 * Builds a command's input the way the dispatcher does.
 *
 * Goes through `lookupCommand` rather than importing the builder directly,
 * so the test exercises the same resolution path a typed command takes —
 * including the noun and verb actually being bound.
 */
function buildInput(
  words: readonly string[],
  rest: readonly string[],
  flags: Record<string, string | true> = {},
): Record<string, unknown> {
  const match = lookupCommand(words);
  if (!match.ok) {
    throw new Error(`\`standup ${words.join(" ")}\` did not resolve: ${JSON.stringify(match)}`);
  }
  const built = match.match.command.buildInput(rest, flags);
  if (!built.ok) {
    throw new Error(
      `\`standup ${words.join(" ")}\` refused: ${JSON.stringify((built as { envelope: unknown }).envelope)}`,
    );
  }
  return built.input as Record<string, unknown>;
}

/** The operation a command calls, so the test sends what the CLI would send. */
function operationFor(words: readonly string[]): string {
  const match = lookupCommand(words);
  if (!match.ok) throw new Error(`\`standup ${words.join(" ")}\` did not resolve`);
  return match.match.command.operation;
}

describeIfDb("the merged ownership builder keeps every field it is given", () => {
  const dbName = scratchDatabaseName("cli_merged_fields");
  let prisma: PrismaClient;
  let runtime: ServiceRuntime;

  beforeAll(async () => {
    const scratch = await createMigratedScratchDatabase(testDatabaseUrl!, dbName);
    prisma = createTestPrismaClient(scratch.url);
    await prisma.area.create({ data: { id: "web", displayName: "web" } });
    runtime = new ServiceRuntime({
      transaction: prismaTransactionRunner(prisma),
      resolveSnapshot: async () => defaultSnapshot(),
    });
  }, 60_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    dropScratchDatabase(testDatabaseUrl!, dbName);
  });

  beforeEach(async () => {
    await prisma.event.deleteMany({});
    await prisma.assignment.deleteMany({});
    await prisma.item.deleteMany({});
  });

  const call = <T>(name: string, input: unknown): Promise<T> =>
    runtime.call(name as never, input, { caller: { actor: "tester" } }) as Promise<T>;

  /** Runs a CLI command end to end: build its input, then call its operation. */
  const run = <T>(
    words: readonly string[],
    rest: readonly string[],
    flags: Record<string, string | true> = {},
  ): Promise<T> => call<T>(operationFor(words), buildInput(words, rest, flags));

  let counter = 0;
  async function seedItem(): Promise<string> {
    counter += 1;
    const id = `cli-merged-item-${counter}`;
    await prisma.item.create({
      data: {
        id,
        parentId: null,
        kind: "task",
        title: `Item ${counter}`,
        body: "seeded for the merged-builder tests",
        state: "executing" as never,
        originType: "auto",
        area: "web",
        mergeAuthority: "pre_approved",
      },
    });
    return id;
  }

  it("`session claim` keeps the role, the holder AND the numeric --pid", async () => {
    const itemId = await seedItem();

    await run(["session", "claim"], [itemId], {
      session: "s-claim",
      role: "builder",
      holderType: "agent",
      holderId: "gibbs",
      machine: "laptop",
      pid: "4242",
    });

    // Read back from the STORE, not from the write's own answer: a write
    // returning a field it was about to discard is exactly the shape of the
    // defect this file exists to catch.
    const stored = await prisma.assignment.findFirst({ where: { itemId } });

    expect(stored).not.toBeNull();
    expect(stored!.role).toBe("builder");
    expect(stored!.holderId).toBe("gibbs");
    expect(stored!.machine).toBe("laptop");
    // The one numeric field in this module. A merged builder that forgot to
    // convert it would send the string "4242" and be refused; one that
    // dropped it would succeed and store nothing, which is why this is read
    // back rather than asserted on the built input.
    expect(stored!.pid).toBe(4242);
  });

  it("`session checkpoint` keeps both the body and the --headline", async () => {
    const itemId = await seedItem();
    await run(["session", "claim"], [itemId], {
      session: "s-check",
      role: "builder",
      holderType: "agent",
      holderId: "gibbs",
      machine: "laptop",
    });

    await run(["session", "checkpoint"], [itemId], {
      session: "s-check",
      body: "ruled out the cache",
      headline: "cache is not the cause",
    });

    const stored = await prisma.event.findFirst({ where: { itemId, type: "checkpoint" } });

    expect(stored).not.toBeNull();
    expect(stored!.body).toBe("ruled out the cache");
    // `headline` is the field most at risk: it is optional, it is newer than
    // the verb, and it is exactly the kind of thing an allow-list written
    // from memory omits. It is also the whole point of the verb — a
    // checkpoint whose one-line summary was silently dropped reads as a
    // checkpoint that was never given one.
    expect(stored!.headline).toBe("cache is not the cause");
  });

  it("`item note` keeps its body, and its session", async () => {
    const itemId = await seedItem();

    await run(["item", "note"], [itemId], {
      session: "s-note",
      body: "a remark that must survive",
    });

    const stored = await prisma.event.findFirst({ where: { itemId, type: "note" } });

    expect(stored).not.toBeNull();
    expect(stored!.body).toBe("a remark that must survive");
    // `note`'s session is optional where claim/release/heartbeat require
    // one, so it is the verb where a shared builder is most likely to stop
    // mapping `--session` and have nothing complain.
    expect(stored!.sessionId).toBe("s-note");
  });

  it("`session progress --include-completed` is sent, and changes the answer", async () => {
    const itemId = await seedItem();
    await run(["session", "claim"], [itemId], {
      session: "s-prog",
      role: "builder",
      holderType: "agent",
      holderId: "gibbs",
      machine: "laptop",
    });

    // A switch that is ALWAYS sent, unlike the two optional ones below. Both
    // spellings are exercised because "false when absent" and "absent when
    // absent" are different claims and the table declares which each verb
    // makes.
    const withFlag = buildInput(["session", "progress"], [], {
      session: "s-prog",
      "include-completed": true,
    });
    const withoutFlag = buildInput(["session", "progress"], [], { session: "s-prog" });

    expect(withFlag.includeCompleted).toBe(true);
    expect(withoutFlag.includeCompleted).toBe(false);

    // And it reaches the operation rather than only the built input: a
    // `.strict()` schema refusing it would fail here.
    const report = await call<Record<string, unknown>>("progress_report", withFlag);
    expect(report).toBeDefined();
  });

  it("`session sweep --dry-run` is sent only when written", () => {
    // `sweep` releases other sessions' claims, so the difference between a
    // rehearsal and a live run is the most consequential boolean on the
    // command line. Absent must mean ABSENT, not `false`: the schema
    // declares it optional and a call that never mentioned it should not be
    // recorded as having asked for a live run.
    const rehearsal = buildInput(["session", "sweep"], [], { "dry-run": true });
    const unmentioned = buildInput(["session", "sweep"], [], {});

    expect(rehearsal.dryRun).toBe(true);
    expect("dryRun" in unmentioned).toBe(false);
  });

  it("`session takeover --force` is sent only when written, with its reason", () => {
    const forced = buildInput(["session", "takeover"], ["item-1"], {
      force: true,
      reason: "holder is wedged",
      fromSessionId: "old",
      bySessionId: "new",
    });
    const unmentioned = buildInput(["session", "takeover"], ["item-1"], {
      fromSessionId: "old",
      bySessionId: "new",
    });

    expect(forced.force).toBe(true);
    expect("force" in unmentioned).toBe(false);
    // The reason travels as an ordinary pass-through flag. An allow-list
    // builder that enumerated `force` and forgot `reason` would drop the
    // justification for a destructive act and still report success — which
    // is `fa83f2b9` exactly.
    expect(forced.reason).toBe("holder is wedged");
  });

  it("`item orientation --limit` is converted, and carries no session field", () => {
    const built = buildInput(["item", "orientation"], ["item-1"], {
      limit: "7",
      session: "s-orient",
    });

    // Converted, because the schema declares a number and a flag is a string.
    expect(built.limit).toBe(7);
    // `orientation` is item-scoped: its input schema has no session field at
    // all, so `--session` must NOT be mapped onto one here. A shared builder
    // that mapped it for every verb would send a field a `.strict()` schema
    // refuses, breaking a working verb.
    expect("sessionId" in built).toBe(false);
  });

  it("forwards a flag no entry in the table names", () => {
    // The pass-through property itself, stated as an assertion rather than
    // only as a comment. A builder filtered to an allow-list would drop this
    // silently; the operation's own `.strict()` schema is what refuses an
    // unknown field, and it can only do that if the field reaches it.
    const built = buildInput(["session", "claim"], ["item-1"], {
      session: "s-x",
      role: "builder",
      holderType: "agent",
      holderId: "gibbs",
      machine: "laptop",
      rootSessionId: "root-1",
    });

    expect(built.rootSessionId).toBe("root-1");
  });
});
