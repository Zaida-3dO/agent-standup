// `read_item` — the three bounded reads, proved by writing then reading back.
//
// ── What would make this file hollow, stated first ──────────────────────
//
// A fold's forwarding can be wrong in a way three different kinds of test
// agree with. A fold once forwarded a caller's list under its own field
// name while the delegate declared another, and every call to that verb was
// refused — yet the fold's tests passed, because they asserted REFUSALS,
// and an unrecognised key refuses identically whatever it contains. The
// CLI's tests passed too, because they compared the builder's output to a
// literal that was wrong in the same way.
//
// So neither shape is used here:
//
//   - **Not a refusal assertion for the happy path.** Every action below is
//     proved by WRITING something and READING IT BACK through the fold. A
//     payload that reached the wrong delegate, or the right delegate under
//     a name it ignores, returns the wrong rows — and wrong rows fail,
//     where a refusal would not have been distinguishable from a hundred
//     other refusals.
//   - **Not a comparison against a literal.** Nothing here asserts what the
//     fold builds. It asserts what came back, against data this file put
//     there.
//
// Refusal assertions DO appear, for the cases that are genuinely about
// refusing — a missing subject, a field sent to an action that cannot use
// it — and each pins something BEYOND the `code`, so "refused for the
// reason I meant" is checkable rather than assumed. Usually that is
// `fields`; for an unrecognised key it is the message, because the schema
// reports that class with an empty path and `fields` is `[]`. Asserting
// only the code would pass against any refusal at all, which for a wrong
// field name is precisely the trap described above.
//
// ── The mutations this file was checked against ─────────────────────────
//
//   - forward `offset` as `skip` on action `body` → the paging test fails,
//     because the window comes back starting at zero.
//   - stop forwarding `full` on action `history` → the note-text test
//     fails, because the bodies come back absent.
//   - stop forwarding `kind` on action `artifacts` → the filter test
//     fails, because every artifact comes back rather than one kind.
//   - remove the misplaced-field check → its refusal test fails.
//
// Each was run against this file; each failed exactly one or two tests and
// none of them left it green. A forwarding change this file cannot see is
// one that does not change what comes back, which is the bar it was
// written to.
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
import { createTestPrismaClient } from "./helpers/test-prisma-client";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const describeIfDb = testDatabaseUrl ? describe : describe.skip;

/** A refusal, as a caught value carries it. */
type Refusal = { code?: string; fields?: string[]; message?: string };

/**
 * The refusal a call raised — failing if it did not raise one.
 *
 * The success path throws rather than returning an empty object, because an
 * empty object's `code` is `undefined` and an assertion that `undefined` is
 * not `"invalid_input"` passes. A refusal test that goes green when nothing
 * was refused is the hollowness this file's header is about.
 */
async function refusalFrom(call: Promise<unknown>): Promise<Refusal> {
  try {
    await call;
  } catch (thrown) {
    return thrown as Refusal;
  }
  throw new Error("the call was expected to be refused and succeeded instead");
}

describeIfDb("read_item, against Postgres", () => {
  const dbName = scratchDatabaseName("read_item_fold");
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

  async function makeItem(body: string) {
    return (await runtime.call("create_item", {
      title: "An item read in windows",
      headline: "One line",
      body,
      area: "read-item-fold",
      originType: "auto",
    })) as unknown as { id: string };
  }

  describe("action body", () => {
    it("returns the window the caller asked for, at the offset it asked for", async () => {
      // **Write then read back.** The body is built so that every position
      // in it is identifiable: a window from the wrong offset, or a window
      // the delegate defaulted because the offset never arrived, returns
      // different characters. A fold that forwarded `offset` under a name
      // `get_item_body` ignores comes back starting at zero and fails here.
      // Every ten-character window is distinct, so a window read from the
      // wrong offset cannot coincidentally equal the right one. A body of
      // repeating digits looks like a good fixture and is not: `slice(0,10)`
      // and `slice(30,40)` are the same string, so the assertion that the
      // window is not the start would pass against an offset that never
      // arrived.
      const body = Array.from({ length: 100 }, (_, i) => String.fromCharCode(33 + (i % 90))).join(
        "",
      );
      const created = await makeItem(body);

      const window = (await runtime.call("read_item", {
        action: "body",
        id: created.id,
        offset: 30,
        limit: 10,
      })) as unknown as { chunk: string; offset: number; totalLength: number };

      expect(window.chunk).toBe(body.slice(30, 40));
      expect(window.offset).toBe(30);
      expect(window.totalLength).toBe(body.length);
      // ...and the window is genuinely not the start, so the assertion
      // above cannot be satisfied by an offset that was dropped.
      expect(window.chunk).not.toBe(body.slice(0, 10));
    });

    it("returns what get_item_body returns, called directly", async () => {
      // The fold is a dispatch, not a reimplementation. Compared as whole
      // payloads, so a second implementation agreeing on the keys and
      // differing on a value fails.
      const created = await makeItem("a".repeat(500) + "b".repeat(500));
      const folded = await runtime.call("read_item", {
        action: "body",
        id: created.id,
        offset: 400,
        limit: 200,
      });
      const direct = await runtime.call("get_item_body", {
        id: created.id,
        offset: 400,
        limit: 200,
      });
      expect(folded).toEqual(direct);
    });
  });

  describe("action history", () => {
    it("returns the notes this test wrote, with their text under full", async () => {
      // **Write then read back**, and the write is the proof: three notes
      // with distinguishable bodies go in, and the read has to bring those
      // exact bodies back. `full` is what turns a slim ledger into the
      // text, so a `full` that did not arrive returns entries with no body
      // and fails — which is the field most likely to be dropped silently,
      // since its absence is a legal shape rather than an error.
      const created = await makeItem("body");
      for (const text of ["first note", "second note", "third note"]) {
        await runtime.call("note", { itemId: created.id, body: text });
      }

      const history = (await runtime.call("read_item", {
        action: "history",
        id: created.id,
        full: true,
      })) as unknown as { entries: { body?: string | null }[] };

      const bodies = history.entries.map((entry) => entry.body);
      expect(bodies).toEqual(expect.arrayContaining(["first note", "second note", "third note"]));
    });

    it("returns a slim ledger without full, which is the difference full makes", async () => {
      // The complement. Without this, the test above would pass against a
      // fold that forced `full: true` regardless of what the caller sent —
      // and a forced default is a forwarding defect too.
      const created = await makeItem("body");
      await runtime.call("note", { itemId: created.id, body: "a note with a body" });

      const slim = (await runtime.call("read_item", {
        action: "history",
        id: created.id,
      })) as unknown as { entries: Record<string, unknown>[] };

      expect(slim.entries.length).toBeGreaterThan(0);
      for (const entry of slim.entries) {
        expect(entry).not.toHaveProperty("body");
      }
    });

    it("bounds the page by the limit it was given", async () => {
      const created = await makeItem("body");
      for (let i = 0; i < 4; i += 1) {
        await runtime.call("note", { itemId: created.id, body: `note ${i}` });
      }
      const page = (await runtime.call("read_item", {
        action: "history",
        id: created.id,
        limit: 2,
      })) as unknown as { entries: unknown[]; nextCursor: string | null };

      expect(page.entries).toHaveLength(2);
      // The cursor is what makes the bound a page rather than a truncation,
      // so a limit that arrived and a cursor that did not is still broken.
      expect(page.nextCursor).not.toBeNull();
    });
  });

  describe("action artifacts", () => {
    it("returns the artifacts this test recorded, filtered by the kind it asked for", async () => {
      // **Write then read back**, with a filter: two kinds go in and one
      // comes out. A `kind` that did not arrive returns both and fails — a
      // stronger check than counting, because the wrong-kind row is present
      // to be wrongly returned rather than merely absent.
      const created = await makeItem("body");
      await runtime.call("record_artifact", {
        itemId: created.id,
        kind: "plan",
        body: "the plan",
        createdByType: "agent",
        createdById: "tester",
      });
      await runtime.call("record_artifact", {
        itemId: created.id,
        kind: "commit",
        body: "the commit",
        commitSha: "abc1234",
        createdByType: "agent",
        createdById: "tester",
      });

      const plans = (await runtime.call("read_item", {
        action: "artifacts",
        id: created.id,
        kind: "plan",
      })) as unknown as { artifacts: { kind: string }[] };

      expect(plans.artifacts).toHaveLength(1);
      expect(plans.artifacts[0]!.kind).toBe("plan");

      // ...and unfiltered both come back, so the filter above is the reason
      // one did rather than there only ever having been one.
      const all = (await runtime.call("read_item", {
        action: "artifacts",
        id: created.id,
      })) as unknown as { artifacts: { kind: string }[] };
      expect(all.artifacts.map((artifact) => artifact.kind).sort()).toEqual(["commit", "plan"]);
    });

    it("returns one artifact in full when asked for it by id", async () => {
      const created = await makeItem("body");
      const recorded = (await runtime.call("record_artifact", {
        itemId: created.id,
        kind: "plan",
        body: "the whole plan text",
        createdByType: "agent",
        createdById: "tester",
      })) as unknown as { id: string };

      const one = (await runtime.call("read_item", {
        action: "artifacts",
        id: created.id,
        artifactId: recorded.id,
        full: true,
      })) as unknown as { artifacts: { id: string; body?: string | null }[] };

      expect(one.artifacts).toHaveLength(1);
      expect(one.artifacts[0]!.id).toBe(recorded.id);
      expect(one.artifacts[0]!.body).toBe("the whole plan text");
    });
  });

  describe("the subject, and the fields that do not belong to an action", () => {
    it("takes id, and refuses itemId by name", async () => {
      // The delegates declare `id` and are `.strict()`, so the fold keeping
      // `id` is load-bearing rather than stylistic. Asserted from both
      // sides: the right name works, the plausible wrong one is refused
      // naming itself.
      const created = await makeItem("body");
      const ok = await runtime.call("read_item", { action: "body", id: created.id });
      expect(ok).toHaveProperty("chunk");

      const refusal = await refusalFrom(
        runtime.call("read_item", { action: "body", itemId: created.id }),
      );
      expect(refusal.code).toBe("invalid_input");
      // Asserted on the MESSAGE rather than on `fields`, and the difference
      // is a real one worth recording: an unrecognised key is reported by
      // the schema with an empty path, so `fields` is `[]` for this class of
      // refusal while the sentence names the key. Asserting `fields` here
      // would fail against a perfectly good refusal — and asserting only
      // `code` would pass against any refusal at all, which for a wrong
      // field name is exactly the indistinguishable-refusal trap this file
      // exists to avoid.
      expect(refusal.message).toContain("itemId");
    });

    it("refuses an action with no subject, naming id", async () => {
      const refusal = await refusalFrom(runtime.call("read_item", { action: "history" }));
      expect(refusal.code).toBe("invalid_input");
      expect(refusal.fields).toContain("id");
    });

    it("refuses a field the action cannot use, rather than ignoring it", async () => {
      // Refused, not dropped. A silently ignored page marker returns page
      // one while reporting success — the caller asked to resume and was
      // handed the start, with nothing saying so.
      const created = await makeItem("body");
      const cases = [
        { action: "body", field: "cursor", value: "5" },
        { action: "body", field: "kind", value: "plan" },
        { action: "history", field: "offset", value: 5 },
        { action: "artifacts", field: "offset", value: 5 },
      ] as const;

      for (const testCase of cases) {
        const refusal = await refusalFrom(
          runtime.call("read_item", {
            action: testCase.action,
            id: created.id,
            [testCase.field]: testCase.value,
          }),
        );
        expect(
          refusal.code,
          `${testCase.field} on action ${testCase.action} should be refused`,
        ).toBe("invalid_input");
        expect(refusal.fields).toContain(testCase.field);
      }
    });

    it("refuses an action it does not have", async () => {
      const created = await makeItem("body");
      const refusal = await refusalFrom(
        runtime.call("read_item", { action: "everything", id: created.id }),
      );
      expect(refusal.code).toBe("invalid_input");
      expect(refusal.fields).toContain("action");
    });
  });
});
