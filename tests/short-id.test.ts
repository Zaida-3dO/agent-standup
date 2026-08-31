// Short-id resolution — a GET by a UUID prefix, and the refusal that makes
// it safe to adopt.
//
// Every assertion below names the single source change it would catch,
// because a test whose failure mode nobody can state is a test that gets
// deleted the first time it is inconvenient.
//
// The file is in two halves. The shape predicates are pure and run
// everywhere. The resolution itself is a query, so it is DB-gated in the
// same shape as every other database-backed file here — see
// `scripts/check-db-gated-suites.mjs` for why that exact spelling matters.
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ServiceRuntime, prismaTransactionRunner } from "@/lib/service";
import { defaultSnapshot } from "@/lib/settings";
import { isServiceError } from "@/lib/service/errors";
import { SHORT_ID_MIN_LENGTH, isFullUuid, isShortIdShape } from "@/lib/service/items/resolve-id";
import { ID_DISPLAY_LENGTH, shortenSegment } from "@/lib/nav/breadcrumb";
import {
  createMigratedScratchDatabase,
  dropScratchDatabase,
  scratchDatabaseName,
} from "./helpers/scratch-db";

const SAMPLE_UUID = "422637bc-f311-48a6-a0fd-48811ad596a4";

describe("what the parser will accept as a short id", () => {
  // The agreement the feature turns on. The breadcrumb truncates an id to
  // ID_DISPLAY_LENGTH and invites the reader to copy it; if the parser's
  // floor were raised above that, the product would display a short id it
  // then refuses to resolve. Changing either constant alone fails here.
  it("accepts exactly what the breadcrumb displays", () => {
    expect(SHORT_ID_MIN_LENGTH).toBe(ID_DISPLAY_LENGTH);
    const shown = shortenSegment(SAMPLE_UUID);
    // The crumb appends an ellipsis for display; the id part is what a
    // person selects, and it must be resolvable on its own.
    expect(isShortIdShape(shown.replace("…", ""))).toBe(true);
  });

  // Fails if SHORT_ID_MIN_LENGTH is lowered — the change that would make
  // ambiguity routine rather than remote.
  it("refuses a prefix shorter than the floor", () => {
    expect(isShortIdShape("422637b")).toBe(false);
    expect(isShortIdShape("4226")).toBe(false);
    expect(isShortIdShape("")).toBe(false);
  });

  // Fails if the length window's upper bound is dropped, which would send
  // full UUIDs down the prefix-scan path instead of straight through.
  it("treats a full UUID as a full UUID, not as a prefix", () => {
    expect(isFullUuid(SAMPLE_UUID)).toBe(true);
    expect(isShortIdShape(SAMPLE_UUID)).toBe(false);
  });

  // Fails if the anchors come off the pattern, which would let arbitrary
  // text become a prefix scan instead of an ordinary not-found.
  it("refuses text that is not hex", () => {
    expect(isShortIdShape("no-such-item")).toBe(false);
    expect(isShortIdShape("zzzzzzzz")).toBe(false);
    // The LIKE metacharacters, specifically: these must never reach a
    // pattern position as themselves.
    expect(isShortIdShape("422637%c")).toBe(false);
    expect(isShortIdShape("422637_c")).toBe(false);
  });

  // Fails if hyphens are excluded from the pattern — the natural thing to
  // paste after copying eleven characters of a UUID is `422637bc-f3`.
  it("accepts a prefix that stops inside the hyphenated form", () => {
    expect(isShortIdShape("422637bc-f3")).toBe(true);
    expect(isShortIdShape("422637bc-f311-48a6")).toBe(true);
  });

  // Fails if the pattern is made case-sensitive. Postgres renders uuid
  // lowercase but plenty of sources upper-case it, and a person pasting
  // from one of those should not get a 404.
  it("is case-insensitive", () => {
    expect(isShortIdShape("422637BC")).toBe(true);
    expect(isFullUuid(SAMPLE_UUID.toUpperCase())).toBe(true);
  });
});

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const describeIfDb = testDatabaseUrl ? describe : describe.skip;

describeIfDb("resolving a short id against Postgres", () => {
  const dbName = scratchDatabaseName("short_id");
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

  async function createItem(title: string): Promise<{ id: string }> {
    return (await runtime.call("create_item", {
      title,
      body: "x",
      area: "short-id-tests",
      originType: "auto",
    })) as { id: string };
  }

  /**
   * A task under a fresh project. The transition tests need one: a project
   * has no state of its own (its state derives from its children), so
   * transitioning one is refused for a reason unrelated to short ids.
   */
  async function createTask(title: string): Promise<string> {
    const { id: projectId } = await createItem(`project for ${title}`);
    const created = (await runtime.call("create_task", {
      title,
      body: "x",
      area: "short-id-tests",
      originType: "auto",
      projectId,
    })) as { id: string };
    return created.id;
  }

  /** Rewrites a fresh item's leading hex so it starts with `prefix`. */
  async function createItemWithIdPrefix(title: string, prefix: string): Promise<string> {
    const { id } = await createItem(title);
    const forced = `${prefix}${id.slice(prefix.length)}`;
    await prisma.$executeRawUnsafe(`UPDATE "Item" SET "id" = $1 WHERE "id" = $2`, forced, id);
    return forced;
  }

  /** Runs `call` and returns whatever it threw, or null if it resolved. */
  async function rejectionOf(call: Promise<unknown>): Promise<unknown> {
    return call.then(
      () => null,
      (caught: unknown) => caught,
    );
  }

  it("resolves a unique 8-character prefix to the item", async () => {
    const { id } = await createItem("resolvable by prefix");
    const item = (await runtime.call("get_item", { id: id.slice(0, 8) })) as { id: string };
    // Fails if resolveItemId returns the prefix instead of the canonical
    // id, which is the mistake that would put a truncated id into every
    // downstream write.
    expect(item.id).toBe(id);
  });

  it("resolves a longer prefix too, not only exactly eight", async () => {
    const { id } = await createItem("resolvable by a longer prefix");
    const item = (await runtime.call("get_item", { id: id.slice(0, 13) })) as { id: string };
    expect(item.id).toBe(id);
  });

  it("resolves a short id on the detail read as well as the summary read", async () => {
    const { id } = await createItem("resolvable on detail");
    const detail = (await runtime.call("get_item_detail", { id: id.slice(0, 8) })) as {
      item: { id: string };
    };
    // Fails if only get_item was wired and get_item_detail was left behind
    // — the read the UI actually calls.
    expect(detail.item.id).toBe(id);
  });

  it("refuses an ambiguous prefix and names every candidate", async () => {
    const prefix = "abcd1234";
    const first = await createItemWithIdPrefix("first colliding item", prefix);
    const second = await createItemWithIdPrefix("second colliding item", prefix);

    const error = await rejectionOf(runtime.call("get_item", { id: prefix }));

    // The heart of the feature. Fails if the resolver picks `rows[0]`
    // instead of refusing — the silent wrong-row failure that would make
    // short ids unsafe to adopt at all.
    expect(error).not.toBeNull();
    expect(isServiceError(error)).toBe(true);
    if (!isServiceError(error)) throw new Error("unreachable");
    expect(error.code).toBe("invalid_input");
    expect(error.fields).toEqual(["id"]);
    // Both candidates named, so the caller can pick without a second call.
    // Fails if the message drops the list and only says "ambiguous".
    expect(error.message).toContain(first);
    expect(error.message).toContain(second);
    expect(error.message).toContain("first colliding item");
    expect(error.details?.candidates).toHaveLength(2);
  });

  it("404s an unknown prefix rather than reporting ambiguity", async () => {
    const error = await rejectionOf(runtime.call("get_item", { id: "ffffffff" }));
    expect(isServiceError(error)).toBe(true);
    if (!isServiceError(error)) throw new Error("unreachable");
    // Fails if the zero-match branch is folded into the ambiguity branch,
    // which would turn every typo into a 400 that claims candidates exist.
    expect(error.code).toBe("not_found");
  });

  it("leaves the full-UUID path exactly as it was", async () => {
    const { id } = await createItem("resolvable in full");
    const item = (await runtime.call("get_item", { id })) as { id: string };
    expect(item.id).toBe(id);

    // An unknown-but-well-formed UUID still 404s, and must not be turned
    // into a prefix scan. Fails if the full-UUID short-circuit is removed.
    const error = await rejectionOf(
      runtime.call("get_item", { id: "00000000-0000-4000-8000-000000000000" }),
    );
    expect(isServiceError(error)).toBe(true);
    if (!isServiceError(error)) throw new Error("unreachable");
    expect(error.code).toBe("not_found");
  });

  // -- The writes ---------------------------------------------------------
  //
  // Short-id resolution shipped on the reads only. That is worse than not
  // shipping it: an agent handed a short id could `get_item` it, reason
  // about it, and then fail at the one call that changes state -- and the
  // successful read makes the "my server must be a different installation"
  // misdiagnosis MORE likely, not less. Two crews reached exactly that
  // conclusion from a bare `not_found` on an id.
  //
  // Each test below names the write it covers, because "wire the resolver
  // into the writes" is the kind of change that gets applied to eight of
  // nine handlers and passes a test that only checks one.

  it("resolves a short id on transition_item, the write that was reported", async () => {
    const id = await createTask("transitionable by prefix");
    await runtime.call("transition_item", { id: id.slice(0, 8), to: "on_deck" });
    // Read back by FULL id: the point is that the write landed on the right
    // row, not merely that the call returned without throwing. Fails if the
    // handler resolves for its own lookup but writes the prefix, or if the
    // resolver is not called here at all (the reported bug).
    const after = (await runtime.call("get_item", { id })) as { state: string };
    expect(after.state).toBe("on_deck");
  });

  it("resolves a short id on note, and stores the canonical id on the event", async () => {
    const { id } = await createItem("notable by prefix");
    await runtime.call("note", { itemId: id.slice(0, 8), body: "left against a short id" });
    // The event has to hang off the canonical id, or the note is written to
    // an item that does not exist and is invisible on the item's own
    // history. Fails if the handler resolves only for its existence check
    // and then writes `input.itemId` unresolved -- the subtle half of this
    // bug, which a "did it throw" test would miss entirely.
    // `full` because `body` is one of the two columns the slim shape omits.
    const history = (await runtime.call("get_item_history", { id, full: true })) as unknown as {
      entries: readonly { type: string; body?: string | null }[];
    };
    expect(history.entries.some((entry) => entry.body === "left against a short id")).toBe(true);
  });

  it("resolves a short id on update_item", async () => {
    const { id } = await createItem("updatable by prefix");
    await runtime.call("update_item", { id: id.slice(0, 8), priority: "P1" });
    const after = (await runtime.call("get_item", { id, full: true })) as { priority: string };
    expect(after.priority).toBe("P1");
  });

  it("resolves a short id on claim, so the assignment names the real item", async () => {
    const { id } = await createItem("claimable by prefix");
    await runtime.call("claim", {
      itemId: id.slice(0, 8),
      role: "builder",
      holderType: "agent",
      holderId: "short-id-tester",
      sessionId: "session-short-id",
      machine: "test-machine",
    });
    const detail = (await runtime.call("get_item_detail", { id })) as unknown as {
      assignments: readonly { holderId: string }[];
    };
    // Fails if claim writes the prefix into Assignment.itemId, which would
    // produce an assignment that no read of this item ever returns.
    expect(detail.assignments.some((a) => a.holderId === "short-id-tester")).toBe(true);
  });

  // -- The ambiguity refusal, per write -------------------------------------
  //
  // The whole safety story of the feature, and the thing most likely to be
  // lost when the resolver is wired into a new call site by hand: a prefix
  // matching two items must name both and refuse, never pick one. Asserted
  // per handler rather than once, because each call site is its own wiring.

  it("refuses an ambiguous prefix on every write, naming both candidates", async () => {
    const prefix = "beef1234";
    const first = await createItemWithIdPrefix("first ambiguous write target", prefix);
    const second = await createItemWithIdPrefix("second ambiguous write target", prefix);

    const calls: { operation: string; args: Record<string, unknown>; field: string }[] = [
      { operation: "transition_item", args: { id: prefix, to: "on_deck" }, field: "id" },
      { operation: "update_item", args: { id: prefix, priority: "P1" }, field: "id" },
      { operation: "note", args: { itemId: prefix, body: "ambiguous" }, field: "itemId" },
      {
        operation: "checkpoint",
        args: { itemId: prefix, sessionId: "s", body: "ambiguous" },
        field: "itemId",
      },
      {
        operation: "claim",
        args: {
          itemId: prefix,
          role: "builder",
          holderType: "agent",
          holderId: "h",
          sessionId: "s2",
          machine: "m",
        },
        field: "itemId",
      },
      { operation: "release", args: { itemId: prefix, sessionId: "s2" }, field: "itemId" },
    ];

    for (const { operation, args, field } of calls) {
      const error = await rejectionOf(runtime.call(operation, args));
      expect(error, `${operation} did not refuse an ambiguous prefix`).not.toBeNull();
      expect(isServiceError(error), `${operation} threw a non-service error`).toBe(true);
      if (!isServiceError(error)) throw new Error("unreachable");
      // A silent pick is the failure this whole feature is designed around,
      // and it would show up here as a `not_found`, a guard rejection, or a
      // success -- anything but `invalid_input`.
      expect(error.code, `${operation} refused with the wrong code`).toBe("invalid_input");
      // Reported against the field the CALLER used. Fails if a call site
      // passes no field name and the refusal says `id` to a caller whose
      // parameter is `itemId`.
      expect(error.fields, `${operation} named the wrong field`).toEqual([field]);
      // Both candidates named, so the caller can disambiguate without a
      // second call. Fails if a call site resolves ambiguity by picking.
      expect(error.message, `${operation} did not name both candidates`).toContain(first);
      expect(error.message).toContain(second);
    }
  });

  it("names its own field when the ambiguous reference is a secondary one", async () => {
    const prefix = "dead1234";
    await createItemWithIdPrefix("first secondary target", prefix);
    await createItemWithIdPrefix("second secondary target", prefix);
    const { id } = await createItem("the item being reparented");

    const error = await rejectionOf(runtime.call("reparent_item", { id, parentId: prefix }));
    expect(isServiceError(error)).toBe(true);
    if (!isServiceError(error)) throw new Error("unreachable");
    expect(error.code).toBe("invalid_input");
    // The operation takes TWO item references. A refusal saying `id` would
    // point at the one that was fine. Fails if the resolver's field
    // argument is dropped and it falls back to its "id" default.
    expect(error.fields).toEqual(["parentId"]);
  });

  it("leaves the inbox sentinel alone rather than treating it as an id", async () => {
    const { id } = await createItem("bound for the inbox");
    // "inbox" is not hex, so `isShortIdShape` refuses it and the resolver
    // hands it back untouched. Fails if the resolver's shape test stops
    // excluding non-hex text, which would send the sentinel into the prefix
    // scan and break every create/reparent that uses it.
    //
    // Honest limit, established by mutation rather than assumed: this does
    // NOT pin the *ordering* of the sentinel branch against the resolve.
    // Moving the resolve above the sentinel check leaves all 20 tests green,
    // because on a non-hex reference the resolver is a no-op. The ordering
    // in the source is therefore a readability choice, documented as such
    // there, and not a behaviour this suite can defend.
    const moved = (await runtime.call("reparent_item", { id, parentId: "inbox" })) as {
      id: string;
    };
    expect(moved.id).toBe(id);
  });

  it("still refuses a non-id string the way it always did", async () => {
    const error = await rejectionOf(runtime.call("get_item", { id: "no-such-item" }));
    expect(isServiceError(error)).toBe(true);
    if (!isServiceError(error)) throw new Error("unreachable");
    // Fails if a non-hex reference is routed into the prefix scan, which
    // would change an existing refusal's code — the thing "strictly
    // additive" promises will not happen.
    expect(error.code).toBe("not_found");
  });
});
