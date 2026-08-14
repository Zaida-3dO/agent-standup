// MILESTONES.md #103 — terminal items out of the default read.
//
// Three layers, one behaviour, and they are tested separately on purpose:
// the *default* lives in the operation schema, the *derivation* half lives
// only in `get_board` (a project has no honest raw state to filter on), and
// the *spelling* of the opt-in differs per adapter (`includeTerminal` over
// MCP and the service, `?includeTerminal` over HTTP, `--all` on the command
// line). A test of only the service would pass while `--all` did nothing.
//
// The pure parts — the terminal-state table and the query-string reader —
// need no database and are asserted first. Everything after that needs real
// Postgres, because what is being proved is a WHERE clause, and skips
// without TEST_DATABASE_URL like every other DB-backed file here.
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ServiceRuntime, prismaTransactionRunner } from "@/lib/service";
import { defaultSnapshot } from "@/lib/settings";
import { TERMINAL_STATES, isTerminalState } from "@/lib/service/board/columns";
import { parseBooleanParam } from "@/app/api/_shared/query";
import { COMMANDS } from "@/lib/cli";
import {
  createMigratedScratchDatabase,
  dropScratchDatabase,
  scratchDatabaseName,
} from "./helpers/scratch-db";
import type { BoardOutput } from "@/lib/service/operations/get-board";

describe("which states are terminal", () => {
  // Written out literally rather than read back off `STATES_BY_COLUMN`,
  // for the reason `states.ts` gives about circularity: an assertion that
  // sourced its expectation from the implementation would pass whatever
  // the implementation contained.
  it("is exactly merged, research_done, wont_do and cancelled", () => {
    expect([...TERMINAL_STATES].sort()).toEqual([
      "cancelled",
      "merged",
      "research_done",
      "wont_do",
    ]);
  });

  it("does not count a state that is merely inactive — paused and blocked are not terminal", () => {
    expect(isTerminalState("paused")).toBe(false);
    expect(isTerminalState("blocked")).toBe(false);
    expect(isTerminalState("someday")).toBe(false);
  });

  it("counts every one of the four", () => {
    expect(isTerminalState("merged")).toBe(true);
    expect(isTerminalState("research_done")).toBe(true);
    expect(isTerminalState("wont_do")).toBe(true);
    expect(isTerminalState("cancelled")).toBe(true);
  });
});

describe("the HTTP adapter's boolean query parameter", () => {
  it("reads a bare flag as true — `?includeTerminal` with no value", () => {
    expect(parseBooleanParam("")).toBe(true);
  });

  it("reads the spelled-out forms", () => {
    expect(parseBooleanParam("true")).toBe(true);
    expect(parseBooleanParam("1")).toBe(true);
    expect(parseBooleanParam("false")).toBe(false);
    expect(parseBooleanParam("0")).toBe(false);
  });

  it("passes anything else through unchanged, so the operation's schema is what refuses it", () => {
    // Not `false`: mapping an unrecognised string to "off" would be this
    // adapter inventing an answer the schema is the one place to give.
    expect(parseBooleanParam("yes")).toBe("yes");
  });
});

describe("`standup item list --all`", () => {
  const list = COMMANDS.find((c) => c.noun === "item" && c.verb === "list");
  if (!list) throw new Error("no `item list` command");

  it("sets includeTerminal false when --all is absent", () => {
    expect(list.buildInput([], { area: "web" })).toEqual({
      ok: true,
      input: { area: "web", includeTerminal: false },
    });
  });

  it("sets includeTerminal true for a bare --all, and does not leak `all` through as its own field", () => {
    const built = list.buildInput([], { all: true, area: "web" });
    expect(built).toEqual({ ok: true, input: { area: "web", includeTerminal: true } });
  });

  it("refuses `--all value` rather than silently accepting it", () => {
    const built = list.buildInput([], { all: "yes" });
    expect(built.ok).toBe(false);
    if (built.ok) throw new Error("unreachable");
    expect(built.envelope.error.fields).toEqual(["all"]);
  });

  it("still refuses a bare value-taking flag alongside --all", () => {
    const built = list.buildInput([], { all: true, area: true });
    expect(built.ok).toBe(false);
  });
});

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const describeIfDb = testDatabaseUrl ? describe : describe.skip;

describeIfDb("terminal items are out of the default read", () => {
  const dbName = scratchDatabaseName("terminal_default");
  let scratchUrl: string;
  let prisma: PrismaClient;
  let runtime: ServiceRuntime;
  let boardRoute: typeof import("@/app/api/board/route");
  let itemsRoute: typeof import("@/app/api/items/route");

  beforeAll(async () => {
    scratchUrl = createMigratedScratchDatabase(testDatabaseUrl!, dbName).url;
    // The route modules reach `service/live.ts`'s process-global singleton,
    // so DATABASE_URL has to point at the scratch database before they are
    // imported — the same ordering constraint tests/board-routes.test.ts
    // documents.
    process.env.DATABASE_URL = scratchUrl;
    boardRoute = await import("@/app/api/board/route");
    itemsRoute = await import("@/app/api/items/route");
    prisma = new PrismaClient({ datasourceUrl: scratchUrl });
    runtime = new ServiceRuntime({
      transaction: prismaTransactionRunner(prisma),
      resolveSnapshot: async () => defaultSnapshot(),
    });
  }, 60_000);

  afterAll(async () => {
    await prisma?.$disconnect();
    dropScratchDatabase(testDatabaseUrl!, dbName);
  });

  async function createItem(overrides: Record<string, unknown>): Promise<{ id: string }> {
    return runtime.call("create_item", {
      title: "x",
      body: "x",
      area: "terminal-tests",
      originType: "auto",
      ...overrides,
    }) as Promise<{ id: string }>;
  }

  // Set directly rather than transitioned: reaching `merged` legitimately
  // needs artifacts nothing can write yet (MILESTONES.md #98), and this
  // file is about a read filter, not about the state machine.
  async function setState(id: string, state: string): Promise<void> {
    await prisma.$executeRawUnsafe(
      `UPDATE "Item" SET "state" = $1::"ItemState" WHERE "id" = $2`,
      state,
      id,
    );
  }

  async function listIds(input: Record<string, unknown>): Promise<string[]> {
    const result = (await runtime.call("list_items", input)) as {
      items: readonly { id: string }[];
    };
    return result.items.map((i) => i.id);
  }

  describe("list_items", () => {
    it("omits a merged item that an unfiltered read would otherwise return", async () => {
      const area = "list-default-merged";
      const live = await createItem({ area });
      const finished = await createItem({ area });
      await setState(finished.id, "merged");

      const ids = await listIds({ area });
      expect(ids).toContain(live.id);
      expect(ids).not.toContain(finished.id);
      expect(ids).toHaveLength(1);
    });

    it("omits every one of the four terminal states, not just merged", async () => {
      const area = "list-default-all-four";
      const live = await createItem({ area });
      const finished: string[] = [];
      for (const state of ["merged", "research_done", "wont_do", "cancelled"]) {
        const item = await createItem({ area });
        await setState(item.id, state);
        finished.push(item.id);
      }

      expect(await listIds({ area })).toEqual([live.id]);
      // And the four really are in the table — otherwise the assertion
      // above would pass against an empty area.
      const withTerminal = await listIds({ area, includeTerminal: true });
      expect(withTerminal.sort()).toEqual([live.id, ...finished].sort());
    });

    it("keeps a paused item, which is inactive but not finished", async () => {
      const area = "list-default-paused";
      const paused = await createItem({ area });
      await setState(paused.id, "paused");
      expect(await listIds({ area })).toEqual([paused.id]);
    });

    it("returns terminal items when includeTerminal is true", async () => {
      const area = "list-opt-in";
      const finished = await createItem({ area });
      await setState(finished.id, "cancelled");

      expect(await listIds({ area })).toEqual([]);
      expect(await listIds({ area, includeTerminal: true })).toEqual([finished.id]);
    });

    it("honours an explicit terminal state filter even with includeTerminal left off", async () => {
      // The bug this guards: applying the default on top of an explicit
      // filter would answer `state: "merged"` with an empty list, which is
      // both wrong and silent.
      const area = "list-explicit-state";
      const finished = await createItem({ area });
      await setState(finished.id, "merged");

      expect(await listIds({ area, state: "merged" })).toEqual([finished.id]);
    });

    it("an explicit non-terminal state filter still excludes everything else", async () => {
      const area = "list-explicit-nonterminal";
      const live = await createItem({ area });
      const finished = await createItem({ area });
      await setState(finished.id, "merged");

      expect(await listIds({ area, state: "on_deck" })).toEqual([live.id]);
    });

    it("does not spend the page limit on rows it then drops", async () => {
      // A filter applied after the LIMIT would return fewer than `limit`
      // live items while claiming there is no further page.
      const area = "list-limit-interaction";
      const live: string[] = [];
      for (let i = 0; i < 3; i++) {
        const finished = await createItem({ area });
        await setState(finished.id, "merged");
        live.push((await createItem({ area })).id);
      }

      const result = (await runtime.call("list_items", { area, limit: 2 })) as {
        items: readonly { id: string }[];
        nextCursor: string | null;
      };
      expect(result.items).toHaveLength(2);
      expect(result.nextCursor).not.toBeNull();
    });
  });

  describe("get_board", () => {
    it("leaves the completed column empty by default", async () => {
      const area = "board-default";
      const project = await createItem({ area });
      const live = await createItem({ area, parentId: project.id });
      const finished = await createItem({ area, parentId: project.id });
      await setState(finished.id, "merged");

      const board = (await runtime.call("get_board", { area })) as BoardOutput;
      expect(board.completed).toEqual([]);
      expect(board.backlog.map((e) => e.item.id)).toContain(live.id);
    });

    it("returns the completed column when includeTerminal is true", async () => {
      const area = "board-opt-in";
      const project = await createItem({ area });
      const finished = await createItem({ area, parentId: project.id });
      await setState(finished.id, "merged");

      const board = (await runtime.call("get_board", {
        area,
        includeTerminal: true,
      })) as BoardOutput;
      expect(board.completed.map((e) => e.item.id)).toContain(finished.id);
    });

    it("drops a project whose whole subtree is finished — its derived column, not its stored state", async () => {
      // The interesting case: the project's own `state` column still reads
      // `on_deck` (the creation default nothing ever moves), so a SQL
      // filter on raw state would keep it. It is dropped because its
      // *derived* column is completed.
      const area = "board-finished-project";
      const project = await createItem({ area });
      const child = await createItem({ area, parentId: project.id });
      await setState(child.id, "merged");

      const stored = await prisma.$queryRawUnsafe<{ state: string }[]>(
        `SELECT "state" FROM "Item" WHERE "id" = $1`,
        project.id,
      );
      expect(stored[0]?.state).toBe("on_deck");

      const board = (await runtime.call("get_board", { area })) as BoardOutput;
      const everywhere = [
        ...board.backlog,
        ...board.in_progress,
        ...board.waiting,
        ...board.completed,
      ];
      expect(everywhere.map((e) => e.item.id)).not.toContain(project.id);

      const withTerminal = (await runtime.call("get_board", {
        area,
        includeTerminal: true,
      })) as BoardOutput;
      expect(withTerminal.completed.map((e) => e.item.id)).toContain(project.id);
    });

    it("keeps a project with one finished child and one live child", async () => {
      // The regression a naive "drop anything completed" would cause: the
      // subtree walk must stay unfiltered, or removing the executing child
      // from the walk would derive `completed` and hide a live project.
      const area = "board-mixed-project";
      const project = await createItem({ area });
      const live = await createItem({ area, parentId: project.id });
      const finished = await createItem({ area, parentId: project.id });
      await setState(live.id, "executing");
      await setState(finished.id, "merged");

      const board = (await runtime.call("get_board", { area })) as BoardOutput;
      expect(board.in_progress.map((e) => e.item.id)).toContain(project.id);
      expect(board.completed).toEqual([]);
    });

    it("keeps an empty project, which is backlog rather than completed", async () => {
      const area = "board-empty-project";
      const project = await createItem({ area });
      const board = (await runtime.call("get_board", { area })) as BoardOutput;
      expect(board.backlog.map((e) => e.item.id)).toContain(project.id);
    });

    it("honours an explicit terminal state filter even with includeTerminal left off", async () => {
      const area = "board-explicit-state";
      const project = await createItem({ area });
      const finished = await createItem({ area, parentId: project.id });
      await setState(finished.id, "merged");

      const board = (await runtime.call("get_board", { area, state: "merged" })) as BoardOutput;
      expect(board.completed.map((e) => e.item.id)).toEqual([finished.id]);
    });
  });

  describe("the HTTP routes pass the flag through", () => {
    async function getJson(route: { GET: (r: Request) => Promise<Response> }, url: string) {
      const response = await route.GET(new Request(url));
      return { status: response.status, body: (await response.json()) as Record<string, unknown> };
    }

    it("GET /api/items excludes terminal work by default and includes it on request", async () => {
      const area = "route-items-terminal";
      const live = (await runtime.call("create_item", {
        title: "x",
        body: "x",
        area,
        originType: "auto",
      })) as { id: string };
      const finished = (await runtime.call("create_item", {
        title: "x",
        body: "x",
        area,
        originType: "auto",
      })) as { id: string };
      await setState(finished.id, "merged");

      const base = `http://localhost/api/items?area=${area}`;
      const byDefault = await getJson(itemsRoute, base);
      expect((byDefault.body.items as { id: string }[]).map((i) => i.id)).toEqual([live.id]);

      const optedIn = await getJson(itemsRoute, `${base}&includeTerminal=true`);
      expect((optedIn.body.items as { id: string }[]).map((i) => i.id).sort()).toEqual(
        [live.id, finished.id].sort(),
      );

      // The bare-flag spelling reaches the same place.
      const bareFlag = await getJson(itemsRoute, `${base}&includeTerminal`);
      expect((bareFlag.body.items as { id: string }[]).map((i) => i.id).sort()).toEqual(
        [live.id, finished.id].sort(),
      );
    });

    it("GET /api/board leaves the completed column empty by default and fills it on request", async () => {
      const area = "route-board-terminal";
      const project = (await runtime.call("create_item", {
        title: "x",
        body: "x",
        area,
        originType: "auto",
      })) as { id: string };
      const finished = (await runtime.call("create_item", {
        title: "x",
        body: "x",
        area,
        originType: "auto",
        parentId: project.id,
      })) as { id: string };
      await setState(finished.id, "merged");

      const base = `http://localhost/api/board?area=${area}`;
      const byDefault = await getJson(boardRoute, base);
      expect((byDefault.body.board as BoardOutput).completed).toEqual([]);

      const optedIn = await getJson(boardRoute, `${base}&includeTerminal=true`);
      expect((optedIn.body.board as BoardOutput).completed.map((e) => e.item.id).sort()).toEqual(
        [project.id, finished.id].sort(),
      );
    });

    it("refuses an uninterpretable includeTerminal rather than guessing", async () => {
      const response = await itemsRoute.GET(
        new Request("http://localhost/api/items?includeTerminal=maybe"),
      );
      expect(response.status).toBe(400);
      const body = (await response.json()) as { error: { code: string; fields?: string[] } };
      expect(body.error.code).toBe("invalid_input");
      expect(body.error.fields).toContain("includeTerminal");
    });
  });
});
