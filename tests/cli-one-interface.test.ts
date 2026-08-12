// AC5 — the two bindings are genuinely behind ONE interface.
//
// **What would make this test hollow, stated first so it can be checked.**
// Exercising each binding separately and asserting each looks reasonable
// proves nothing about them being behind one interface: two independent
// implementations that happened to both work would pass it. So every case
// below drives *one command* through `runCommand` twice — once with the
// `direct` binding, once with the `http` binding — and asserts the two
// outcomes are equal **to each other**. The assertion compares the bindings,
// never each against a literal, so it cannot pass while they differ.
//
// **The `http` side is a real round trip, not a stub.** Its `fetch` is wired
// to the actual route handlers in `src/app/api/items/**`, so a request goes
// out as a method, a path and a JSON body, comes back as a status and a JSON
// error envelope, and is parsed back into a `Rejection`. Both bindings reach
// the *same* service object, which is what isolates the variable: any
// difference the test sees is a difference between the two bindings, because
// everything below them is one instance.
//
// This is the property row #94's conformance harness will assert across all
// four adapters (SCHEMA.md §22, DECISIONS §13f). Building it testable now is
// the point of row #79.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { InvalidInputError, NotFoundError } from "@/lib/service";
import { createDirectBinding, createHttpBinding, runCommand } from "@/lib/cli";
import type { Binding, RunOutcome } from "@/lib/cli";

/** The items both bindings read and write. Reset per test. */
const items = new Map<string, Record<string, unknown>>();

const createInput = z
  .object({ title: z.string().min(1), priority: z.string().optional() })
  .strict();
const getInput = z.object({ id: z.string().min(1) }).strict();
const listInput = z.object({ state: z.string().optional() }).strict();

function invalid(issues: z.ZodIssue[]): InvalidInputError {
  const fields = [...new Set(issues.map((issue) => issue.path.map(String).join(".")))].filter(
    (path) => path.length > 0,
  );
  return new InvalidInputError(
    `Invalid input: ${issues.map((issue) => issue.message).join("; ")}`,
    {
      fields,
    },
  );
}

/**
 * The one service both bindings reach.
 *
 * Not a mock of the *rules*: the schemas below do the refusing, so every
 * rejection compared in this file is a real parse failure travelling through
 * two different transports. It stands in only for the transaction and the
 * database, which is the same substitution `ServiceRuntime`'s own tests make.
 */
const sharedService = {
  async call(name: string, input: unknown): Promise<unknown> {
    if (name === "create_item") {
      const parsed = createInput.safeParse(input);
      if (!parsed.success) throw invalid(parsed.error.issues);
      const id = `item-${items.size + 1}`;
      const item = { id, ...parsed.data };
      items.set(id, item);
      return item;
    }
    if (name === "get_item") {
      const parsed = getInput.safeParse(input);
      if (!parsed.success) throw invalid(parsed.error.issues);
      const item = items.get(parsed.data.id);
      if (!item) throw new NotFoundError(`No item ${parsed.data.id}.`, { fields: ["id"] });
      return item;
    }
    if (name === "list_items") {
      const parsed = listInput.safeParse(input);
      if (!parsed.success) throw invalid(parsed.error.issues);
      return { items: [...items.values()], nextCursor: null };
    }
    throw new NotFoundError(`No such operation: ${name}.`, { fields: ["operation"] });
  },
};

// The route handlers import `service` from the composition root at module
// scope. Replacing that module is what puts the HTTP adapter on the same
// service instance as the `direct` binding — and it means the HTTP side is
// reached exactly as a deployed one is, through its own import, rather than
// through a parameter this test handed it.
vi.mock("@/lib/service/live", () => ({ service: sharedService }));

const { GET: itemsGet, POST: itemsPost } = await import("@/app/api/items/route");
const { GET: itemGet, PATCH: itemPatch } = await import("@/app/api/items/[id]/route");

/**
 * A `fetch` that dispatches to the real route handlers.
 *
 * Next's route modules are plain async functions over `Request`, so this
 * needs no server — but it is still the genuine adapter code path: the same
 * query-string parsing, the same `service.call`, and the same
 * `serviceErrorResponse` status mapping a deployed server runs. A stub
 * returning a hand-built body would have removed the HTTP adapter from the
 * comparison and left it comparing the CLI to itself.
 */
async function routeFetch(url: string, init: RequestInit): Promise<Response> {
  const parsed = new URL(url);
  const request = new Request(url, init);
  const match = /^\/api\/items(?:\/([^/]+))?$/.exec(parsed.pathname);
  if (!match) return new Response("not found", { status: 404 });

  const id = match[1];
  if (id === undefined) {
    return init.method === "POST" ? itemsPost(request) : itemsGet(request);
  }
  const params = Promise.resolve({ id: decodeURIComponent(id) });
  return init.method === "PATCH" ? itemPatch(request, { params }) : itemGet(request, { params });
}

function directBinding(): Binding {
  return createDirectBinding({ service: sharedService });
}

function httpBinding(): Binding {
  return createHttpBinding({ baseUrl: "http://server.invalid", fetch: routeFetch });
}

/** Everything about an outcome that both bindings must agree on. */
function comparable(outcome: RunOutcome) {
  return { envelope: outcome.envelope, exitCode: outcome.exitCode };
}

/** Runs one command on both bindings and returns both outcomes. */
async function bothBindings(argv: readonly string[]) {
  return {
    direct: await runCommand(argv, directBinding()),
    http: await runCommand(argv, httpBinding()),
  };
}

beforeEach(() => {
  items.clear();
});

describe("both bindings sit behind one interface", () => {
  it("returns the same accepted result for the same command", async () => {
    items.set("item-1", { id: "item-1", title: "a task" });

    const { direct, http } = await bothBindings(["item", "get", "item-1"]);

    expect(comparable(http)).toEqual(comparable(direct));
    expect(direct.envelope).toEqual({ ok: true, data: { id: "item-1", title: "a task" } });
    // The bindings differ in exactly one visible way, and it is the one they
    // are supposed to: which one ran.
    expect(direct.binding).toBe("direct");
    expect(http.binding).toBe("http");
  });

  it("returns the same rejection, with the same code and fields, for a missing item", async () => {
    const { direct, http } = await bothBindings(["item", "get", "missing-id"]);

    expect(comparable(http)).toEqual(comparable(direct));
    if (direct.envelope.ok) throw new Error("expected a rejection");
    expect(direct.envelope.error.code).toBe("not_found");
    expect(direct.envelope.error.fields).toEqual(["id"]);
    expect(direct.exitCode).toBe(3);
  });

  it("returns the same invalid-input rejection, with the same offending field", async () => {
    // `--title` missing: the operation's own schema refuses it, so the
    // rejection is the service's and both bindings must carry it intact.
    const { direct, http } = await bothBindings(["item", "create", "--priority", "high"]);

    expect(comparable(http)).toEqual(comparable(direct));
    if (direct.envelope.ok) throw new Error("expected a rejection");
    expect(direct.envelope.error.code).toBe("invalid_input");
    expect(direct.envelope.error.fields).toEqual(["title"]);
    expect(direct.exitCode).toBe(2);
  });

  it("agrees on an accepted write, and both bindings see the state it left", async () => {
    const created = await runCommand(["item", "create", "--title", "written once"], httpBinding());
    expect(created.envelope).toEqual({
      ok: true,
      data: { id: "item-1", title: "written once" },
    });

    // Created over HTTP; read back over `direct`. Two bindings not reaching
    // the same rules would pass every rejection comparison above and still
    // fail this.
    const readBack = await runCommand(["item", "get", "item-1"], directBinding());
    expect(readBack.envelope).toEqual({ ok: true, data: { id: "item-1", title: "written once" } });
  });

  it("resolves an alias to the same outcome on both bindings", async () => {
    items.set("item-1", { id: "item-1", title: "aliased" });

    // `show` is the alias for `item get`. Four runs: the alias and the long
    // form, on each binding. All four must agree — which is what "aliases
    // resolve to the same operation, so nothing downstream sees them"
    // (SCHEMA.md §20) means as a property rather than a claim.
    const outcomes = [
      await runCommand(["show", "item-1"], directBinding()),
      await runCommand(["item", "get", "item-1"], directBinding()),
      await runCommand(["show", "item-1"], httpBinding()),
      await runCommand(["item", "get", "item-1"], httpBinding()),
    ].map(comparable);

    const [first, ...rest] = outcomes;
    for (const outcome of rest) {
      expect(outcome).toEqual(first);
    }
    expect(first).toEqual({
      envelope: { ok: true, data: { id: "item-1", title: "aliased" } },
      exitCode: 0,
    });
  });

  it("agrees on a list, including its shape", async () => {
    items.set("item-1", { id: "item-1", title: "one" });
    items.set("item-2", { id: "item-2", title: "two" });

    const { direct, http } = await bothBindings(["item", "list"]);

    expect(comparable(http)).toEqual(comparable(direct));
    expect(direct.envelope).toEqual({
      ok: true,
      data: {
        items: [
          { id: "item-1", title: "one" },
          { id: "item-2", title: "two" },
        ],
        nextCursor: null,
      },
    });
  });
});
