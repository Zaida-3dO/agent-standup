// `get_item`'s three stated depths, and the one that must not have moved.
//
// ── What this file is guarding ──────────────────────────────────────────
//
// `full` became `boolean | "item" | "detail"` so that `get_item_detail`
// could fold into it. The interesting risk in that change is not the new
// depth — a new value that returns the wrong thing fails loudly the first
// time anyone uses it. It is `full: true`, which is spoken by agent
// definitions, by prose, by the command line, and by `response-size.ts`,
// which prescribes `get_item` as the narrower call when the detail read is
// refused for size. Quietly widening `true` from the item row to the detail
// wrapper would make that escape hatch inherit the failure it escapes —
// a caller refused for size, told to fall back here, and refused again.
//
// So the load-bearing assertion in this file is the dullest one: **`full:
// true` still returns the bare `ItemRecord`, with no wrapper key on it.**
// It is written as an assertion about ABSENCE (`item`, `subtasks`,
// `artifacts` and the rest are not properties of the response) because a
// presence assertion is satisfied by the wrapper too — the wrapper contains
// an `ItemRecord` at `.item`, so "has a `body`" is true of both shapes and
// proves nothing. That is the same reasoning `slim-item-reads.test.ts`
// gives for its own absence assertions.
//
// ── The mutations this file was checked against ─────────────────────────
//
//   - make `full: true` return the detail wrapper (i.e. treat `true` as
//     `"detail"`) → "full: true still returns the bare item row" fails.
//   - make `"item"` and `true` take different paths → the synonym test
//     fails.
//   - drop the misplaced-limit refusal and forward the limits regardless →
//     the two refusal tests fail by name.
//   - forward `historyLimit` to the delegate under a different name → the
//     bounded-detail test fails, because the artifact count stops
//     responding to it.
//
// Skips without TEST_DATABASE_URL, like every other DB-backed file here.
import type { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ServiceRuntime, prismaTransactionRunner } from "@/lib/service";
import { defaultSnapshot } from "@/lib/settings";
import { depthOf } from "@/lib/service/operations/get-item";
import {
  createMigratedScratchDatabase,
  dropScratchDatabase,
  scratchDatabaseName,
} from "./helpers/scratch-db";
import { createTestPrismaClient } from "./helpers/test-prisma-client";
import { COMMANDS } from "@/lib/cli/commands";
import { getOperation } from "@/lib/service/registry";

/** A refusal, as a caught value carries it. */
type Refusal = { code?: string; fields?: string[] };

/**
 * The refusal a call raised — failing if it did not raise one.
 *
 * Written as a helper rather than a `.catch()` at each site because the
 * obvious shape of that, `.then(() => ({}))`, turns "the call SUCCEEDED
 * when it should have been refused" into an empty object whose `code` is
 * `undefined` — and an assertion that `undefined` is not `"invalid_input"`
 * passes. A test for a refusal that goes green when nothing is refused is
 * the exact hollowness this PR is about, so the success path throws here.
 */
async function refusalFrom(call: Promise<unknown>): Promise<Refusal> {
  try {
    await call;
  } catch (thrown) {
    return thrown as Refusal;
  }
  throw new Error("the call was expected to be refused and succeeded instead");
}

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const describeIfDb = testDatabaseUrl ? describe : describe.skip;

/**
 * The keys `get_item_detail` wraps its item in.
 *
 * Named here so the bare-row assertions can say "none of these", which is
 * what makes them fail if `true` ever starts returning the wrapper. Taken
 * from `ItemDetailOutput`'s declaration rather than invented.
 */
const WRAPPER_KEYS = [
  "item",
  "column",
  "subtasks",
  "artifacts",
  "history",
  "artifactsTruncated",
  "historyTruncated",
  "summary",
  "buildStatus",
  "assignments",
  "previousHolders",
] as const;

describe("depthOf — the boolean and the names are one vocabulary", () => {
  // A pure function, so this needs no database and runs everywhere. It is
  // the cheapest possible statement of the compatibility promise: `true`
  // and `"item"` do not merely agree — they normalise to the same value
  // before the handler ever branches, so there is no second path that could
  // drift from the first.
  it("maps false to the summary and true to the item row", () => {
    expect(depthOf(false)).toBe("summary");
    expect(depthOf(true)).toBe("item");
  });

  it('makes "item" an exact synonym of true, and "detail" its own depth', () => {
    expect(depthOf("item")).toBe(depthOf(true));
    expect(depthOf("detail")).toBe("detail");
    // ...and the two are genuinely different, so the assertion above is not
    // satisfied by everything collapsing to one value.
    expect(depthOf("detail")).not.toBe(depthOf(true));
  });
});

describeIfDb("get_item at a stated depth, against Postgres", () => {
  const dbName = scratchDatabaseName("get_item_depth");
  let prisma: PrismaClient;
  let runtime: ServiceRuntime;
  let scratchUrl: string | undefined;

  beforeAll(async () => {
    scratchUrl = (await createMigratedScratchDatabase(testDatabaseUrl!, dbName)).url;
    prisma = createTestPrismaClient(scratchUrl);
    runtime = new ServiceRuntime({
      transaction: prismaTransactionRunner(prisma),
      resolveSnapshot: async () => defaultSnapshot(),
    });
  }, 120_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    if (scratchUrl) await dropScratchDatabase(testDatabaseUrl!, dbName);
  });

  async function makeItem() {
    return (await runtime.call("create_item", {
      title: "An item read at three depths",
      headline: "One line",
      body: "b".repeat(2_000),
      area: "get-item-depth",
      originType: "auto",
    })) as unknown as { id: string };
  }

  it("full: true still returns the bare item row — the regression pin", async () => {
    // **The reason this file exists.** Asserted as absence, because the
    // detail wrapper CONTAINS an `ItemRecord` at `.item` built by the same
    // `toItemRecord` — so every "has a body", "has an id", "has a title"
    // assertion is true of the wrapper too and would not notice the change.
    const created = await makeItem();
    const read = (await runtime.call("get_item", {
      id: created.id,
      full: true,
    })) as unknown as Record<string, unknown>;

    expect(read.id).toBe(created.id);
    expect(read.body).toHaveLength(2_000);
    for (const key of WRAPPER_KEYS) {
      expect(
        read,
        `full: true returned the detail wrapper — it must return the bare row`,
      ).not.toHaveProperty(key);
    }
  });

  it('full: "item" returns exactly what full: true returns', async () => {
    // Compared as whole payloads rather than field by field: a synonym that
    // agreed on the fields a test happened to name and differed elsewhere
    // would not be a synonym, and naming fields is how that goes unnoticed.
    const created = await makeItem();
    const byBoolean = await runtime.call("get_item", { id: created.id, full: true });
    const byName = await runtime.call("get_item", { id: created.id, full: "item" });
    expect(byName).toEqual(byBoolean);
  });

  it('full: "detail" returns the detail wrapper, with the item inside it', async () => {
    const created = await makeItem();
    const read = (await runtime.call("get_item", {
      id: created.id,
      full: "detail",
    })) as unknown as Record<string, unknown>;

    for (const key of WRAPPER_KEYS) {
      expect(read).toHaveProperty(key);
    }
    // The fold's central claim — no data is lost — is that the wrapper
    // contains the flag's output at a known key, from the same builder. So
    // the item inside it must equal what the shallower depth returns.
    const bare = await runtime.call("get_item", { id: created.id, full: true });
    expect(read.item).toEqual(bare);
  });

  it('full: "detail" returns what get_item_detail returns, field for field', async () => {
    // The fold is a dispatch, not a reimplementation: the delegate runs in
    // the same `ctx` and its output is returned unedited. Comparing the two
    // whole payloads is what makes that checkable rather than asserted —
    // a second implementation that agreed on the keys but differed on a
    // value fails here.
    const created = await makeItem();
    const folded = await runtime.call("get_item", { id: created.id, full: "detail" });
    const direct = await runtime.call("get_item_detail", { id: created.id });
    expect(folded).toEqual(direct);
  });

  it("forwards the two limits to the detail read", async () => {
    // Observed through behaviour rather than through a spy: the delegate's
    // truncation flag is what the limit controls, so a limit that did not
    // arrive leaves it false. The item is given more history than the limit
    // allows, so the flag has something to report.
    const created = await makeItem();
    for (let i = 0; i < 3; i += 1) {
      await runtime.call("note", { itemId: created.id, body: `note ${i}` });
    }

    const bounded = (await runtime.call("get_item", {
      id: created.id,
      full: "detail",
      historyLimit: 1,
    })) as unknown as { history: unknown[]; historyTruncated: boolean };

    expect(bounded.history).toHaveLength(1);
    expect(bounded.historyTruncated).toBe(true);

    // ...and without the limit it is not truncated, so the assertion above
    // is about the limit rather than about this item always truncating.
    const unbounded = (await runtime.call("get_item", {
      id: created.id,
      full: "detail",
    })) as unknown as { historyTruncated: boolean };
    expect(unbounded.historyTruncated).toBe(false);
  });

  it("refuses a limit sent at a depth that cannot use it, naming the field", async () => {
    // Refused rather than ignored. A dropped bound would return a shape the
    // caller did not ask for while reporting success, which is the silent
    // half of the `fa83f2b9` class — and a refusal that did not name the
    // field would leave them guessing which of the two was wrong.
    const created = await makeItem();

    for (const field of ["historyLimit", "artifactLimit"] as const) {
      const error = await refusalFrom(
        runtime.call("get_item", { id: created.id, full: true, [field]: 5 }),
      );
      expect(error.code, `${field} at full: true should be refused`).toBe("invalid_input");
      expect(error.fields).toContain(field);
    }

    // The default depth too, not just the item row — the same mistake is
    // likelier there, since `full` is absent entirely.
    const onSummary = await refusalFrom(
      runtime.call("get_item", { id: created.id, artifactLimit: 5 }),
    );
    expect(onSummary.code).toBe("invalid_input");
    expect(onSummary.fields).toContain("artifactLimit");
  });

  it("accepts both limits together at the detail depth", async () => {
    // The complement of the refusals above, so those cannot pass by the
    // fields being rejected everywhere.
    const created = await makeItem();
    const read = await runtime.call("get_item", {
      id: created.id,
      full: "detail",
      historyLimit: 5,
      artifactLimit: 5,
    });
    expect(read).toHaveProperty("item");
  });

  it("refuses a depth it does not have", async () => {
    const created = await makeItem();
    const error = await refusalFrom(
      runtime.call("get_item", { id: created.id, full: "everything" }),
    );
    expect(error.code).toBe("invalid_input");
    expect(error.fields).toContain("full");
  });
});

describe("the command line's two depth switches", () => {
  // Built by the REAL builder and parsed by the REAL schema, rather than
  // compared to a literal written here. A literal agrees with a builder
  // that is wrong in the same way, which is how a fold's field rename once
  // reached production with three green checks; the operation's own
  // `.strict()` parse is the only thing that cannot agree with a mistake.
  const spec = COMMANDS.find((command) => command.noun === "item" && command.verb === "get");

  function build(flags: Record<string, string | true>): Record<string, unknown> {
    const result = spec!.buildInput(["item-1"], flags);
    if (!result.ok) throw new Error(`refused: ${JSON.stringify(result.envelope)}`);
    return result.input as Record<string, unknown>;
  }

  function parses(input: unknown): boolean {
    const operation = getOperation("get_item") as unknown as {
      input: { safeParse: (value: unknown) => { success: boolean } };
    };
    return operation.input.safeParse(input).success;
  }

  it("is a registered command", () => {
    expect(spec).toBeDefined();
  });

  it("sends the item row for --full and the detail payload for --detail", () => {
    // The depths are asserted as VALUES the schema accepts, so a builder
    // that produced a plausible-looking but unparseable `full` fails here.
    const bare = build({});
    const item = build({ full: true });
    const detail = build({ detail: true });

    expect(bare.full).toBe(false);
    expect(item.full).toBe(true);
    expect(detail.full).toBe("detail");

    for (const input of [bare, item, detail]) {
      expect(parses(input), `get_item refused ${JSON.stringify(input)}`).toBe(true);
    }
  });

  it("refuses the two switches together, naming both", () => {
    // Which one won would be a coin-flip the person could not predict from
    // the command they typed, so neither does.
    const result = spec!.buildInput(["item-1"], { full: true, detail: true });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.envelope.error.fields).toEqual(expect.arrayContaining(["full", "detail"]));
  });

  it("refuses a value on either switch, which is why the depth needs two flags", () => {
    // The mechanism that rules out `--full detail` as a spelling, asserted
    // rather than described: the boolean flag path refuses a value, so a
    // single `--full` cannot carry three depths.
    const valued: Record<string, string | true>[] = [{ full: "detail" }, { detail: "true" }];
    for (const flags of valued) {
      const result = spec!.buildInput(["item-1"], flags);
      expect(result.ok, `${JSON.stringify(flags)} should be refused`).toBe(false);
    }
  });
});
