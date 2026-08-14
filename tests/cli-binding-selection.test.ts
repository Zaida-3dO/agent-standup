// AC6 — the binding is selected per SCHEMA.md §17.1, and both ways are tested.
//
// §17.1, exactly: "`STANDUP_URL` … Present → commands call the API; absent →
// they use `DATABASE_URL` and run the service layer in-process." Both
// directions are asserted below, because a selector tested in one direction
// only is a selector that could return `http` unconditionally and pass.
//
// The §20 additions this covers alongside it: `--direct` forces the
// in-process binding; precedence is "flag, then environment, then the
// configuration file"; and "either `DATABASE_URL` or `STANDUP_URL` must
// resolve … in which case it says so and stops", which is exit code 4.
import { describe, expect, it } from "vitest";
import { EXIT, describeResolution, firstDefined, resolveConfig, runCli } from "@/lib/cli";
import type { Binding } from "@/lib/cli";

function config(resolution: ReturnType<typeof resolveConfig>) {
  if (!resolution.ok)
    throw new Error(`expected a resolved config: ${resolution.envelope.error.message}`);
  return resolution.config;
}

describe("binding selection (SCHEMA.md §17.1)", () => {
  it("selects http when STANDUP_URL is present", () => {
    const resolved = config(
      resolveConfig({
        env: { STANDUP_URL: "https://example.test", DATABASE_URL: "postgresql://u@h/d" },
      }),
    );
    expect(resolved.binding).toBe("http");
    expect(resolved.standupUrl).toBe("https://example.test");
  });

  it("selects direct when STANDUP_URL is absent and DATABASE_URL is present", () => {
    const resolved = config(resolveConfig({ env: { DATABASE_URL: "postgresql://u@h/d" } }));
    expect(resolved.binding).toBe("direct");
    expect(resolved.databaseUrl).toBe("postgresql://u@h/d");
  });

  it("prefers http over direct when BOTH are present", () => {
    // The tie-break §17.1 states. Asserted on its own because the two cases
    // above would both pass if the selector simply returned whichever
    // variable it happened to read first.
    const resolved = config(
      resolveConfig({
        env: { STANDUP_URL: "https://example.test", DATABASE_URL: "postgresql://u@h/d" },
      }),
    );
    expect(resolved.binding).toBe("http");
  });

  it("treats an empty STANDUP_URL as absent, so unsetting it works", () => {
    // `STANDUP_URL=` in a shell profile is how a person turns it off. A
    // selector reading presence rather than a value would send every command
    // to a server at the empty string.
    const resolved = config(
      resolveConfig({ env: { STANDUP_URL: "", DATABASE_URL: "postgresql://u@h/d" } }),
    );
    expect(resolved.binding).toBe("direct");
  });

  it("--direct forces the in-process binding even with a server reachable", () => {
    const resolved = config(
      resolveConfig({
        flags: { direct: true },
        env: { STANDUP_URL: "https://example.test", DATABASE_URL: "postgresql://u@h/d" },
      }),
    );
    expect(resolved.binding).toBe("direct");
    expect(resolved.standupUrl).toBeUndefined();
  });

  it("--direct without a database is not configured, not a silent fallback to http", () => {
    const resolution = resolveConfig({
      flags: { direct: true },
      env: { STANDUP_URL: "https://example.test" },
    });
    expect(resolution.ok).toBe(false);
    if (resolution.ok) throw new Error("unreachable");
    expect(resolution.exitCode).toBe(EXIT.UNCONFIGURED);
    expect(resolution.envelope.error.fields).toEqual(["DATABASE_URL"]);
  });

  it("refuses, with exit code 4, when neither resolves", () => {
    const resolution = resolveConfig({ env: {} });
    expect(resolution.ok).toBe(false);
    if (resolution.ok) throw new Error("unreachable");
    expect(resolution.exitCode).toBe(EXIT.UNCONFIGURED);
    expect(resolution.envelope.error.message).toContain("standup init");
  });
});

describe("configuration precedence — flag, then environment, then file (§20)", () => {
  it("takes the flag over the environment and the file", () => {
    const resolved = config(
      resolveConfig({
        flags: { url: "https://from-flag.test", as: "user-a", session: "s-flag" },
        env: {
          STANDUP_URL: "https://from-env.test",
          STANDUP_SESSION_ID: "s-env",
          STANDUP_ACTOR: "user-b",
        },
        file: { standupUrl: "https://from-file.test", sessionId: "s-file", actor: "user-c" },
      }),
    );
    expect(resolved.standupUrl).toBe("https://from-flag.test");
    expect(resolved.sessionId).toBe("s-flag");
    expect(resolved.actor).toBe("user-a");
  });

  it("takes the environment over the file when no flag is given", () => {
    const resolved = config(
      resolveConfig({
        env: {
          STANDUP_URL: "https://from-env.test",
          STANDUP_SESSION_ID: "s-env",
          STANDUP_ACTOR: "user-b",
        },
        file: { standupUrl: "https://from-file.test", sessionId: "s-file", actor: "user-c" },
      }),
    );
    expect(resolved.standupUrl).toBe("https://from-env.test");
    expect(resolved.sessionId).toBe("s-env");
    expect(resolved.actor).toBe("user-b");
  });

  it("falls back to the file when neither a flag nor the environment supplied one", () => {
    const resolved = config(
      resolveConfig({
        file: { standupUrl: "https://from-file.test", sessionId: "s-file", actor: "user-c" },
      }),
    );
    expect(resolved.standupUrl).toBe("https://from-file.test");
    expect(resolved.sessionId).toBe("s-file");
    expect(resolved.actor).toBe("user-c");
  });

  it("firstDefined skips blank values rather than treating them as supplied", () => {
    expect(firstDefined(undefined, "  ", "real")).toBe("real");
    expect(firstDefined("", "  ")).toBeUndefined();
    expect(firstDefined("  padded  ")).toBe("padded");
  });
});

describe("configuration reporting never carries a value", () => {
  it("reports presence and source, and no note carries the connection string", () => {
    const secret = "postgresql://user:hunter2@db.internal:5432/app";
    const notes = describeResolution({
      env: { DATABASE_URL: secret, STANDUP_URL: "https://example.test" },
    });

    // The value must not appear anywhere in the report, however it is
    // serialised — §20's "the connection string … is never printed by any
    // command". Serialising the whole report and searching it is what makes
    // this catch a leak through a field nobody thought to check.
    expect(JSON.stringify(notes)).not.toContain("hunter2");
    expect(JSON.stringify(notes)).not.toContain(secret);

    const database = notes.find((note) => note.name === "DATABASE_URL");
    expect(database).toEqual({ name: "DATABASE_URL", present: true, source: "environment" });
  });

  it("reports which layer supplied each value", () => {
    const notes = describeResolution({
      flags: { session: "s-flag" },
      env: { DATABASE_URL: "postgresql://u@h/d" },
      file: { actor: "user-a" },
    });
    const byName = Object.fromEntries(notes.map((note) => [note.name, note.source]));
    expect(byName).toEqual({
      STANDUP_URL: "none",
      DATABASE_URL: "environment",
      STANDUP_SESSION_ID: "flag",
      STANDUP_ACTOR: "file",
    });
  });
});

describe("runCli builds the binding the selection chose", () => {
  /** Records which binding `runCli` built, without a database or a server. */
  function spy() {
    const built: string[] = [];
    return {
      built,
      loadService: async () => {
        built.push("direct");
        return {
          async call() {
            return { id: "item-1" };
          },
        };
      },
      fetch: async (url: string) => {
        built.push(`http ${new URL(url).host}`);
        return new Response(JSON.stringify({ item: { id: "item-1" } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      },
    };
  }

  it("runs the command over http when STANDUP_URL is set", async () => {
    const { built, loadService, fetch } = spy();
    const outcome = await runCli(["item", "get", "item-1"], {
      env: { STANDUP_URL: "https://example.test", DATABASE_URL: "postgresql://u@h/d" },
      loadService,
      fetch,
    });
    expect(outcome.binding).toBe("http");
    expect(built).toEqual(["http example.test"]);
  });

  it("runs the command in-process when STANDUP_URL is not set", async () => {
    const { built, loadService, fetch } = spy();
    const outcome = await runCli(["item", "get", "item-1"], {
      env: { DATABASE_URL: "postgresql://u@h/d" },
      loadService,
      fetch,
    });
    expect(outcome.binding).toBe("direct");
    expect(built).toEqual(["direct"]);
  });

  it("stops with exit code 4, before building any binding, when nothing resolves", async () => {
    const { built, loadService, fetch } = spy();
    const outcome = await runCli(["item", "get", "item-1"], { env: {}, loadService, fetch });
    expect(outcome.exitCode).toBe(EXIT.UNCONFIGURED);
    // Not merely refused — refused *without* reaching for a database or a
    // server, which is what "rather than starting up half-configured" means.
    expect(built).toEqual([]);
    expect(outcome.binding).toBeUndefined();
  });

  it("never loads the composition root when the binding is http", async () => {
    // A command against a server must not need a database client in the
    // process at all — the reason `loadService` is a function, not a value.
    const { built, loadService, fetch } = spy();
    await runCli(["item", "get", "item-1"], {
      env: { STANDUP_URL: "https://example.test", DATABASE_URL: "postgresql://u@h/d" },
      loadService,
      fetch,
    });
    expect(built).not.toContain("direct");
  });
});

describe("the binding interface has exactly one method commands use", () => {
  it("runCommand never inspects which binding it holds", async () => {
    // A binding whose `name` is a value neither implementation uses. If any
    // command or the dispatcher branched on the name, this would not reach
    // the operation at all.
    const seen: string[] = [];
    const odd: Binding = {
      name: "direct",
      async invoke(operation, input) {
        seen.push(operation);
        return { ok: true, data: { operation, input } };
      },
    };
    const { runCommand } = await import("@/lib/cli");
    const outcome = await runCommand(["item", "get", "abc"], odd);
    expect(seen).toEqual(["get_item"]);
    expect(outcome.envelope).toEqual({
      ok: true,
      // `full: false` is `item get`'s `--full` switch (MILESTONES.md #107),
      // absent here; it rides through untouched exactly like every other
      // built input, which is the property this asserts.
      data: { operation: "get_item", input: { id: "abc", full: false } },
    });
  });
});
