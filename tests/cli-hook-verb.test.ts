// MILESTONES.md #88 — `standup hook` as reached through the command line
// (`src/lib/cli/run.ts`, `src/lib/cli/render.ts`).
//
// **The assertion that matters most here is the `--json` one.** Everywhere
// else in this adapter that flag chooses a shape and can never change what
// happened (SCHEMA.md §20, and `main.ts`'s own comment on why it is read
// outside `runCli`). For a guard's refusal it *would* change what happened:
// a hook reader handed an `{ok, data}` envelope instead of the shape it
// parses sees no denial at all and lets the command run. So a rendering
// flag would be able to turn a deny into an allow — which is why the hook
// response is written before the flag is consulted, and why that ordering
// is pinned by a test rather than left to a comment.
import { describe, expect, it } from "vitest";
import { runCli } from "@/lib/cli/run";
import { render } from "@/lib/cli/render";
import { HOOK_EXIT } from "@/lib/hook/response";
import { readSpool } from "@/lib/hook/spool";
import type { SpoolStore } from "@/lib/cli/hook-command";

const NOW = 1_700_000_000_000;

const ALLOW_ALL = JSON.stringify({ allowPatterns: ["."], askPatterns: [], fetchedAt: NOW });
const MATCH_NOTHING = JSON.stringify({
  allowPatterns: ["^never$"],
  askPatterns: [],
  fetchedAt: NOW,
});

function memorySpool(initial = ""): SpoolStore & { text: () => string } {
  let text = initial;
  return {
    append: (line) => {
      text += line;
    },
    read: () => text,
    replace: (next) => {
      text = next;
    },
    text: () => text,
  };
}

function payload(): string {
  return JSON.stringify({
    hook_event_name: "PostToolUse",
    session_id: "session-a",
    tool_name: "Bash",
    tool_input: { command: "git status" },
  });
}

function captured(): {
  streams: { out: (t: string) => void; err: (t: string) => void };
  out: string[];
  err: string[];
} {
  const out: string[] = [];
  const err: string[] = [];
  return { streams: { out: (t) => out.push(t), err: (t) => err.push(t) }, out, err };
}

describe("standup hook reaches the hook without resolving a binding", () => {
  it("runs the hook and spools, with no server or database configured", async () => {
    // The command resolves before `resolveConfig`'s "not configured, stop"
    // gate — a hook must keep working on a machine with no `STANDUP_URL`,
    // classifying from its cache. If this ever fell through to the binding
    // resolution it would answer `unconfigured` and the guard would be gone.
    const spool = memorySpool();
    const outcome = await runCli(["hook", "run"], {
      env: {},
      hook: {
        spool,
        now: NOW,
        stdin: payload(),
        hook: { cacheText: ALLOW_ALL, askServer: async () => undefined },
      },
    });

    expect(outcome.exitCode).toBe(HOOK_EXIT.ALLOW);
    expect(outcome.hookResponse?.stdout).toBe("");
    expect(readSpool(spool.text()).records.length).toBe(1);
  });

  it("passes the hook's own exit code through for a deny", async () => {
    const outcome = await runCli(["hook", "run"], {
      env: {},
      hook: {
        spool: memorySpool(),
        now: NOW,
        stdin: payload(),
        hook: { cacheText: MATCH_NOTHING, askServer: async () => undefined },
      },
    });

    expect(outcome.exitCode).toBe(HOOK_EXIT.DENY);
    expect(outcome.hookResponse?.stdout).toContain('"decision":"deny"');
  });

  it("answers status in the ordinary envelope", async () => {
    const outcome = await runCli(["hook", "status"], {
      env: {},
      hook: { spool: memorySpool(), now: NOW },
    });
    expect(outcome.envelope).toEqual({ ok: true, data: { pending: 0, unreadableLines: 0 } });
    expect(outcome.hookResponse).toBe(undefined);
  });

  it("refuses an unrecognised verb rather than defaulting to run", async () => {
    // A typo defaulting to `run` would execute the decision path against an
    // empty stdin, which renders a deny — a mistyped maintenance command
    // answering as though it were a guard refusing a tool call.
    const outcome = await runCli(["hook", "flsuh"], {
      env: {},
      hook: { spool: memorySpool(), now: NOW },
    });
    expect(outcome.envelope).toMatchObject({
      ok: false,
      error: { code: "malformed_command", fields: ["verb"] },
    });
    expect(outcome.hookResponse).toBe(undefined);
  });

  it("refuses a bare `standup hook` with no verb", async () => {
    const outcome = await runCli(["hook"], { env: {}, hook: { spool: memorySpool(), now: NOW } });
    expect(outcome.envelope).toMatchObject({ ok: false, error: { code: "malformed_command" } });
  });

  it("refuses when the entry point supplied no edges", async () => {
    // Reporting a successful flush of zero here would hide a command line
    // that was driven by something that built it wrong.
    const outcome = await runCli(["hook", "status"], { env: {} });
    expect(outcome.envelope).toMatchObject({
      ok: false,
      error: { code: "malformed_command", fields: ["hook"] },
    });
  });
});

describe("the rendering flag cannot change what a guard says", () => {
  it("writes the hook's own JSON shape on stdout even with --json", async () => {
    const outcome = await runCli(["hook", "run", "--json"], {
      env: {},
      hook: {
        spool: memorySpool(),
        now: NOW,
        stdin: payload(),
        hook: { cacheText: MATCH_NOTHING, askServer: async () => undefined },
      },
    });

    const { streams, out, err } = captured();
    render(outcome, streams, true);

    // The hook's shape, not an envelope. A reader looking for
    // `hookSpecificOutput` must find it.
    const written = JSON.parse(out.join("").trim()) as Record<string, unknown>;
    expect(written.decision).toBe("deny");
    expect(written.hookSpecificOutput).toBeDefined();
    expect(written.ok).toBe(undefined);
    // The reason still reaches a tool that only reads stderr.
    expect(err.join("")).toContain("neither the allow-list nor the ask-list");
  });

  it("renders identically with and without --json", async () => {
    // The strongest form of the property: the flag is not merely handled,
    // it is inert on this path.
    const outcome = await runCli(["hook", "run"], {
      env: {},
      hook: {
        spool: memorySpool(),
        now: NOW,
        stdin: payload(),
        hook: { cacheText: MATCH_NOTHING, askServer: async () => undefined },
      },
    });

    const asJson = captured();
    render(outcome, asJson.streams, true);
    const asHuman = captured();
    render(outcome, asHuman.streams, false);

    expect(asJson.out.join("")).toBe(asHuman.out.join(""));
    expect(asJson.err.join("")).toBe(asHuman.err.join(""));
  });

  it("writes nothing at all for an allow", async () => {
    // §4 calls the allow path "log silently"; a line of noise after every
    // Read, Grep and Glob is what this prevents.
    const outcome = await runCli(["hook", "run"], {
      env: {},
      hook: {
        spool: memorySpool(),
        now: NOW,
        stdin: payload(),
        hook: { cacheText: ALLOW_ALL, askServer: async () => undefined },
      },
    });

    const { streams, out, err } = captured();
    render(outcome, streams, false);
    expect(out.join("")).toBe("");
    expect(err.join("")).toBe("");
  });

  it("still renders an ordinary envelope for status", async () => {
    // The negative half: the hook branch must not swallow the commands that
    // genuinely do answer in an envelope.
    const outcome = await runCli(["hook", "status"], {
      env: {},
      hook: { spool: memorySpool(), now: NOW },
    });

    const { streams, out } = captured();
    render(outcome, streams, true);
    expect(JSON.parse(out.join("").trim())).toEqual({
      ok: true,
      data: { pending: 0, unreadableLines: 0 },
    });
  });
});
