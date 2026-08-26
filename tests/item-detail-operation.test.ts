// `get_item_detail` against a real Postgres — MILESTONES.md #72.
//
// A real database is needed because the subtask tree is a recursive query
// whose depth-first ordering and unbounded nesting an in-memory model of
// Postgres cannot prove, and because artifacts, events and summaries are
// read from three tables this operation joins nothing across — the shapes
// only exist once rows do. Same harness as tests/board-operations.test.ts.
//
// Skips without TEST_DATABASE_URL, like every other DB-backed file here.
import { PrismaClient } from "@prisma/client";
import { Client as PgClient } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ServiceRuntime, prismaTransactionRunner } from "@/lib/service";
import { defaultSnapshot } from "@/lib/settings";
import {
  createMigratedScratchDatabase,
  dropScratchDatabase,
  scratchDatabaseName,
} from "./helpers/scratch-db";
import { registerSessions } from "./helpers/register-sessions";
import type { ItemDetailOutput } from "@/lib/service/operations/get-item-detail";
import { openLoops } from "@/lib/item-detail/status";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const describeIfDb = testDatabaseUrl ? describe : describe.skip;

// The rule deciding where a **project** sits is `columnForProject`
// (`service/board/columns.ts`), which this operation calls rather than
// reimplementing — its own header exists to keep that mapping in one place,
// and the detail view must not disagree with the board about the same
// project. It is exercised directly in `tests/board-columns.test.ts`; the
// assertion that matters here is that this operation actually applies it,
// which the "derives a project's from its children" case below makes
// against a real database.
describeIfDb("get_item_detail against Postgres", () => {
  const dbName = scratchDatabaseName("item_detail");
  let scratchUrl: string;
  let prisma: PrismaClient;
  let runtime: ServiceRuntime;

  beforeAll(async () => {
    scratchUrl = (await createMigratedScratchDatabase(testDatabaseUrl!, dbName)).url;
    prisma = new PrismaClient({ datasourceUrl: scratchUrl });
    runtime = new ServiceRuntime({
      transaction: prismaTransactionRunner(prisma),
      resolveSnapshot: async () => defaultSnapshot(),
    });
  }, 60_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    await dropScratchDatabase(testDatabaseUrl!, dbName);
  });

  async function createItem(
    overrides: Record<string, unknown>,
  ): Promise<{ id: string; state: string }> {
    return runtime.call("create_item", {
      title: "x",
      body: "x",
      area: "detail-tests",
      originType: "auto",
      ...overrides,
    }) as Promise<{ id: string; state: string }>;
  }

  async function setState(id: string, state: string): Promise<void> {
    await prisma.$executeRawUnsafe(
      `UPDATE "Item" SET "state" = $1::"ItemState" WHERE "id" = $2`,
      state,
      id,
    );
  }

  async function detailOf(id: string, input: Record<string, unknown> = {}) {
    return (await runtime.call("get_item_detail", { id, ...input })) as ItemDetailOutput;
  }

  describe("the item itself", () => {
    it("refuses an id that does not exist rather than returning an empty detail", async () => {
      await expect(detailOf("no-such-item")).rejects.toThrow(/No such item/);
    });

    it("returns the item it was asked for", async () => {
      const project = await createItem({ area: "detail-item" });
      const task = await createItem({
        area: "detail-item",
        parentId: project.id,
        title: "The task",
      });
      const detail = await detailOf(task.id);
      expect(detail.item.id).toBe(task.id);
      expect(detail.item.title).toBe("The task");
    });
  });

  describe("the subtask tree", () => {
    it("is empty for a leaf, and the root is never in its own tree", async () => {
      const project = await createItem({ area: "detail-leaf" });
      const task = await createItem({ area: "detail-leaf", parentId: project.id });
      const detail = await detailOf(task.id);
      expect(detail.subtasks).toEqual([]);
    });

    it("walks the WHOLE subtree, not just direct children", async () => {
      // The behaviour that distinguishes this operation from `orientation`,
      // which reads one level. Nesting is unbounded (SCHEMA.md §1), so a
      // grandchild must appear.
      const project = await createItem({ area: "detail-deep" });
      const child = await createItem({
        area: "detail-deep",
        parentId: project.id,
        title: "child",
      });
      const grandchild = await createItem({
        area: "detail-deep",
        parentId: child.id,
        title: "grandchild",
      });
      const greatGrandchild = await createItem({
        area: "detail-deep",
        parentId: grandchild.id,
        title: "great-grandchild",
      });

      const detail = await detailOf(project.id);
      const ids = detail.subtasks.map((s) => s.id);
      expect(ids).toContain(child.id);
      expect(ids).toContain(grandchild.id);
      expect(ids).toContain(greatGrandchild.id);
    });

    it("reports each node's depth from the root", async () => {
      const project = await createItem({ area: "detail-depth" });
      const child = await createItem({ area: "detail-depth", parentId: project.id });
      const grandchild = await createItem({ area: "detail-depth", parentId: child.id });

      const detail = await detailOf(project.id);
      const byId = new Map(detail.subtasks.map((s) => [s.id, s.depth]));
      expect(byId.get(child.id)).toBe(1);
      expect(byId.get(grandchild.id)).toBe(2);
    });

    it("orders depth-first — a child follows its own parent, not the next sibling", async () => {
      // The bug an `ORDER BY depth` would introduce: both branches'
      // children would be listed together, away from their parents, so the
      // indent would show a tree the order contradicts.
      const project = await createItem({ area: "detail-order" });
      const first = await createItem({
        area: "detail-order",
        parentId: project.id,
        title: "first",
      });
      const firstChild = await createItem({
        area: "detail-order",
        parentId: first.id,
        title: "first-child",
      });
      const second = await createItem({
        area: "detail-order",
        parentId: project.id,
        title: "second",
      });

      const detail = await detailOf(project.id);
      const titles = detail.subtasks.map((s) => s.title);
      expect(titles.indexOf("first")).toBeLessThan(titles.indexOf("first-child"));
      expect(titles.indexOf("first-child")).toBeLessThan(titles.indexOf("second"));
      expect(detail.subtasks.map((s) => s.id)).toEqual([first.id, firstChild.id, second.id]);
    });

    it("orders siblings created in the SAME millisecond deterministically", async () => {
      // The CTE appends the item's id to each path step precisely so
      // same-millisecond siblings have a total order. Without a controlled
      // `createdAt` no test can build that case — every item gets its own
      // timestamp — so the tiebreaker is stripped-out-and-still-green
      // unless the collision is forced, as it is here.
      //
      // The assertion is *stability*, not a particular order: which sibling
      // sorts first is arbitrary and not worth pinning. What matters is
      // that two identical reads agree, because a tree that reorders itself
      // between refreshes is the failure the tiebreaker prevents.
      const project = await createItem({ area: "detail-tie" });
      const ids: string[] = [];
      for (let i = 0; i < 6; i++) {
        const child = await createItem({
          area: "detail-tie",
          parentId: project.id,
          title: `sibling ${i}`,
        });
        ids.push(child.id);
      }
      // One instant for all of them, so `createdAt` alone cannot order them.
      await prisma.$executeRawUnsafe(
        `UPDATE "Item" SET "createdAt" = TIMESTAMPTZ '2026-01-01 00:00:00.000+00' WHERE "id" = ANY($1::text[])`,
        ids,
      );

      const first = (await detailOf(project.id)).subtasks.map((s) => s.id);
      const second = (await detailOf(project.id)).subtasks.map((s) => s.id);

      expect(first).toHaveLength(6);
      expect(first).toEqual(second);
      // And it is a real ordering, not the arbitrary one the plan happened
      // to produce: appending the id makes it sort by id under the tie.
      expect(first).toEqual([...ids].sort());
    });

    it("gives a task its column and gives a nested project NONE", async () => {
      // DECISIONS.md §13c: a project's stored state is a creation leftover.
      // A column derived from it would be a lie, so it is null.
      const project = await createItem({ area: "detail-kinds" });
      const task = await createItem({ area: "detail-kinds", parentId: project.id });
      await setState(task.id, "executing");
      const subProject = await createItem({ area: "detail-kinds", parentId: project.id });
      // A project by virtue of being parentless is not available here (it
      // has a parent), so make it one the way the schema allows: `kind` is
      // set at creation from parentage, so set it directly.
      await prisma.$executeRawUnsafe(
        `UPDATE "Item" SET "kind" = 'project'::"ItemKind" WHERE "id" = $1`,
        subProject.id,
      );

      const detail = await detailOf(project.id);
      const byId = new Map(detail.subtasks.map((s) => [s.id, s]));
      expect(byId.get(task.id)!.column).toBe("in_progress");
      expect(byId.get(subProject.id)!.column).toBeNull();
    });
  });

  describe("the root's column", () => {
    it("reads a task's own state directly", async () => {
      const project = await createItem({ area: "detail-col-task" });
      const task = await createItem({ area: "detail-col-task", parentId: project.id });
      await setState(task.id, "blocked");
      expect((await detailOf(task.id)).column).toBe("waiting");
    });

    it("derives a project's from its children, NOT from its stored state", async () => {
      // The load-bearing assertion: the project's row still says `on_deck`
      // (which maps to backlog), and the answer must be in_progress.
      const project = await createItem({ area: "detail-col-project" });
      expect(project.state).toBe("on_deck");
      const task = await createItem({ area: "detail-col-project", parentId: project.id });
      await setState(task.id, "executing");

      const detail = await detailOf(project.id);
      expect(detail.item.state).toBe("on_deck");
      expect(detail.column).toBe("in_progress");
      expect(detail.column).not.toBe("backlog");
    });

    it("derives a fully-merged project as completed", async () => {
      const project = await createItem({ area: "detail-col-done" });
      const task = await createItem({ area: "detail-col-done", parentId: project.id });
      await setState(task.id, "merged");
      expect((await detailOf(project.id)).column).toBe("completed");
    });
  });

  describe("artifacts", () => {
    async function addArtifact(
      itemId: string,
      fields: { kind: string; verdict?: string; round?: number; sha?: string; createdAt?: Date },
    ): Promise<void> {
      // `createdByType`/`createdById` are NOT NULL — an artifact always
      // records who produced it (SCHEMA.md §6a), so a fixture cannot omit
      // them.
      //
      // `createdAt` defaults to `now()` via the column default when omitted;
      // an explicit value lets a test pin two rows to the exact same
      // instant, which is the only way to exercise the `seq` tiebreak — two
      // calls to `now()` a statement apart are never actually equal.
      await prisma.$executeRawUnsafe(
        `INSERT INTO "Artifact"
           ("id", "itemId", "kind", "verdict", "reviewRound", "commitSha", "createdByType", "createdById"${
             fields.createdAt ? `, "createdAt"` : ""
           })
         VALUES (gen_random_uuid(), $1, $2::"ArtifactKind", $3::"Verdict", $4, $5, 'agent'::"HolderType", $6${
           fields.createdAt ? `, $7` : ""
         })`,
        ...([
          itemId,
          fields.kind,
          fields.verdict ?? null,
          fields.round ?? 1,
          fields.sha ?? null,
          "test-agent",
          ...(fields.createdAt ? [fields.createdAt] : []),
        ] as unknown[]),
      );
    }

    it("is empty for an item with none", async () => {
      const project = await createItem({ area: "detail-art-none" });
      const task = await createItem({ area: "detail-art-none", parentId: project.id });
      expect((await detailOf(task.id)).artifacts).toEqual([]);
    });

    it("returns every artifact, ordered by review round ascending", async () => {
      const project = await createItem({ area: "detail-art" });
      const task = await createItem({ area: "detail-art", parentId: project.id });
      await addArtifact(task.id, { kind: "code_review", verdict: "changes_required", round: 2 });
      await addArtifact(task.id, { kind: "plan", round: 1 });
      await addArtifact(task.id, { kind: "code_review", verdict: "lgtm", round: 3 });

      const detail = await detailOf(task.id);
      expect(detail.artifacts.map((a) => a.reviewRound)).toEqual([1, 2, 3]);
      expect(detail.artifacts.map((a) => a.verdict)).toEqual([null, "changes_required", "lgtm"]);
    });

    it("does not return another item's artifacts", async () => {
      const project = await createItem({ area: "detail-art-scope" });
      const mine = await createItem({ area: "detail-art-scope", parentId: project.id });
      const theirs = await createItem({ area: "detail-art-scope", parentId: project.id });
      await addArtifact(theirs.id, { kind: "code_review", verdict: "lgtm" });

      expect((await detailOf(mine.id)).artifacts).toEqual([]);
    });

    // Row 6faf6478-35a5-468d-bce3-341789c08ccd. `currentTipCommitSha`
    // (`src/lib/item-detail/view.ts`) walks this response's `artifacts`
    // array keeping the *last* matching `commit`-kind entry — so the tip it
    // derives is decided entirely by the order this query returns rows in,
    // not by any field the client can see. Without a `seq` tiebreak, two
    // `commit` artifacts sharing a `createdAt` (a real case under concurrent
    // writes) leave the winner to whatever order Postgres's plan happens to
    // return rows in.
    //
    // **Why 8 concurrent connections, not 2.** A single connection issuing
    // two sequential `INSERT`s — or even two connections racing on `BEGIN` /
    // `COMMIT` — was tried first and could not be made to fail here: on this
    // table shape a plain scan with no tiebreak returned insertion order
    // consistently across a seq scan, an index scan, and a forced 4-worker
    // parallel scan (checked directly, including 30 trials at 200 tied rows
    // and a bare `SELECT` with no `ORDER BY` at all). Widening to 8 backends
    // truly concurrent via `Promise.all`, each opening its own connection
    // and inserting one row at the identical `createdAt`, disagreed with
    // insertion order on **30 of 30** trials measured directly against the
    // unfixed query — genuine, reliable, not a coin flip. The same 8-way
    // race against the fixed query (`"seq" ASC` added) matched insertion
    // order on **20 of 20**. Both figures were measured before this test was
    // written, not assumed from the fix's shape.
    it("orders same-millisecond artifacts by seq, matching insertion order", async () => {
      const project = await createItem({ area: "detail-art-tie" });
      const task = await createItem({ area: "detail-art-tie", parentId: project.id });
      const tiedInstant = new Date();

      const WRITER_COUNT = 8;
      const clients = Array.from(
        { length: WRITER_COUNT },
        () => new PgClient({ connectionString: scratchUrl }),
      );
      await Promise.all(clients.map((c) => c.connect()));
      // `pg` returns a `bigint`/`int8` column as a STRING by default (no
      // custom type parser is registered) — comparing those with `<`/`>`
      // would sort lexically ("15" < "9"), not numerically, and silently
      // compute the wrong expected order. `BigInt(...)` is what makes the
      // comparison below actually numeric.
      let results: { rows: { seq: string }[] }[];
      try {
        results = await Promise.all(
          clients.map((client, i) =>
            client.query<{ seq: string }>(
              `INSERT INTO "Artifact"
                 ("id","itemId","kind","reviewRound","commitSha","createdByType","createdById","createdAt")
               VALUES (gen_random_uuid(),$1,'commit'::"ArtifactKind",1,$2,'agent'::"HolderType",'test-agent',$3)
               RETURNING "seq"`,
              [task.id, `writer-${i}`, tiedInstant],
            ),
          ),
        );
      } finally {
        await Promise.all(clients.map((c) => c.end()));
      }

      // `seq` is a `BIGSERIAL` — the true insertion order is whichever writer
      // actually drew the lowest value, not the order this test happened to
      // issue `INSERT`s in (a real race lets either side land first). Reading
      // the expected order back from the `seq` values themselves, rather
      // than assuming `writer-0` always wins, is what keeps this assertion
      // honest under a genuine race.
      const expectedOrder = results
        .map((r, i) => ({ sha: `writer-${i}`, seq: BigInt(r.rows[0]!.seq) }))
        .sort((a, b) => (a.seq < b.seq ? -1 : a.seq > b.seq ? 1 : 0))
        .map((r) => r.sha);

      const detail = await detailOf(task.id);
      const commits = detail.artifacts.filter((a) => a.kind === "commit");
      expect(commits.map((a) => a.commitSha)).toEqual(expectedOrder);
    });
  });

  describe("history", () => {
    it("returns the item's events newest first", async () => {
      const project = await createItem({ area: "detail-history" });
      const task = await createItem({ area: "detail-history", parentId: project.id });
      await runtime.call("note", { itemId: task.id, body: "first note" });
      await runtime.call("note", { itemId: task.id, body: "second note" });

      const detail = await detailOf(task.id);
      const bodies = detail.history.map((h) => h.body);
      expect(bodies.indexOf("second note")).toBeLessThan(bodies.indexOf("first note"));
    });

    it("returns a checkpoint's stored headline, so a reader need not re-derive it", async () => {
      // The status block reduces the newest checkpoint to one line, and the
      // rule is that a STORED headline wins over one derived from the prose
      // (`checkpointHeadline`). A payload without this column leaves a
      // client able only to derive, which silently answers with the
      // derivation everywhere a writer supplied a line — so the column has
      // to cross the wire, not just exist in the table.
      const project = await createItem({ area: "detail-history-headline" });
      const task = await createItem({ area: "detail-history-headline", parentId: project.id });
      // A checkpoint attributes to a live assignment, so the session has to
      // hold one — and a claim is refused from a session that has not
      // registered a hook protocol version (SCHEMA.md §21). Both are
      // satisfied the way a real session satisfies them rather than
      // side-stepped, so this exercises the same path a session takes.
      const sessionId = "session-detail-headline";
      await registerSessions(prisma, [sessionId]);
      await runtime.call("claim", {
        itemId: task.id,
        sessionId,
        role: "builder",
        holderType: "agent",
        holderId: "crew-detail-headline",
        machine: "a-machine",
      });
      await runtime.call("checkpoint", {
        itemId: task.id,
        sessionId,
        body: "a first line that is NOT the headline\nmore prose",
        headline: "the stored headline",
      });

      const detail = await detailOf(task.id);
      const checkpoint = detail.history.find((h) => h.type === "checkpoint");
      expect(checkpoint?.headline).toBe("the stored headline");
    });

    it("returns a null headline on an event that has none, rather than omitting the field", async () => {
      // Most event types never carry one, so its absence must read as
      // ordinary — a missing key would make every consumer treat a normal
      // note as a malformed row.
      const project = await createItem({ area: "detail-history-no-headline" });
      const task = await createItem({ area: "detail-history-no-headline", parentId: project.id });
      await runtime.call("note", { itemId: task.id, body: "a note" });

      const detail = await detailOf(task.id);
      const note = detail.history.find((h) => h.type === "note");
      expect(note).toBeDefined();
      expect(note).toHaveProperty("headline");
      expect(note?.headline).toBeNull();
    });

    it("stringifies the event id — a bigint cannot cross a JSON boundary", async () => {
      // `JSON.stringify` throws on a bigint outright, so an unmapped id
      // would fail the HTTP route on its very first call.
      const project = await createItem({ area: "detail-history-json" });
      const task = await createItem({ area: "detail-history-json", parentId: project.id });
      await runtime.call("note", { itemId: task.id, body: "a note" });

      const detail = await detailOf(task.id);
      expect(detail.history.length).toBeGreaterThan(0);
      expect(typeof detail.history[0]!.id).toBe("string");
      expect(() => JSON.stringify(detail)).not.toThrow();
    });

    it("caps at historyLimit and says so, without counting the probe row as an entry", async () => {
      const project = await createItem({ area: "detail-history-cap" });
      const task = await createItem({ area: "detail-history-cap", parentId: project.id });
      for (let i = 0; i < 5; i++) {
        await runtime.call("note", { itemId: task.id, body: `note ${i}` });
      }

      const detail = await detailOf(task.id, { historyLimit: 2 });
      expect(detail.history).toHaveLength(2);
      expect(detail.historyTruncated).toBe(true);
    });

    it("does NOT claim truncation when the ledger fits exactly within the limit", async () => {
      // The off-by-one this guards: reading `limit + 1` rows and then
      // comparing against `limit` naively would flag a full page as
      // truncated even when there is nothing more.
      const project = await createItem({ area: "detail-history-exact" });
      const task = await createItem({ area: "detail-history-exact", parentId: project.id });
      const before = (await detailOf(task.id)).history.length;

      const detail = await detailOf(task.id, { historyLimit: before });
      expect(detail.history).toHaveLength(before);
      expect(detail.historyTruncated).toBe(false);
    });

    it("does not return another item's events", async () => {
      const project = await createItem({ area: "detail-history-scope" });
      const mine = await createItem({ area: "detail-history-scope", parentId: project.id });
      const theirs = await createItem({ area: "detail-history-scope", parentId: project.id });
      await runtime.call("note", { itemId: theirs.id, body: "not mine" });

      const detail = await detailOf(mine.id);
      expect(detail.history.map((h) => h.body)).not.toContain("not mine");
    });

    it("applies NO event-type filter, which is what keeps the client-side loop fold honest", async () => {
      // ── The invariant this pins, and why it is worth a test ────────────
      //
      // Unlike every other loop-bearing read, this operation does not fold
      // loops. It returns raw history and the fold happens client-side in
      // `openLoops` (`src/lib/item-detail/status.ts`). That fold is only
      // correct when handed the COMPLETE loop-event slice: it is a
      // four-type fold, and a narrower slice does not fail loudly — it
      // reports a deleted loop as still open and serves an edited loop its
      // superseded text.
      //
      // So this surface's correctness rests entirely on the history query
      // above staying unfiltered. That is an invisible dependency: nothing
      // in `get-item-detail.ts` mentions loops, and a future reader trimming
      // the payload by type — an entirely plausible change, since this
      // operation once returned 742,960 characters — would have no local
      // signal that they had just broken the detail view's loop list.
      //
      // **Why this exists beside the source-level assertion.**
      // `item-detail-status.test.ts` already pins this invariant by reading
      // `get-item-detail.ts` and regex-ing its history query for a type
      // predicate. That test is valuable — it runs unskipped without a
      // database — but it pins the source TEXT, so it only sees a narrowing
      // spelled the obvious way. Verified during this change: a filter whose
      // column name and excluded label are assembled at runtime (so the
      // literal tokens `"type" =` and `open_loop` never appear in the query
      // string) leaves all 79 of that file's tests green, while this one
      // fails. The two are complementary — that one is cheap and always
      // runs, this one cannot be fooled by how the SQL is written — and the
      // fold's own unit tests catch neither, because they are handed a slice
      // directly and never see the query that supplies it.
      //
      // Breaks if: the history query grows any predicate that drops a loop
      // event type, however spelled, or `historyLimit` stops admitting them.
      const project = await createItem({ area: "detail-history-unfiltered" });
      const task = await createItem({ area: "detail-history-unfiltered", parentId: project.id });

      await runtime.call("loop_add", {
        itemId: task.id,
        loopId: "l-1",
        text: "the original wording",
      });
      await runtime.call("loop_edit", { itemId: task.id, loopId: "l-1", text: "the new wording" });
      await runtime.call("loop_add", { itemId: task.id, loopId: "l-2", text: "to be retracted" });
      await runtime.call("loop_delete", {
        itemId: task.id,
        loopId: "l-2",
        reason: "a duplicate of the loop above",
      });

      const detail = await detailOf(task.id);
      const types = detail.history.map((entry) => entry.type);

      // All four loop event types survive the round trip. `open_loop_edited`
      // and `open_loop_deleted` are the two a narrowing filter would drop
      // first, being the newest additions to the lifecycle.
      for (const type of ["open_loop", "open_loop_edited", "open_loop_deleted"]) {
        expect(types).toContain(type);
      }

      // And the guarantee that depends on it: running the very fold the view
      // runs over this payload withholds the deleted loop and serves the
      // edited loop's CURRENT text. Asserted against the superseded wording
      // being absent, not merely the current one present, so a fold
      // returning both still fails.
      const folded = openLoops(detail.history);
      expect(folded.map((loop) => loop.loopId)).toEqual(["l-1"]);
      expect(folded[0]!.text).toBe("the new wording");
      expect(folded.map((loop) => loop.text)).not.toContain("the original wording");
    });
  });

  describe("the summary", () => {
    it("is null for an item that has never been completed", async () => {
      const project = await createItem({ area: "detail-summary-none" });
      const task = await createItem({ area: "detail-summary-none", parentId: project.id });
      expect((await detailOf(task.id)).summary).toBeNull();
    });

    it("is returned once one exists", async () => {
      const project = await createItem({ area: "detail-summary" });
      const task = await createItem({ area: "detail-summary", parentId: project.id });
      await prisma.$executeRawUnsafe(
        `INSERT INTO "Summary" ("itemId", "shipped", "notDone", "userFacing", "howVerified", "watchFor", "finalState")
         VALUES ($1, $2::jsonb, $3::jsonb, $4, $5, $6::jsonb, $7::jsonb)`,
        task.id,
        JSON.stringify(["the thing"]),
        JSON.stringify([]),
        false,
        "unit tests",
        JSON.stringify([]),
        JSON.stringify({}),
      );

      const detail = await detailOf(task.id);
      expect(detail.summary).not.toBeNull();
      expect(detail.summary!.shipped).toEqual(["the thing"]);
      expect(detail.summary!.userFacing).toBe(false);
      expect(detail.summary!.howVerified).toBe("unit tests");
    });
  });

  describe("input validation", () => {
    it("refuses a historyLimit above the cap rather than serving an unbounded page", async () => {
      const project = await createItem({ area: "detail-limit" });
      const task = await createItem({ area: "detail-limit", parentId: project.id });
      await expect(detailOf(task.id, { historyLimit: 5000 })).rejects.toThrow();
    });

    it("refuses an unrecognised field rather than silently ignoring it", async () => {
      const project = await createItem({ area: "detail-strict" });
      const task = await createItem({ area: "detail-strict", parentId: project.id });
      await expect(detailOf(task.id, { nope: true })).rejects.toThrow();
    });
  });
});
