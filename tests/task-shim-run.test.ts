// MILESTONES.md #39, end to end: `run()` dispatches the five commands,
// prints the deprecation warning on every call, validates locally before
// ever reaching the network, and — the row's central honesty test — routes
// a status change straight at the transition guard and reports exactly what
// the server said, rather than fabricating fields the reduced surface never
// carried to make the guard pass.
import { describe, expect, it } from "vitest";
import { DEPRECATION_WARNING, run } from "@/lib/task-shim/run";

function streams() {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, sinks: { out: (t: string) => out.push(t), err: (t: string) => err.push(t) } };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function neverCalled() {
  return async (): Promise<Response> => {
    throw new Error("fetch must not be called for this input");
  };
}

const env = { STANDUP_URL: "https://example.test" };

describe("the deprecation warning", () => {
  it("is printed to standard error before anything else, on success", async () => {
    const { err, sinks } = streams();
    const fetchImpl = async () => json({ item: { id: "1", area: "web", state: "on_deck" } });
    await run(["show", "1"], { env, fetch: fetchImpl, streams: sinks });
    expect(err[0]).toBe(`${DEPRECATION_WARNING}\n`);
  });

  it("is printed exactly once even when the command is malformed", async () => {
    const { err, sinks } = streams();
    await run([], { env, streams: sinks });
    expect(err.filter((line) => line.includes("[deprecated]"))).toHaveLength(1);
  });

  it("is printed even when STANDUP_URL is not set", async () => {
    const { err, sinks } = streams();
    await run(["show", "1"], { env: {}, streams: sinks });
    expect(err[0]).toBe(`${DEPRECATION_WARNING}\n`);
  });
});

describe("configuration", () => {
  it("refuses without calling the network when STANDUP_URL is unset", async () => {
    const { err, sinks } = streams();
    const code = await run(["show", "1"], { env: {}, fetch: neverCalled(), streams: sinks });
    expect(code).toBe(1);
    expect(err.join("")).toContain("STANDUP_URL is not set");
  });

  it("refuses when STANDUP_URL is only whitespace", async () => {
    const { sinks } = streams();
    const code = await run(["show", "1"], {
      env: { STANDUP_URL: "   " },
      fetch: neverCalled(),
      streams: sinks,
    });
    expect(code).toBe(1);
  });
});

describe("no command / unknown command", () => {
  it("refuses an empty command line", async () => {
    const { err, sinks } = streams();
    const code = await run([], { env, streams: sinks });
    expect(code).toBe(1);
    expect(err.join("")).toContain("no command given");
  });

  it("names the unknown command it refuses", async () => {
    const { err, sinks } = streams();
    const code = await run(["frobnicate"], { env, fetch: neverCalled(), streams: sinks });
    expect(code).toBe(1);
    expect(err.join("")).toContain('unknown command "frobnicate"');
  });
});

describe("show", () => {
  it("needs an id, and never reaches the network without one", async () => {
    const { err, sinks } = streams();
    const code = await run(["show"], { env, fetch: neverCalled(), streams: sinks });
    expect(code).toBe(1);
    expect(err.join("")).toContain("needs an id");
  });

  it("prints exactly the six-field shape on success and exits 0", async () => {
    const { out, sinks } = streams();
    const fetchImpl = async () =>
      json({
        item: { id: "item-1", title: "T", body: "B", state: "in_review", area: "web", repo: "web" },
      });
    const code = await run(["show", "item-1"], { env, fetch: fetchImpl, streams: sinks });
    expect(code).toBe(0);
    const printed = JSON.parse(out.join(""));
    expect(Object.keys(printed).sort()).toEqual(["area", "body", "id", "repo", "status", "title"]);
    expect(printed.status).toBe("review");
  });

  it("surfaces a not_found refusal by its message and exits 1", async () => {
    const { err, sinks } = streams();
    const fetchImpl = async () =>
      json({ error: { code: "not_found", message: "No such item: x.", fields: ["id"] } }, 404);
    const code = await run(["show", "x"], { env, fetch: fetchImpl, streams: sinks });
    expect(code).toBe(1);
    expect(err.join("")).toContain("Error: No such item: x.");
  });
});

describe("create", () => {
  it("requires --title, --body and --area before ever calling the network", async () => {
    const { sinks } = streams();
    expect(
      await run(["create", "--body", "b", "--area", "a"], {
        env,
        fetch: neverCalled(),
        streams: sinks,
      }),
    ).toBe(1);
    expect(
      await run(["create", "--title", "t", "--area", "a"], {
        env,
        fetch: neverCalled(),
        streams: sinks,
      }),
    ).toBe(1);
    expect(
      await run(["create", "--title", "t", "--body", "b"], {
        env,
        fetch: neverCalled(),
        streams: sinks,
      }),
    ).toBe(1);
  });

  it("creates and prints the projected task", async () => {
    const { out, sinks } = streams();
    const fetchImpl = async () =>
      json({
        item: { id: "item-2", title: "New", body: "b", state: "on_deck", area: "web", repo: null },
      });
    const code = await run(["create", "--title", "New", "--body", "b", "--area", "web"], {
      env,
      fetch: fetchImpl,
      streams: sinks,
    });
    expect(code).toBe(0);
    expect(JSON.parse(out.join(""))).toEqual({
      id: "item-2",
      title: "New",
      body: "b",
      status: "todo",
      repo: null,
      area: "web",
    });
  });
});

describe("update", () => {
  it("needs an id", async () => {
    const { sinks } = streams();
    const code = await run(["update"], { env, fetch: neverCalled(), streams: sinks });
    expect(code).toBe(1);
  });

  it("refuses an edit with nothing to change, without calling the network", async () => {
    const { err, sinks } = streams();
    const code = await run(["update", "item-1"], { env, fetch: neverCalled(), streams: sinks });
    expect(code).toBe(1);
    expect(err.join("")).toContain("nothing to update");
  });

  it("sends only the supplied fields", async () => {
    const seen: unknown[] = [];
    const fetchImpl = async (_url: string, init: RequestInit) => {
      seen.push(JSON.parse(init.body as string));
      return json({ item: { id: "item-1", title: "Renamed", state: "on_deck", area: "web" } });
    };
    const { sinks } = streams();
    const code = await run(["update", "item-1", "--title", "Renamed"], {
      env,
      fetch: fetchImpl,
      streams: sinks,
    });
    expect(code).toBe(0);
    expect(seen[0]).toEqual({ title: "Renamed" });
  });
});

describe("list", () => {
  it("refuses an unknown --status without calling the network", async () => {
    const { err, sinks } = streams();
    const code = await run(["list", "--status", "bogus"], {
      env,
      fetch: neverCalled(),
      streams: sinks,
    });
    expect(code).toBe(1);
    expect(err.join("")).toContain('unknown status "bogus"');
  });

  it("translates --status into the API's state filter", async () => {
    const seen: string[] = [];
    const fetchImpl = async (url: string) => {
      seen.push(url);
      return json({ items: [], nextCursor: null });
    };
    const { sinks } = streams();
    await run(["list", "--status", "in-progress"], { env, fetch: fetchImpl, streams: sinks });
    expect(new URL(seen[0]!).searchParams.get("state")).toBe("executing");
  });

  it("prints { tasks: [...] } with each item's status translated", async () => {
    const fetchImpl = async () =>
      json({
        items: [
          { id: "1", area: "web", state: "on_deck" },
          { id: "2", area: "web", state: "planning" },
        ],
        nextCursor: null,
      });
    const { out, sinks } = streams();
    const code = await run(["list"], { env, fetch: fetchImpl, streams: sinks });
    expect(code).toBe(0);
    const printed = JSON.parse(out.join(""));
    expect(printed.tasks.map((t: { status: string }) => t.status)).toEqual(["todo", "planning"]);
  });
});

describe("status — the honesty test", () => {
  it("refuses an unknown status without calling the network", async () => {
    const { err, sinks } = streams();
    const code = await run(["status", "item-1", "bogus"], {
      env,
      fetch: neverCalled(),
      streams: sinks,
    });
    expect(code).toBe(1);
    expect(err.join("")).toContain('unknown status "bogus"');
  });

  it("needs both an id and a status", async () => {
    const { sinks } = streams();
    expect(await run(["status", "item-1"], { env, fetch: neverCalled(), streams: sinks })).toBe(1);
  });

  it("sends exactly { to: <mapped state> }, nothing invented to satisfy a guard", async () => {
    const seen: unknown[] = [];
    const fetchImpl = async (_url: string, init: RequestInit) => {
      seen.push(JSON.parse(init.body as string));
      return json({
        item: { id: "item-1", area: "web", state: "paused" },
        outcome: {
          itemId: "item-1",
          from: "executing",
          to: "paused",
          allowed: true,
          rehearsed: false,
        },
      });
    };
    const { sinks } = streams();
    await run(["status", "item-1", "waiting"], { env, fetch: fetchImpl, streams: sinks });
    expect(seen[0]).toEqual({ to: "paused" });
  });

  it("surfaces a guard rejection verbatim rather than papering over it", async () => {
    // A bare status change into `paused` has no `pause_reason`/
    // `resume_condition` to give the new guard — this surface never carried
    // them. The honest behaviour is reporting exactly that refusal, not
    // silently succeeding and not inventing the missing fields.
    const fetchImpl = async () =>
      json(
        {
          error: {
            code: "guard_rejected",
            message: "paused requires pause_reason.",
            fields: ["pause_reason"],
            guard: "state-machine.paused_required_fields",
          },
        },
        422,
      );
    const { err, sinks } = streams();
    const code = await run(["status", "item-1", "waiting"], {
      env,
      fetch: fetchImpl,
      streams: sinks,
    });
    expect(code).toBe(1);
    expect(err.join("")).toBe(`${DEPRECATION_WARNING}\nError: paused requires pause_reason.\n`);
  });

  it("maps done to merged", async () => {
    const seen: unknown[] = [];
    const fetchImpl = async (_url: string, init: RequestInit) => {
      seen.push(JSON.parse(init.body as string));
      return json({
        item: { id: "item-1", area: "web", state: "merged" },
        outcome: {
          itemId: "item-1",
          from: "in_review",
          to: "merged",
          allowed: true,
          rehearsed: false,
        },
      });
    };
    const { sinks } = streams();
    await run(["status", "item-1", "done"], { env, fetch: fetchImpl, streams: sinks });
    expect(seen[0]).toEqual({ to: "merged" });
  });
});
