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
  it("requires --title, --body and --area before ever calling the network — exact messages", async () => {
    // Fresh streams per case, and the exact message asserted rather than
    // just the exit code: a mutant that skips the local guard entirely
    // still exits 1 further downstream (the `neverCalled()` fetch throws,
    // which `client.ts` converts into its own `ok: false` refusal) — only
    // the *message* tells "validation refused this before any network call"
    // apart from "validation was bypassed and the network layer refused
    // instead", and the second is exactly the regression this row exists to
    // catch.
    const missingTitle = streams();
    expect(
      await run(["create", "--body", "b", "--area", "a"], {
        env,
        fetch: neverCalled(),
        streams: missingTitle.sinks,
      }),
    ).toBe(1);
    expect(missingTitle.err.join("")).toContain("Error: --title is required.");

    const missingBody = streams();
    expect(
      await run(["create", "--title", "t", "--area", "a"], {
        env,
        fetch: neverCalled(),
        streams: missingBody.sinks,
      }),
    ).toBe(1);
    expect(missingBody.err.join("")).toContain("Error: --body is required.");

    const missingArea = streams();
    expect(
      await run(["create", "--title", "t", "--body", "b"], {
        env,
        fetch: neverCalled(),
        streams: missingArea.sinks,
      }),
    ).toBe(1);
    expect(missingArea.err.join("")).toContain("Error: --area is required.");
  });

  it("treats a bare --title (empty string) the same as an omitted one", async () => {
    // `--title` with no value parses to `""` (args.ts), not `undefined` —
    // the guard checks both, and only an empty-value case can tell the two
    // checks apart.
    const { err, sinks } = streams();
    const code = await run(["create", "--title", "--body", "b", "--area", "a"], {
      env,
      fetch: neverCalled(),
      streams: sinks,
    });
    expect(code).toBe(1);
    expect(err.join("")).toContain("Error: --title is required.");
  });

  it("treats a bare --area (empty string) the same as an omitted one", async () => {
    const { err, sinks } = streams();
    const code = await run(["create", "--title", "t", "--body", "b", "--area"], {
      env,
      fetch: neverCalled(),
      streams: sinks,
    });
    expect(code).toBe(1);
    expect(err.join("")).toContain("Error: --area is required.");
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

  it("sends the full payload on the wire — title, body, area and repo", async () => {
    const seen: unknown[] = [];
    const fetchImpl = async (_url: string, init: RequestInit) => {
      seen.push(JSON.parse(init.body as string));
      return json({
        item: { id: "item-3", title: "T", body: "B", state: "on_deck", area: "web", repo: "web" },
      });
    };
    const { sinks } = streams();
    const code = await run(
      ["create", "--title", "T", "--body", "B", "--area", "web", "--repo", "web"],
      { env, fetch: fetchImpl, streams: sinks },
    );
    expect(code).toBe(0);
    // originType is added by client.ts's createTask, not commands.ts — real
    // enough to belong in this assertion, since this test is verifying the
    // actual bytes that leave the process, not one layer's local contract.
    expect(seen[0]).toEqual({
      title: "T",
      body: "B",
      area: "web",
      repo: "web",
      originType: "source",
    });
  });

  it("omits repo from the wire payload when --repo is not given", async () => {
    const seen: unknown[] = [];
    const fetchImpl = async (_url: string, init: RequestInit) => {
      seen.push(JSON.parse(init.body as string));
      return json({
        item: { id: "item-4", title: "T", body: "B", state: "on_deck", area: "web", repo: null },
      });
    };
    const { sinks } = streams();
    await run(["create", "--title", "T", "--body", "B", "--area", "web"], {
      env,
      fetch: fetchImpl,
      streams: sinks,
    });
    expect(seen[0]).toEqual({ title: "T", body: "B", area: "web", originType: "source" });
  });

  it("omits repo from the wire payload when --repo is bare (empty), not just when it's absent", async () => {
    const seen: unknown[] = [];
    const fetchImpl = async (_url: string, init: RequestInit) => {
      seen.push(JSON.parse(init.body as string));
      return json({
        item: { id: "item-5", title: "T", body: "B", state: "on_deck", area: "web", repo: null },
      });
    };
    const { sinks } = streams();
    await run(["create", "--title", "T", "--body", "B", "--area", "web", "--repo"], {
      env,
      fetch: fetchImpl,
      streams: sinks,
    });
    expect(seen[0]).toEqual({ title: "T", body: "B", area: "web", originType: "source" });
  });
});

describe("update", () => {
  it("needs an id, with the exact message — not just whatever exit code a bypassed guard happens to produce", async () => {
    const { err, sinks } = streams();
    const code = await run(["update"], { env, fetch: neverCalled(), streams: sinks });
    expect(code).toBe(1);
    expect(err.join("")).toContain("Error: `task update` needs an id.");
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

  it("treats a bare --title (empty string) as no edit at all", async () => {
    const { err, sinks } = streams();
    const code = await run(["update", "item-1", "--title"], {
      env,
      fetch: neverCalled(),
      streams: sinks,
    });
    expect(code).toBe(1);
    expect(err.join("")).toContain("nothing to update");
  });

  it("forwards --body on its own, unlike title/repo/area it has no empty-string check", async () => {
    const seen: unknown[] = [];
    const fetchImpl = async (_url: string, init: RequestInit) => {
      seen.push(JSON.parse(init.body as string));
      return json({ item: { id: "item-1", state: "on_deck", area: "web" } });
    };
    const { sinks } = streams();
    const code = await run(["update", "item-1", "--body", "new body"], {
      env,
      fetch: fetchImpl,
      streams: sinks,
    });
    expect(code).toBe(0);
    expect(seen[0]).toEqual({ body: "new body" });
  });

  it("forwards --repo and --area edits on the wire", async () => {
    const seen: unknown[] = [];
    const fetchImpl = async (_url: string, init: RequestInit) => {
      seen.push(JSON.parse(init.body as string));
      return json({ item: { id: "item-1", state: "on_deck", area: "infra", repo: "web" } });
    };
    const { sinks } = streams();
    const code = await run(["update", "item-1", "--repo", "web", "--area", "infra"], {
      env,
      fetch: fetchImpl,
      streams: sinks,
    });
    expect(code).toBe(0);
    expect(seen[0]).toEqual({ repo: "web", area: "infra" });
  });

  it("excludes a bare (empty) --repo and --area from the wire, keeping only the real edit", async () => {
    const seen: unknown[] = [];
    const fetchImpl = async (_url: string, init: RequestInit) => {
      seen.push(JSON.parse(init.body as string));
      return json({ item: { id: "item-1", title: "Renamed", state: "on_deck", area: "web" } });
    };
    const { sinks } = streams();
    const code = await run(["update", "item-1", "--title", "Renamed", "--repo", "--area"], {
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

  it("forwards --repo and --area to the query string, and sends no state without --status", async () => {
    const seen: string[] = [];
    const fetchImpl = async (url: string) => {
      seen.push(url);
      return json({ items: [], nextCursor: null });
    };
    const { sinks } = streams();
    await run(["list", "--repo", "web", "--area", "infra"], {
      env,
      fetch: fetchImpl,
      streams: sinks,
    });
    const params = new URL(seen[0]!).searchParams;
    expect(params.get("repo")).toBe("web");
    expect(params.get("area")).toBe("infra");
    expect(params.has("state")).toBe(false);
  });

  it("sends no filters at all for bare (empty) --status, --repo and --area", async () => {
    const seen: string[] = [];
    const fetchImpl = async (url: string) => {
      seen.push(url);
      return json({ items: [], nextCursor: null });
    };
    const { sinks } = streams();
    const code = await run(["list", "--status", "--repo", "--area"], {
      env,
      fetch: fetchImpl,
      streams: sinks,
    });
    expect(code).toBe(0);
    const params = new URL(seen[0]!).searchParams;
    expect(params.has("state")).toBe(false);
    expect(params.has("repo")).toBe(false);
    expect(params.has("area")).toBe(false);
  });

  // The wire between the flag and the request, not the two ends separately.
  // `--all` is parsed in one place and turned into a query parameter in
  // another, and a test of either alone would pass while the flag did
  // nothing at all — which is exactly the round-trip gap recorded against
  // this surface.
  it("turns a bare --all into includeTerminal on the request", async () => {
    const seen: string[] = [];
    const fetchImpl = async (url: string) => {
      seen.push(url);
      return json({ items: [], nextCursor: null });
    };
    const { sinks } = streams();
    const code = await run(["list", "--all"], { env, fetch: fetchImpl, streams: sinks });
    expect(code).toBe(0);
    // A valueless flag records the empty string, so a truthiness test on the
    // flag's *value* would drop it here — presence is the whole meaning.
    expect(new URL(seen[0]!).searchParams.get("includeTerminal")).toBe("true");
  });

  it("sends no includeTerminal when --all is absent", async () => {
    const seen: string[] = [];
    const fetchImpl = async (url: string) => {
      seen.push(url);
      return json({ items: [], nextCursor: null });
    };
    const { sinks } = streams();
    await run(["list"], { env, fetch: fetchImpl, streams: sinks });
    // The complement. A flag that were always sent would pass the test above
    // while meaning nothing.
    expect(new URL(seen[0]!).searchParams.has("includeTerminal")).toBe(false);
  });

  it("still carries --all alongside other filters", async () => {
    const seen: string[] = [];
    const fetchImpl = async (url: string) => {
      seen.push(url);
      return json({ items: [], nextCursor: null });
    };
    const { sinks } = streams();
    await run(["list", "--all", "--repo", "web"], { env, fetch: fetchImpl, streams: sinks });
    const params = new URL(seen[0]!).searchParams;
    // `--all` sits directly before a valued flag here, which is the parse
    // that would break if a bare flag swallowed the next token.
    expect(params.get("includeTerminal")).toBe("true");
    expect(params.get("repo")).toBe("web");
  });

  it("surfaces a server refusal by its message and exits 1, rather than printing an empty task list", async () => {
    const fetchImpl = async () =>
      json(
        { error: { code: "internal", message: "The database is unreachable.", fields: [] } },
        500,
      );
    const { out, err, sinks } = streams();
    const code = await run(["list"], { env, fetch: fetchImpl, streams: sinks });
    expect(code).toBe(1);
    expect(err.join("")).toContain("Error: The database is unreachable.");
    expect(out).toEqual([]);
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

  it("needs both an id and a status, with the exact message", async () => {
    // Exact message, not just the exit code: a mutant that lets this guard
    // fall through still reaches `isShimStatus(undefined)`, which is also
    // falsy and also exits 1 — with a *different* message ("unknown status
    // ...") that only a message assertion, not an exit code, distinguishes.
    const { err, sinks } = streams();
    const code = await run(["status", "item-1"], { env, fetch: neverCalled(), streams: sinks });
    expect(code).toBe(1);
    expect(err.join("")).toContain("Error: `task status` needs an id and a status.");
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
