// `get_item_artifacts` against a real Postgres.
//
// **Why a real database.** The central claim of this whole change is a
// claim about two calls made against the *same* oversized item: that
// `get_item_detail` is refused for size and `get_item_artifacts` returns
// anyway. That is only meaningful if the size is real — a stub returning
// canned rows would let both assertions pass while proving nothing about
// either the guard or the query. The keyset cursor is the same: whether it
// walks an append-only table without repeating or skipping a row is a
// property of `seq DESC` and the `seq < cursor` predicate against actual
// Postgres.
//
// The slim-column assertions are here for the reason `get_item_history`'s
// suite gives for its own: the handler builds the slim object field by
// field, so a query that selected `body` and `findings` anyway would return
// exactly the right shape while paying the full transfer cost. Asserting
// only on the response cannot see that, so the column list is asserted too.
//
// Skips without TEST_DATABASE_URL, like every other DB-backed file here.
import type { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ServiceRuntime, prismaTransactionRunner } from "@/lib/service";
import { defaultSnapshot } from "@/lib/settings";
import {
  createMigratedScratchDatabase,
  dropScratchDatabase,
  scratchDatabaseName,
} from "./helpers/scratch-db";
import {
  SLIM_ARTIFACT_COLUMNS,
  FULL_ARTIFACT_COLUMNS,
  ARTIFACT_BODY_PREVIEW_CHARS,
  type GetItemArtifactsOutput,
  type ItemArtifactFull,
} from "@/lib/service/operations/get-item-artifacts";
import { createTestPrismaClient } from "./helpers/test-prisma-client";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const describeIfDb = testDatabaseUrl ? describe : describe.skip;

describeIfDb("get_item_artifacts against Postgres", () => {
  const dbName = scratchDatabaseName("item_artifacts");
  let scratchUrl: string;
  let prisma: PrismaClient;
  let runtime: ServiceRuntime;

  beforeAll(async () => {
    scratchUrl = (await createMigratedScratchDatabase(testDatabaseUrl!, dbName)).url;
    prisma = createTestPrismaClient(scratchUrl);
    runtime = new ServiceRuntime({
      transaction: prismaTransactionRunner(prisma),
      resolveSnapshot: async () => defaultSnapshot(),
    });
  }, 60_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await dropScratchDatabase(testDatabaseUrl!, dbName);
  });

  async function createItem(overrides: Record<string, unknown> = {}): Promise<{ id: string }> {
    return runtime.call("create_item", {
      title: "x",
      body: "x",
      area: "artifact-tests",
      originType: "auto",
      ...overrides,
    }) as Promise<{ id: string }>;
  }

  async function addArtifact(
    itemId: string,
    overrides: Record<string, unknown> = {},
  ): Promise<{ id: string }> {
    return runtime.call("record_artifact", {
      itemId,
      kind: "plan",
      body: "a plan",
      createdByType: "agent",
      createdById: "tester",
      ...overrides,
    }) as Promise<{ id: string }>;
  }

  async function artifactsOf(input: Record<string, unknown>): Promise<GetItemArtifactsOutput> {
    return (await runtime.call("get_item_artifacts", input)) as GetItemArtifactsOutput;
  }

  /**
   * An item whose artifacts alone put `get_item_detail` past the guard.
   *
   * Six bodies of 40,000 characters is ~240,000 of payload, and the MCP
   * surface counts two wire copies, so this clears the 200,000 ceiling with
   * a wide margin rather than sitting on it — a test that depended on the
   * exact constant would start passing for the wrong reason the moment any
   * unrelated field was added to the response.
   */
  async function createOversizedItem(): Promise<string> {
    const { id } = await createItem({ title: "oversized" });
    for (let index = 0; index < 6; index++) {
      await addArtifact(id, { body: `${index}`.repeat(40_000) });
    }
    return id;
  }

  /** The MCP surface, which is the one the reporters were refused on. */
  const asMcp = { caller: { transport: "mcp-http" } };

  it("returns an oversized item's artifacts when get_item_detail is refused for size", async () => {
    const itemId = await createOversizedItem();

    // The refusal half. Without this the recovery half proves nothing: a
    // test that only showed `get_item_artifacts` returning would pass just
    // as well on an item small enough for `get_item_detail` to handle,
    // which is not the situation anyone reported.
    await expect(runtime.call("get_item_detail", { id: itemId }, asMcp)).rejects.toThrow(
      /over the 200,000-character limit/,
    );

    // The recovery half, on the same item, through the same surface.
    const page = await artifactsOf({ id: itemId });
    expect(page.artifacts).toHaveLength(6);
    expect(page.total).toBe(6);

    // And it is genuinely readable through MCP, not merely constructible in
    // process — the guard is what refused the other call, so it has to be
    // shown *not* refusing this one on the same surface.
    const throughMcp = (await runtime.call(
      "get_item_artifacts",
      { id: itemId },
      asMcp,
    )) as GetItemArtifactsOutput;
    expect(throughMcp.artifacts).toHaveLength(6);

    // The bodies are what made the other call too large, so the slim shape
    // must not be carrying them.
    for (const artifact of throughMcp.artifacts) {
      expect(artifact).not.toHaveProperty("body");
      expect(artifact.bodyChars).toBe(40_000);
      expect(artifact.bodyTruncated).toBe(true);
      expect(artifact.bodyPreview).toHaveLength(ARTIFACT_BODY_PREVIEW_CHARS);
    }

    // And the caller can still reach any one of them in full, which is the
    // case the builder who lost a spec actually needed.
    const one = await artifactsOf({ id: itemId, artifactId: throughMcp.artifacts[0]!.id });
    expect((one.artifacts[0] as ItemArtifactFull).body).toHaveLength(40_000);
  });

  it("omits body and findings by default and returns them under full", async () => {
    const { id } = await createItem();
    await addArtifact(id, {
      kind: "code_review",
      verdict: "lgtm",
      body: "b".repeat(500),
      findings: [{ text: "a finding", severity: "low" }],
    });

    const slim = await artifactsOf({ id });
    const slimRow = slim.artifacts[0]!;
    expect(slimRow).not.toHaveProperty("body");
    expect(slimRow).not.toHaveProperty("findings");
    expect(slimRow.bodyPreview).toBe("b".repeat(ARTIFACT_BODY_PREVIEW_CHARS));
    expect(slimRow.bodyTruncated).toBe(true);
    expect(slimRow.bodyChars).toBe(500);

    const full = await artifactsOf({ id, full: true });
    const fullRow = full.artifacts[0] as ItemArtifactFull;
    expect(fullRow.body).toBe("b".repeat(500));
    expect(fullRow.findings).toEqual([{ text: "a finding", severity: "low" }]);
  });

  // Asserted against the query text rather than the response, because the
  // response cannot distinguish "did not select the heavy columns" from
  // "selected them and dropped them on the way out" — and only the first
  // one actually costs nothing.
  it("does not ask Postgres for the unbounded columns in the slim shape", () => {
    // `"body"` does appear in the slim list, but only ever wrapped in a
    // function that reduces it — `length("body")` and `left("body", 200)`.
    // What must not appear is a bare selection of the column, which is the
    // thing that would transfer all 40,000 characters. So the assertion is
    // written against the column list with those two wrappers removed,
    // rather than against the raw string: a naive /"body"/ match would fail
    // on the correct implementation, and dropping the assertion to make it
    // pass would have removed the only check that catches the real mistake.
    const slimWithoutWrappedBody = SLIM_ARTIFACT_COLUMNS.replace(
      /(?:length|left)\("body"(?:, \d+)?\)/g,
      "",
    );
    expect(slimWithoutWrappedBody).not.toMatch(/"body"/);
    expect(SLIM_ARTIFACT_COLUMNS).not.toMatch(/"findings"/);
    // The preview and the length are computed server-side; sending the body
    // here to measure or slice it in JS would defeat the slim shape while
    // leaving every response assertion above still passing.
    expect(SLIM_ARTIFACT_COLUMNS).toMatch(/length\("body"\)/);
    expect(SLIM_ARTIFACT_COLUMNS).toMatch(/left\("body", 200\)/);
    expect(FULL_ARTIFACT_COLUMNS).toMatch(/"body"/);
    expect(FULL_ARTIFACT_COLUMNS).toMatch(/"findings"/);
  });

  it("returns one artifact in full by id, and refuses an id from another item", async () => {
    const { id } = await createItem();
    const { id: otherItem } = await createItem();
    const artifact = await addArtifact(id, { body: "the spec I lost" });
    const foreign = await addArtifact(otherItem, { body: "someone else's" });

    const found = await artifactsOf({ id, artifactId: artifact.id });
    expect(found.artifacts).toHaveLength(1);
    expect((found.artifacts[0] as ItemArtifactFull).body).toBe("the spec I lost");
    expect(found.nextCursor).toBeNull();

    // Scoped to the item, so an id pasted from elsewhere does not read across.
    await expect(artifactsOf({ id, artifactId: foreign.id })).rejects.toThrow(/No such artifact/);
  });

  it("filters by kind, newest first", async () => {
    const { id } = await createItem();
    await addArtifact(id, { kind: "plan", body: "plan one" });
    await addArtifact(id, { kind: "code_review", verdict: "changes_required", body: "review one" });
    await addArtifact(id, { kind: "plan", body: "plan two" });
    await addArtifact(id, { kind: "code_review", verdict: "lgtm", body: "review two" });

    const reviews = await artifactsOf({ id, kind: "code_review" });
    expect(reviews.artifacts.map((a) => a.kind)).toEqual(["code_review", "code_review"]);
    // Newest first is the whole point of the ordering: a reviewer asking for
    // "the latest code_review" reads index 0. Reverse the ORDER BY and this
    // is the assertion that fails.
    expect(reviews.artifacts[0]!.verdict).toBe("lgtm");
    expect(reviews.artifacts[1]!.verdict).toBe("changes_required");
    // `total` counts the filtered set, not the item, or "page 2 of N" lies.
    expect(reviews.total).toBe(2);

    const all = await artifactsOf({ id });
    expect(all.total).toBe(4);
  });

  it("pages with a keyset cursor, visiting every artifact exactly once", async () => {
    const { id } = await createItem();
    for (let index = 0; index < 7; index++) {
      await addArtifact(id, { body: `artifact-${index}` });
    }

    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page: GetItemArtifactsOutput = await artifactsOf({
        id,
        limit: 3,
        ...(cursor ? { cursor } : {}),
      });
      seen.push(...page.artifacts.map((a) => a.id));
      cursor = page.nextCursor;
      pages++;
      expect(pages).toBeLessThan(10);
    } while (cursor !== null);

    expect(seen).toHaveLength(7);
    expect(new Set(seen).size).toBe(7);
  });

  it("refuses an unknown item rather than returning an empty list", async () => {
    // An empty list would read exactly like a real item nobody has recorded
    // anything against, which is the ambiguity `get_item_history` documents
    // at length and refuses for the same reason.
    await expect(artifactsOf({ id: "00000000-0000-4000-8000-000000000000" })).rejects.toThrow(
      /No such item/,
    );
  });

  it("rejects a non-numeric cursor as caller error", async () => {
    const { id } = await createItem();
    await expect(artifactsOf({ id, cursor: "not-a-number" })).rejects.toThrow(/cursor/);
  });
});
