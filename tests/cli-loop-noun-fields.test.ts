// The merged `loop` CLI builder keeps every field, against Postgres.
//
// ── Why this file exists, and why it is shaped this way ───────────────
//
// `src/lib/cli/commands-loops.ts` used to carry six `buildInput` functions,
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
// from "accepted and discarded". This mirrors `tests/tool-folds.test.ts:187`,
// which makes the same argument for the MCP-side fold.
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
import type { LoopGetOutput, LoopListOutput } from "@/lib/service/operations/loop-reads";
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

describeIfDb("the merged loop builder keeps every field it is given", () => {
  const dbName = scratchDatabaseName("cli_loop_fields");
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
    const id = `cli-loop-item-${counter}`;
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

  async function addLoop(itemId: string, text: string): Promise<string> {
    const added = await run<{ loopId: string }>(["loop", "add"], [itemId, ...text.split(" ")]);
    expect(added.loopId).toBeTruthy();
    return added.loopId;
  }

  // ── The `fa83f2b9` case itself ───────────────────────────────────────

  it("keeps --reason on close, and reports it back", async () => {
    const itemId = await seedItem();
    const loopId = await addLoop(itemId, "a loose end that will be resolved");

    await run(["loop", "close"], [itemId, loopId], {
      reason: "resolved by the capture-path fix, which made the retry unnecessary",
    });

    const afterClose = await run<LoopGetOutput>(["loop", "get"], [itemId, loopId]);
    expect(afterClose.status).toBe("closed");
    // Breaks the moment the merged builder stops forwarding `reason` — which
    // is precisely what an allow-list of known field names would do, and
    // which no refusal assertion would notice, because `reason` is valid on
    // the shared schema and so is never refused.
    expect(afterClose.closedReason).toBe(
      "resolved by the capture-path fix, which made the retry unnecessary",
    );
  });

  it("keeps --reason on delete, which the operation refuses without", async () => {
    const itemId = await seedItem();
    const loopId = await addLoop(itemId, "recorded by accident");

    await run(["loop", "delete"], [itemId, loopId], { reason: "duplicate of an earlier loop" });

    const listed = await run<LoopListOutput>(["loop", "list"], [itemId], { deleted: true });
    const deleted = listed.loops.find((loop) => loop.loopId === loopId);
    expect(deleted?.status).toBe("deleted");
  });

  // ── The other distinguishing fields, one per verb ────────────────────

  it("keeps --kind on add, rather than letting the default overwrite it", async () => {
    const itemId = await seedItem();
    const added = await run<{ loopId: string }>(
      ["loop", "add"],
      [itemId, "a", "reference", "worth", "keeping"],
      { kind: "note" },
    );

    const got = await run<LoopGetOutput>(["loop", "get"], [itemId, added.loopId]);
    // `add` defaults `kind` to `work`. A builder that dropped `--kind` would
    // produce `work` here and look entirely healthy.
    expect(got.kind).toBe("note");
  });

  it("keeps the text on edit, and leaves the kind alone when it is not restated", async () => {
    const itemId = await seedItem();
    const added = await run<{ loopId: string }>(["loop", "add"], [itemId, "a", "note"], {
      kind: "note",
    });

    await run(["loop", "edit"], [itemId, added.loopId, "a", "note,", "reworded"]);

    const afterEdit = await run<LoopGetOutput>(["loop", "get"], [itemId, added.loopId]);
    expect(afterEdit.text).toBe("a note, reworded");
    // The asymmetry the fold has to preserve: `add` defaults an absent kind
    // to `work`, `edit` means "leave this as it is". A merged builder that
    // applied add's rule to edit would silently retype this note to work.
    expect(afterEdit.kind).toBe("note");
  });

  it("keeps each of the three list switches, which change what comes back", async () => {
    const itemId = await seedItem();
    const open = await addLoop(itemId, "still outstanding");
    const closed = await addLoop(itemId, "already done");
    await run(["loop", "close"], [itemId, closed], { reason: "finished" });
    const note = await run<{ loopId: string }>(["loop", "add"], [itemId, "just", "a", "note"], {
      kind: "note",
    });

    const byDefault = await run<LoopListOutput>(["loop", "list"], [itemId]);
    const defaultIds = byDefault.loops.map((loop) => loop.loopId);
    expect(defaultIds).toContain(open);
    expect(defaultIds).not.toContain(closed);
    expect(defaultIds).not.toContain(note.loopId);

    // Each switch is read as a bare switch and mapped onto a differently
    // named schema field, so dropping any one of them changes this result.
    const withAll = await run<LoopListOutput>(["loop", "list"], [itemId], { all: true });
    expect(withAll.loops.map((loop) => loop.loopId)).toContain(closed);

    const withNotes = await run<LoopListOutput>(["loop", "list"], [itemId], { notes: true });
    expect(withNotes.loops.map((loop) => loop.loopId)).toContain(note.loopId);
  });

  // ── The invariant itself, asserted directly ──────────────────────────

  it("sends an unknown value flag to the operation, which refuses it by schema", async () => {
    const itemId = await seedItem();
    const loopId = await addLoop(itemId, "a loose end");

    // The positive proof that pass-through was preserved rather than
    // replaced by an allow-list. An allow-list would DROP this flag, the
    // call would succeed, and this test would fail — which is the point: it
    // distinguishes "forwarded and refused" from "silently discarded".
    const input = buildInput(["loop", "close"], [itemId, loopId], {
      "not-a-real-field": "forwarded anyway",
    });
    expect(input["not-a-real-field"]).toBe("forwarded anyway");

    await expect(call(operationFor(["loop", "close"]), input)).rejects.toMatchObject({
      code: "invalid_input",
    });
  });

  // ── Both spellings resolve to the same implementation ────────────────

  it("gives `item loop-close` the identical behaviour to `loop close`", async () => {
    const itemId = await seedItem();
    const loopId = await addLoop(itemId, "closed through the item spelling");

    await run(["item", "loop-close"], [itemId, loopId], { reason: "closed via item loop-close" });

    const afterClose = await run<LoopGetOutput>(["item", "loop-get"], [itemId, loopId]);
    expect(afterClose.status).toBe("closed");
    expect(afterClose.closedReason).toBe("closed via item loop-close");
  });

  it("builds byte-identical input from both spellings of every verb", () => {
    // The two spellings share one builder and name one operation, so this
    // cannot drift — and asserting it is what makes that a fact rather than
    // an intention.
    const pairs: readonly (readonly [readonly string[], readonly string[]])[] = [
      [
        ["loop", "add"],
        ["item", "loop"],
      ],
      [
        ["loop", "close"],
        ["item", "loop-close"],
      ],
      [
        ["loop", "list"],
        ["item", "loops"],
      ],
      [
        ["loop", "get"],
        ["item", "loop-get"],
      ],
      [
        ["loop", "edit"],
        ["item", "loop-edit"],
      ],
      [
        ["loop", "delete"],
        ["item", "loop-delete"],
      ],
    ];
    for (const [next, old] of pairs) {
      const rest = ["item-1", "loop-1", "some", "words"];
      const flags = { reason: "a reason", kind: "note" } as const;
      expect(buildInput(next, rest, flags), `${old.join(" ")} vs ${next.join(" ")}`).toEqual(
        buildInput(old, rest, flags),
      );
      expect(operationFor(next)).toBe(operationFor(old));
    }
  });
});
