// `record` — the four write verbs, proved by writing then reading back.
//
// ── What would make this file hollow, stated first ──────────────────────
//
// A fold's forwarding can be wrong in a way several kinds of test agree
// with. A refusal assertion passes whether the call was refused for the
// reason the test meant or a different one — an unrecognised key refuses
// identically whatever it contains — and a comparison against a literal
// passes when the literal is wrong in the same way the builder is.
//
// So every action below is proved by WRITING and READING BACK. A checkpoint
// is made and then found as the item's latest checkpoint headline; a note
// is made and its text found in the item's history; an artifact is made and
// found among the item's artifacts with the kind it was given; a
// blocked-on-tool report is made and found as an artifact naming the tool.
// A payload that reached the wrong delegate, or the right delegate under a
// name it ignores, changes WHAT IS ON THE RECORD — and that is what the
// assertions read.
//
// ── The asymmetry this file exists to pin ───────────────────────────────
//
// `action: "checkpoint"` needs a LIVE ASSIGNMENT and refuses with
// `conflict` without one. `action: "note"` needs none. Behind one tool name
// that distinction has no separate tool to make it visible, so the fold
// states it in `contract.rules` — and this file asserts BOTH halves, because
// the rule is only worth anything if the behaviour still matches it:
//
//   - checkpoint without an assignment is refused, through the fold, with
//     the same refusal object the unfolded operation raises;
//   - note without an assignment SUCCEEDS, which is the half a test of the
//     refusal alone would never establish and the half a caller is most
//     likely to be wrong about.
//
// ── The mutations this file was checked against ─────────────────────────
//
//   - point action `note` at the checkpoint delegate → the
//     note-needs-no-assignment test fails, because it starts being refused.
//   - stop forwarding `headline` on the checkpoint branch → the headline
//     read-back fails.
//   - forward `artifactKind` as `kind` on the artifact branch → every
//     artifact assertion fails, because the delegate is strict.
//   - stop forwarding `tool` on the blocked_on_tool branch → that action is
//     refused and its test fails.
//
// Each was run; each failed as described.
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
import { registerSessions } from "./helpers/register-sessions";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const describeIfDb = testDatabaseUrl ? describe : describe.skip;

/** A refusal, as a caught value carries it. */
type Refusal = { code?: string; guard?: string; fields?: string[]; message?: string };

/**
 * The refusal a call raised — failing if it did not raise one.
 *
 * The success path throws rather than returning an empty object: an empty
 * object's `code` is `undefined`, and asserting `undefined !== "conflict"`
 * passes. A refusal test that goes green when nothing was refused is the
 * hollowness this file's header is about.
 */
async function refusalFrom(call: Promise<unknown>): Promise<Refusal> {
  try {
    await call;
  } catch (thrown) {
    return thrown as Refusal;
  }
  throw new Error("the call was expected to be refused and succeeded instead");
}

describeIfDb("record, against Postgres", () => {
  const dbName = scratchDatabaseName("record_fold");
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

  let counter = 0;
  function nextSession(prefix: string): string {
    counter += 1;
    return `${prefix}-${counter}`;
  }

  async function makeItem() {
    return (await runtime.call("create_item", {
      title: "An item things are recorded against",
      body: "The work this item stands for, so the create is well-formed.",
      area: "record-fold",
      originType: "auto",
    })) as unknown as { id: string };
  }

  /** An item this session holds, so a checkpoint has something to attribute to. */
  async function heldItem(sessionId: string): Promise<string> {
    const item = await makeItem();
    await registerSessions(prisma, [sessionId]);
    await runtime.call("ownership", {
      action: "claim",
      itemId: item.id,
      role: "builder",
      holderType: "agent",
      holderId: "builder-a",
      sessionId,
    });
    return item.id;
  }

  /** The bodies on an item's history, read back through the server. */
  async function historyBodies(itemId: string): Promise<(string | null | undefined)[]> {
    const history = (await runtime.call("read_item", {
      action: "history",
      id: itemId,
      full: true,
    })) as unknown as { entries: { body?: string | null }[] };
    return history.entries.map((entry) => entry.body);
  }

  /** The artifacts on an item, read back through the server. */
  async function artifactsOf(itemId: string): Promise<{ kind: string; body?: string | null }[]> {
    const read = (await runtime.call("read_item", {
      action: "artifacts",
      id: itemId,
      full: true,
    })) as unknown as { artifacts: { kind: string; body?: string | null }[] };
    return read.artifacts;
  }

  describe("action checkpoint", () => {
    it("records the checkpoint, headline and all, against the holder's assignment", async () => {
      // **Write then read back.** The headline is read from `get_item`,
      // which surfaces the latest checkpoint's own headline — so a
      // `headline` the fold failed to forward comes back null.
      const sessionId = nextSession("holder");
      const itemId = await heldItem(sessionId);

      await runtime.call("record", {
        action: "checkpoint",
        itemId,
        sessionId,
        body: "Reproduced the refusal against a scratch database. Next: declare the rule.",
        headline: "Refusal traced to the assignment lookup",
      });

      const item = (await runtime.call("get_item", { id: itemId })) as unknown as {
        checkpointHeadline: string | null;
      };
      expect(item.checkpointHeadline).toBe("Refusal traced to the assignment lookup");
      expect(await historyBodies(itemId)).toEqual(
        expect.arrayContaining([
          "Reproduced the refusal against a scratch database. Next: declare the rule.",
        ]),
      );
    });

    it("refuses without a live assignment, with the refusal the unfolded call raises", async () => {
      // Half one of the asymmetry. Compared field for field against the
      // direct call, because the argument for waiving these operations is
      // that the fold returns the SAME refusal object — a fold that caught
      // and re-raised its own would differ here while looking correct.
      const item = await makeItem();
      const stranger = nextSession("unassigned");
      await registerSessions(prisma, [stranger]);

      const throughFold = await refusalFrom(
        runtime.call("record", {
          action: "checkpoint",
          itemId: item.id,
          sessionId: stranger,
          body: "a checkpoint from a session holding nothing",
        }),
      );
      const direct = await refusalFrom(
        runtime.call("checkpoint", {
          itemId: item.id,
          sessionId: stranger,
          body: "a checkpoint from a session holding nothing",
        }),
      );

      expect(throughFold.code).toBe(direct.code);
      expect(throughFold.guard).toBe(direct.guard);
      expect(throughFold.fields).toEqual(direct.fields);
      // ...and it is a `conflict`, not any refusal at all — without this the
      // two could agree by both being `invalid_input` for some other reason.
      expect(throughFold.code).toBe("conflict");
    });
  });

  describe("action note", () => {
    it("SUCCEEDS with no assignment — the other half of the asymmetry", async () => {
      // **The half a refusal test can never establish**, and the half a
      // caller is most likely to be wrong about: three documents were once
      // written saying checkpoint needs no claim, and sessions were refused
      // after following them. Behind one tool name the distinction has no
      // separate tool to make it visible, so it is asserted here and stated
      // in the fold's contract rule.
      const item = await makeItem();
      const stranger = nextSession("unassigned");
      await registerSessions(prisma, [stranger]);

      await runtime.call("record", {
        action: "note",
        itemId: item.id,
        sessionId: stranger,
        body: "a remark from a session that holds nothing",
      });

      expect(await historyBodies(item.id)).toEqual(
        expect.arrayContaining(["a remark from a session that holds nothing"]),
      );
    });

    it("needs no sessionId at all", async () => {
      // The strongest form of "needs no assignment": not merely that an
      // unassigned session may note, but that a caller naming no session
      // may. `sessionId` is required on the checkpoint action and on
      // nothing else, which is the schema half of the same rule.
      const item = await makeItem();
      await runtime.call("record", {
        action: "note",
        itemId: item.id,
        body: "a remark from nobody in particular",
      });
      expect(await historyBodies(item.id)).toEqual(
        expect.arrayContaining(["a remark from nobody in particular"]),
      );
    });

    it("states the asymmetry in the contract a caller can read", async () => {
      // The rule is the mitigation for folding these two together, so it
      // ships as TEXT and is checked as text. Asserted on substance rather
      // than on an exact sentence: it has to name the field, say that one
      // action needs an assignment, and say the other does not.
      const contract = (await runtime.call("describe_tool", { tool: "record" })) as unknown as {
        rules?: { fields: string[]; rule: string }[];
      };
      const rule = contract.rules?.find((entry) => entry.fields.includes("sessionId"));
      expect(rule, "record declares no rule about sessionId").toBeDefined();
      expect(rule!.rule).toMatch(/LIVE ASSIGNMENT/);
      expect(rule!.rule).toMatch(/conflict/);
      expect(rule!.rule).toMatch(/note/);
      expect(rule!.rule).toMatch(/no assignment/);
    });
  });

  describe("action artifact", () => {
    it("records the artifact under the kind it was given", async () => {
      // `artifactKind`, not `kind`. The delegate is strict, so a fold
      // forwarding the wrong name is refused rather than silently
      // recording the wrong thing — but this asserts the RESULT, so it
      // fails whichever way that goes.
      const item = await makeItem();

      await runtime.call("record", {
        action: "artifact",
        itemId: item.id,
        artifactKind: "plan",
        body: "the plan this crew is working to",
        createdByType: "agent",
        createdById: "builder-a",
      });

      const artifacts = await artifactsOf(item.id);
      expect(artifacts).toHaveLength(1);
      expect(artifacts[0]!.kind).toBe("plan");
      expect(artifacts[0]!.body).toBe("the plan this crew is working to");
    });

    it("carries the delegate's own rules through unchanged", async () => {
      // A `commit` artifact must name its commit. The rule belongs to the
      // artifact write and is not restated by the fold, so this is the
      // check that it still reaches a caller who came in through the fold.
      const item = await makeItem();
      const refusal = await refusalFrom(
        runtime.call("record", {
          action: "artifact",
          itemId: item.id,
          artifactKind: "commit",
          createdByType: "agent",
          createdById: "builder-a",
        }),
      );
      expect(refusal.code).toBe("invalid_input");
      expect(refusal.fields).toContain("commitSha");
    });
  });

  describe("action blocked_on_tool", () => {
    it("records the report, naming the tool and what was needed", async () => {
      const item = await makeItem();
      const sessionId = nextSession("blocked");
      await registerSessions(prisma, [sessionId]);

      await runtime.call("record", {
        action: "blocked_on_tool",
        itemId: item.id,
        tool: "browser_capture",
        needed: "screenshot the header the brief asked me to check",
        reason: "not_granted",
        sessionId,
      });

      // Read back from the item's own record rather than from the return
      // value: a report that was accepted and stored against nothing would
      // pass an assertion on the response.
      //
      // This action appends an `escalation` EVENT rather than an artifact —
      // a different store from the other three actions, and reading the
      // wrong one is how a test of it goes quietly green against a write
      // that never happened. (It did: the first draft of this test read the
      // artifacts and found none, which is the correct answer to the wrong
      // question.)
      const history = (await runtime.call("read_item", {
        action: "history",
        id: item.id,
        full: true,
      })) as unknown as { entries: { body?: string | null; payload?: unknown }[] };

      expect(history.entries.length).toBeGreaterThan(0);
      const text = history.entries
        .map((entry) => `${entry.body ?? ""} ${JSON.stringify(entry.payload ?? {})}`)
        .join("\n");
      expect(text).toContain("browser_capture");
      expect(text).toContain("screenshot the header the brief asked me to check");
    });
  });

  describe("the shape of the tool", () => {
    it("refuses an action missing a field it cannot run without, naming it", async () => {
      const item = await makeItem();
      const refusal = await refusalFrom(
        runtime.call("record", { action: "checkpoint", itemId: item.id }),
      );
      expect(refusal.code).toBe("invalid_input");
      expect(refusal.fields).toEqual(expect.arrayContaining(["sessionId", "body"]));
    });

    it("refuses an action it does not have", async () => {
      const refusal = await refusalFrom(
        runtime.call("record", { action: "shout", itemId: "item-1" }),
      );
      expect(refusal.code).toBe("invalid_input");
      expect(refusal.fields).toContain("action");
    });

    it("refuses `kind` — the name that means something else on another tool", async () => {
      // The rename this fold depends on, asserted from the outside. `kind`
      // is `loop`'s field, and accepting it here would be the collision the
      // rename removed. Asserted on the message because an unrecognised key
      // is reported with an empty path.
      const item = await makeItem();
      const refusal = await refusalFrom(
        runtime.call("record", {
          action: "artifact",
          itemId: item.id,
          kind: "plan",
          createdByType: "agent",
          createdById: "builder-a",
        }),
      );
      expect(refusal.code).toBe("invalid_input");
      expect(refusal.message).toContain("kind");
    });
  });
});
