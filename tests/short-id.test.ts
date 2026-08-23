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
