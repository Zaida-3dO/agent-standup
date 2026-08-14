// MILESTONES.md #39 — the requests `src/lib/task-shim/client.ts` builds
// against the items API (#26, #27), and how it reads a response back into
// `ShimTask`. Same shape as `tests/cli-http-binding.test.ts` — a captured
// `fetch` and a canned `Response` — proving this surface's *own* request
// shape rather than re-testing the routes themselves, which #26/#27 already
// cover.
import { describe, expect, it } from "vitest";
import { createTask, getTask, listTasks, transitionTask, updateTask } from "@/lib/task-shim/client";

function capture(response: Response) {
  const seen: { url: string; init: RequestInit }[] = [];
  return {
    seen,
    fetch: async (url: string, init: RequestInit) => {
      seen.push({ url, init });
      return response;
    },
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const baseUrl = "https://example.test";

describe("createTask", () => {
  it("posts to /api/items with originType source, and unwraps the item", async () => {
    const { seen, fetch } = capture(
      json({
        item: { id: "item-1", title: "T", body: "B", state: "on_deck", area: "web", repo: null },
      }),
    );
    const result = await createTask({ baseUrl, fetch }, { title: "T", body: "B", area: "web" });

    expect(seen[0]?.url).toBe("https://example.test/api/items");
    expect(seen[0]?.init.method).toBe("POST");
    expect(JSON.parse(seen[0]?.init.body as string)).toEqual({
      title: "T",
      body: "B",
      area: "web",
      originType: "source",
    });
    expect(result).toEqual({
      ok: true,
      data: { id: "item-1", title: "T", body: "B", status: "todo", repo: null, area: "web" },
    });
  });

  it("includes repo in the body only when supplied", async () => {
    const { seen, fetch } = capture(json({ item: { id: "i", area: "web", state: "on_deck" } }));
    await createTask({ baseUrl, fetch }, { title: "T", body: "B", area: "web", repo: "web" });
    expect(JSON.parse(seen[0]?.init.body as string)).toMatchObject({ repo: "web" });
  });
});

describe("getTask", () => {
  it("gets /api/items/<id> with no body, percent-encoding the id, asking for the full record", async () => {
    const { seen, fetch } = capture(json({ item: { id: "a/b", area: "web", state: "executing" } }));
    await getTask({ baseUrl, fetch }, "a/b");
    // `?full=true` is not optional for this caller: `ShimTask` carries
    // `body`, `area` and `repo`, none of which the slim default returns
    // (MILESTONES.md #107), and `toShimTask` would fill them with empty
    // strings rather than fail — a silent wrong answer, not a loud one.
    expect(seen[0]?.url).toBe("https://example.test/api/items/a%2Fb?full=true");
    expect(seen[0]?.init.method).toBe("GET");
    expect(seen[0]?.init.body).toBeUndefined();
  });
});

describe("updateTask", () => {
  it("patches /api/items/<id> with only the given edits, id out of the body", async () => {
    const { seen, fetch } = capture(
      json({ item: { id: "item-1", area: "web", state: "on_deck" } }),
    );
    await updateTask({ baseUrl, fetch }, "item-1", { title: "Renamed" });
    expect(seen[0]?.url).toBe("https://example.test/api/items/item-1");
    expect(seen[0]?.init.method).toBe("PATCH");
    expect(JSON.parse(seen[0]?.init.body as string)).toEqual({ title: "Renamed" });
  });
});

describe("listTasks", () => {
  it("puts state, repo and area in the query string", async () => {
    const { seen, fetch } = capture(json({ items: [], nextCursor: null }));
    await listTasks({ baseUrl, fetch }, { state: "executing", repo: "web", area: "infra" });
    const url = new URL(seen[0]?.url as string);
    expect(url.pathname).toBe("/api/items");
    expect(url.searchParams.get("state")).toBe("executing");
    expect(url.searchParams.get("repo")).toBe("web");
    expect(url.searchParams.get("area")).toBe("infra");
  });

  it("sends only the projection opt-in when no filters are given", async () => {
    const { seen, fetch } = capture(json({ items: [], nextCursor: null }));
    await listTasks({ baseUrl, fetch }, {});
    // Same reason as `getTask` above — the shim needs the whole record.
    expect(seen[0]?.url).toBe("https://example.test/api/items?full=true");
  });

  it("asks for finished work when includeTerminal is set", async () => {
    // The endpoint excludes terminal states by default, so a client that
    // cannot send this parameter can only ever see live work. Dropping the
    // `includeTerminal` line from `client.ts` makes this fail.
    const { seen, fetch } = capture(json({ items: [], nextCursor: null }));
    await listTasks({ baseUrl, fetch }, { includeTerminal: true });
    const url = new URL(seen[0]?.url as string);
    expect(url.searchParams.get("includeTerminal")).toBe("true");
  });

  it("omits includeTerminal entirely when it is false, rather than sending false", async () => {
    // The server's default is already `false`, so sending it says nothing
    // the omission does not.
    //
    // `full=true` is still there, and its presence is what makes this
    // assertion meaningful rather than weaker: the two parameters are
    // treated differently on purpose. `full` goes on every call because
    // `ShimTask` needs fields the slim default does not carry (#107), while
    // `includeTerminal` is only ever sent when asked for. If the code
    // stopped distinguishing them, this URL would gain an
    // `includeTerminal=false` and go red.
    const { seen, fetch } = capture(json({ items: [], nextCursor: null }));
    await listTasks({ baseUrl, fetch }, { includeTerminal: false });
    expect(seen[0]?.url).toBe("https://example.test/api/items?full=true");
  });

  it("projects every returned item, translating each one's status independently", async () => {
    const { fetch } = capture(
      json({
        items: [
          { id: "1", area: "web", state: "executing" },
          { id: "2", area: "web", state: "blocked" },
        ],
        nextCursor: null,
      }),
    );
    const result = await listTasks({ baseUrl, fetch }, {});
    if (!result.ok) throw new Error("unreachable");
    expect(result.data.map((t) => t.status)).toEqual(["in-progress", "blocked"]);
  });
});

describe("transitionTask", () => {
  it("posts to /api/items/<id>/transition with only { to }", async () => {
    const { seen, fetch } = capture(
      json({
        item: { id: "item-1", area: "web", state: "merged" },
        outcome: {
          itemId: "item-1",
          from: "in_review",
          to: "merged",
          allowed: true,
          rehearsed: false,
        },
      }),
    );
    await transitionTask({ baseUrl, fetch }, "item-1", "merged");
    expect(seen[0]?.url).toBe("https://example.test/api/items/item-1/transition");
    expect(JSON.parse(seen[0]?.init.body as string)).toEqual({ to: "merged" });
  });

  it("unwraps the item, not the outcome", async () => {
    const { fetch } = capture(
      json({
        item: { id: "item-1", area: "web", state: "merged" },
        outcome: {
          itemId: "item-1",
          from: "in_review",
          to: "merged",
          allowed: true,
          rehearsed: false,
        },
      }),
    );
    const result = await transitionTask({ baseUrl, fetch }, "item-1", "merged");
    if (!result.ok) throw new Error("unreachable");
    expect(result.data.id).toBe("item-1");
    expect(result.data.status).toBe("done");
  });
});

describe("reading a refusal back", () => {
  it("takes the message from the server's error envelope", async () => {
    const { fetch } = capture(
      json(
        { error: { code: "guard_rejected", message: "paused requires pause_reason.", fields: [] } },
        422,
      ),
    );
    const result = await getTask({ baseUrl, fetch }, "x");
    expect(result).toEqual({ ok: false, message: "paused requires pause_reason." });
  });

  it("falls back to a status-shaped message when the body carries none", async () => {
    const { fetch } = capture(new Response("<html>gateway timeout</html>", { status: 504 }));
    const result = await getTask({ baseUrl, fetch }, "x");
    if (result.ok) throw new Error("unreachable");
    expect(result.message).toBe("The server refused (HTTP 504).");
  });

  it("reports an unreachable server without leaking the address", async () => {
    const secretUrl = "https://ops:hunter2@standup.private.example:8443";
    const result = await getTask(
      {
        baseUrl: secretUrl,
        fetch: async () => {
          throw new Error(`connect ECONNREFUSED ${secretUrl}`);
        },
      },
      "x",
    );
    if (result.ok) throw new Error("unreachable");
    expect(result.message).toBe("Could not reach the server.");
    expect(result.message).not.toContain("hunter2");
  });

  it("refuses a body with no recognisable item, rather than crashing", async () => {
    const { fetch } = capture(json({ nope: true }));
    const result = await getTask({ baseUrl, fetch }, "x");
    if (result.ok) throw new Error("unreachable");
    expect(result.message).toContain("does not recognise");
  });
});
