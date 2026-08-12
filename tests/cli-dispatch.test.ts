// AC1, AC2, AC7 — the entry point, `<noun> <verb>` dispatch with aliases,
// the `--json` envelope, the exit codes, and `standup doctor`
// (SCHEMA.md §20).
//
// The rejections are the point here, not the happy path: a dispatcher that
// accepted everything would pass a suite of "the command I typed worked"
// tests and route `standup nonsense list` into a service call. So every
// refusal below asserts the exit code *and* the envelope, because those are
// the two things a script reacts to and they can be wrong independently.
import { describe, expect, it } from "vitest";
import {
  ALIASES,
  COMMANDS,
  EXIT,
  doctorReport,
  helpText,
  humanText,
  lookupCommand,
  main,
  parseArgs,
  render,
  runCommand,
  verbsFor,
} from "@/lib/cli";
import type { Binding, RunOutcome, Streams } from "@/lib/cli";

/** A binding that records every call and always accepts. */
function recorder(): Binding & { calls: { operation: string; input: unknown }[] } {
  const calls: { operation: string; input: unknown }[] = [];
  return {
    name: "direct",
    calls,
    async invoke(operation, input) {
      calls.push({ operation, input });
      return { ok: true, data: { operation } };
    },
  };
}

describe("argument parsing", () => {
  it("splits words from flags, both spellings", () => {
    const parsed = parseArgs(["item", "list", "--state", "open", "--priority=high", "--json"]);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error("unreachable");
    expect(parsed.parsed.words).toEqual(["item", "list"]);
    expect(parsed.parsed.flags).toEqual({ state: "open", priority: "high", json: true });
  });

  it("does not let a bare flag swallow the flag after it", () => {
    // `--json --direct` is two booleans. A parser that always consumed the
    // next token would produce `json: "--direct"` and silently lose one.
    const parsed = parseArgs(["--json", "--direct"]);
    if (!parsed.ok) throw new Error("unreachable");
    expect(parsed.parsed.flags).toEqual({ json: true, direct: true });
  });

  it("stops parsing flags after --", () => {
    const parsed = parseArgs(["item", "get", "--", "--not-a-flag"]);
    if (!parsed.ok) throw new Error("unreachable");
    expect(parsed.parsed.words).toEqual(["item", "get", "--not-a-flag"]);
    expect(parsed.parsed.flags).toEqual({});
  });

  it("refuses a short flag rather than reading it as a word", () => {
    const parsed = parseArgs(["item", "-x"]);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) throw new Error("unreachable");
    expect(parsed.envelope.error.code).toBe("malformed_command");
  });
});

describe("<noun> <verb> dispatch", () => {
  it("resolves a registered command to its service operation", () => {
    const found = lookupCommand(["item", "get", "abc"]);
    expect(found.ok).toBe(true);
    if (!found.ok) throw new Error("unreachable");
    expect(found.match.command.operation).toBe("get_item");
    expect(found.match.rest).toEqual(["abc"]);
    expect(found.match.viaAlias).toBeUndefined();
  });

  it("refuses an unknown noun, naming the nouns that exist", () => {
    const found = lookupCommand(["nonsense", "list"]);
    expect(found.ok).toBe(false);
    if (found.ok) throw new Error("unreachable");
    expect(found.envelope.error.fields).toEqual(["noun"]);
    expect(found.envelope.error.message).toContain("item");
  });

  it("refuses an unknown verb under a known noun, naming the verbs that exist", () => {
    const found = lookupCommand(["item", "frobnicate"]);
    expect(found.ok).toBe(false);
    if (found.ok) throw new Error("unreachable");
    expect(found.envelope.error.fields).toEqual(["verb"]);
    expect(found.envelope.error.message).toContain("get");
  });

  it("refuses a noun with no verb", () => {
    const found = lookupCommand(["item"]);
    expect(found.ok).toBe(false);
    if (found.ok) throw new Error("unreachable");
    expect(found.envelope.error.fields).toEqual(["verb"]);
  });

  it("refuses no words at all", () => {
    const found = lookupCommand([]);
    expect(found.ok).toBe(false);
    if (found.ok) throw new Error("unreachable");
    expect(found.envelope.error.message).toContain("standup <noun> <verb>");
  });
});

describe("aliases resolve to the same operation, so nothing downstream sees them", () => {
  it("every alias names a command that exists", () => {
    // Guards the table against an alias pointing at a `<noun> <verb>` pair
    // that was renamed — which would fail only when someone typed it.
    for (const [alias, [noun, verb]] of Object.entries(ALIASES)) {
      const match = COMMANDS.find((command) => command.noun === noun && command.verb === verb);
      expect(match, `alias ${alias} points at ${noun} ${verb}`).toBeDefined();
    }
  });

  it("an alias and its long form produce the identical command and rest", () => {
    const viaAlias = lookupCommand(["show", "abc"]);
    const viaLongForm = lookupCommand(["item", "get", "abc"]);
    if (!viaAlias.ok || !viaLongForm.ok) throw new Error("unreachable");
    expect(viaAlias.match.command).toBe(viaLongForm.match.command);
    expect(viaAlias.match.rest).toEqual(viaLongForm.match.rest);
  });

  it("records which alias was typed without letting it change the operation", async () => {
    const binding = recorder();
    await runCommand(["ls", "--state", "open"], binding);
    await runCommand(["item", "list", "--state", "open"], binding);
    expect(binding.calls).toEqual([
      { operation: "list_items", input: { state: "open" } },
      { operation: "list_items", input: { state: "open" } },
    ]);
  });
});

describe("input building", () => {
  it("refuses `item get` with no id, before reaching the binding", async () => {
    const binding = recorder();
    const outcome = await runCommand(["item", "get"], binding);
    expect(outcome.exitCode).toBe(EXIT.MALFORMED);
    expect(binding.calls).toEqual([]);
    if (outcome.envelope.ok) throw new Error("unreachable");
    expect(outcome.envelope.error.fields).toEqual(["id"]);
  });

  it("keeps the global flags out of the operation's input", async () => {
    const binding = recorder();
    await runCommand(["item", "list", "--state", "open", "--json", "--as", "user-a"], binding);
    // `--json`, `--as` and friends are the adapter's, not the operation's.
    // A schema declared `.strict()` would refuse the whole call if they
    // leaked through.
    expect(binding.calls[0]?.input).toEqual({ state: "open" });
  });

  it("refuses a bare value-taking flag rather than sending `true` as a value", async () => {
    const binding = recorder();
    const outcome = await runCommand(["item", "create", "--title"], binding);
    expect(outcome.exitCode).toBe(EXIT.MALFORMED);
    expect(binding.calls).toEqual([]);
  });
});

describe("exit codes separate the situations that want opposite responses (§20)", () => {
  /** A binding that rejects with a given service code. */
  function rejecting(code: string, guard?: string): Binding {
    return {
      name: "direct",
      async invoke() {
        return {
          ok: false,
          rejection: {
            code: code as never,
            fields: ["title"],
            ...(guard === undefined ? {} : { guard }),
          },
          message: "refused",
        };
      },
    };
  }

  it.each([
    ["guard_rejected", EXIT.REJECTED],
    ["not_found", EXIT.REJECTED],
    ["conflict", EXIT.REJECTED],
    ["forbidden", EXIT.REJECTED],
    ["invalid_input", EXIT.MALFORMED],
    ["internal", EXIT.FAILURE],
    ["not_implemented", EXIT.FAILURE],
  ])("maps %s onto exit code %i", async (code, expected) => {
    const outcome = await runCommand(["item", "get", "abc"], rejecting(code));
    expect(outcome.exitCode).toBe(expected);
  });

  it("carries the rule identifier through for a guard rejection", async () => {
    const outcome = await runCommand(
      ["item", "get", "abc"],
      rejecting("guard_rejected", "blocked_required_fields"),
    );
    if (outcome.envelope.ok) throw new Error("unreachable");
    expect(outcome.envelope.error.guard).toBe("blocked_required_fields");
  });

  it("exits 0 on acceptance", async () => {
    const outcome = await runCommand(["item", "get", "abc"], recorder());
    expect(outcome.exitCode).toBe(EXIT.OK);
  });
});

describe("--json goes to standard output, human text to standard error (§20)", () => {
  function streams() {
    const out: string[] = [];
    const err: string[] = [];
    return {
      out,
      err,
      sinks: { out: (t: string) => out.push(t), err: (t: string) => err.push(t) },
    };
  }

  const accepted: RunOutcome = {
    envelope: { ok: true, data: { id: "item-1" } },
    exitCode: EXIT.OK,
    binding: "direct",
  };

  it("writes exactly one JSON document to standard output and nothing to standard error", () => {
    const { out, err, sinks } = streams();
    render(accepted, sinks as Streams, true);
    expect(err).toEqual([]);
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0] as string)).toEqual({ ok: true, data: { id: "item-1" } });
  });

  it("writes nothing to standard output without --json, so a pipe stays clean", () => {
    const { out, err, sinks } = streams();
    render(accepted, sinks as Streams, false);
    expect(out).toEqual([]);
    expect(err.join("")).toContain("item-1");
  });

  it("puts a rejection on standard output as JSON too, not on standard error", () => {
    const { out, err, sinks } = streams();
    render(
      {
        envelope: {
          ok: false,
          error: { code: "guard_rejected", message: "no", fields: ["state"], guard: "a_rule" },
        },
        exitCode: EXIT.REJECTED,
      },
      sinks as Streams,
      true,
    );
    expect(err).toEqual([]);
    expect(JSON.parse(out[0] as string)).toEqual({
      ok: false,
      error: { code: "guard_rejected", message: "no", fields: ["state"], guard: "a_rule" },
    });
  });

  it("names the rule and the fields in the human rendering", () => {
    const text = humanText({
      ok: false,
      error: { code: "guard_rejected", message: "no", fields: ["state"], guard: "a_rule" },
    });
    expect(text).toContain("guard_rejected");
    expect(text).toContain("a_rule");
    expect(text).toContain("state");
  });
});

describe("standup doctor", () => {
  it("reports configured, and which binding a command would use", () => {
    const report = doctorReport({ env: { STANDUP_URL: "https://example.test" } });
    expect(report.configured).toBe(true);
    expect(report.binding).toBe("http");
    expect(report.problems).toEqual([]);
  });

  it("re-checks the capability paths locally, reporting each", () => {
    const report = doctorReport({ env: { DATABASE_URL: "postgresql://u@h/d" } });
    const byName = Object.fromEntries(report.capabilities.map((c) => [c.name, c.status]));
    expect(byName).toEqual({ server: "unavailable", database: "available" });
  });

  it("reports what is wrong, rather than stopping, when nothing is configured", () => {
    const report = doctorReport({ env: {} });
    expect(report.configured).toBe(false);
    expect(report.binding).toBeUndefined();
    expect(report.problems).toHaveLength(1);
    expect(report.problems[0]).toContain("standup init");
  });

  it("never carries a connection string, however the report is serialised", () => {
    const secret = "postgresql://user:hunter2@db.internal:5432/app";
    const report = doctorReport({ env: { DATABASE_URL: secret } });
    expect(JSON.stringify(report)).not.toContain("hunter2");
    expect(JSON.stringify(report)).not.toContain("db.internal");
  });
});

describe("the entry point", () => {
  it("returns the exit code rather than exiting, and renders JSON on request", async () => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await main(["doctor", "--json"], {
      env: { STANDUP_URL: "https://example.test" },
      streams: { out: (t) => out.push(t), err: (t) => err.push(t) },
    });
    expect(code).toBe(EXIT.OK);
    expect(err).toEqual([]);
    const parsed = JSON.parse(out[0] as string) as { ok: boolean; data: { binding: string } };
    expect(parsed.ok).toBe(true);
    expect(parsed.data.binding).toBe("http");
  });

  it("exits 4 when doctor finds nothing configured", async () => {
    const out: string[] = [];
    const code = await main(["doctor", "--json"], {
      env: {},
      streams: { out: (t) => out.push(t), err: () => {} },
    });
    expect(code).toBe(EXIT.UNCONFIGURED);
  });

  it("exits 2 on a command this build cannot parse", async () => {
    const err: string[] = [];
    const code = await main(["nonsense", "list"], {
      env: { STANDUP_URL: "https://example.test" },
      streams: { out: () => {}, err: (t) => err.push(t) },
    });
    expect(code).toBe(EXIT.MALFORMED);
    expect(err.join("")).toContain("No such noun");
  });

  it("answers --help without needing any configuration at all", async () => {
    const out: string[] = [];
    const code = await main(["--help", "--json"], {
      env: {},
      streams: { out: (t) => out.push(t), err: () => {} },
    });
    expect(code).toBe(EXIT.OK);
    expect(JSON.parse(out[0] as string)).toEqual({ ok: true, data: helpText() });
  });

  it("renders an escaped failure as internal, without leaking its message", async () => {
    // Nothing normally reaches `main`'s catch — both bindings normalise. If
    // something does, the message must not be rendered: an unexpected
    // failure's text routinely carries a query or a connection string.
    const out: string[] = [];
    const code = await main(["item", "get", "x", "--json"], {
      env: { DATABASE_URL: "postgresql://u@h/d" },
      loadService: async () => {
        throw new Error("could not connect to postgresql://ops:hunter2@db.internal/app");
      },
      streams: { out: (t) => out.push(t), err: () => {} },
    });

    expect(code).toBe(EXIT.FAILURE);
    const rendered = out.join("");
    expect(rendered).not.toContain("hunter2");
    expect(rendered).not.toContain("db.internal");
    expect(JSON.parse(rendered)).toMatchObject({ ok: false, error: { code: "internal" } });
  });

  it("builds help from the command table rather than a written-out list", () => {
    const help = helpText();
    expect(help.nouns).toEqual([...new Set(COMMANDS.map((c) => c.noun))].sort());
    expect(help.commands).toHaveLength(COMMANDS.length);
    expect(verbsFor("item")).toContain("create");
  });
});
