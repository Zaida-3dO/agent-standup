// The ownership check as the hook sees it — MILESTONES.md #45, wiring in
// `src/lib/hook/decide.ts` and the adapter in `src/lib/hook/ask-kill-guard.ts`.
//
// **What would make this file hollow.** `decide` denies in a great many
// situations, so asserting "it denied" proves almost nothing on its own —
// an empty rule cache denies too, and so does an unmatched command. Every
// case below therefore asserts the **`source`**, which names which gate
// produced the verdict, and the fixtures deliberately put a matching
// allow-list pattern in the cache so that a verdict attributed to the kill
// guard could not have come from anywhere else. If the guard stopped being
// consulted, these cases would not merely change their reason — they would
// flip to `allow` via `allow-list`, which is a visible, opposite result.
import { describe, expect, it, vi } from "vitest";
import { decide, type AskKillGuard, type KillGuardVerdict } from "@/lib/hook/decide";
import { createKillGuardAsk, type FetchLike } from "@/lib/hook/ask-kill-guard";
import type { HookEvent } from "@/lib/hook/payload";
import type { CacheState } from "@/lib/hook/rules-cache";

/**
 * A cache that allow-lists **everything**.
 *
 * This is the fixture choice that makes the file non-hollow. With it in
 * place, the only way a command can be denied is a gate that runs *before*
 * the pattern lists — which is exactly the structural property #45 claims
 * and the thing worth proving. A test using an empty cache would have got
 * its deny from the unmatched path and proved nothing.
 */
const ALLOW_EVERYTHING: CacheState = {
  status: "fresh",
  rules: { allowPatterns: [".*"], askPatterns: [] },
};

const never = async () => undefined;

function event(command: string): HookEvent {
  return { eventType: "PreToolUse", sessionId: "session-a", tool: "Bash", command };
}

function guard(verdict: KillGuardVerdict | undefined): AskKillGuard {
  return async () => verdict;
}

describe("the ownership check runs before the pattern lists", () => {
  it("refuses a kill the server says is not ours, even though the allow-list matches everything", async () => {
    const verdict = await decide({
      event: event("taskkill /F /IM node.exe"),
      cache: ALLOW_EVERYTHING,
      askServer: never,
      askKillGuard: guard({
        decision: "deny",
        basis: "unowned",
        reason: "2 live node processes belong to another crew",
      }),
    });

    expect(verdict.decision).toBe("deny");
    expect(verdict.source).toBe("kill-guard");
    expect(verdict.reason).toContain("another crew");
  });

  it("the identical command is allowed when the server says the processes are ours", async () => {
    // Same command text, same cache, one different server answer. A pattern
    // match cannot produce this pair, which is the row's whole premise.
    const verdict = await decide({
      event: event("taskkill /F /IM node.exe"),
      cache: ALLOW_EVERYTHING,
      askServer: never,
      askKillGuard: guard({ decision: "allow", basis: "owned" }),
    });

    expect(verdict.decision).toBe("allow");
  });

  it("an owned kill still goes to the pattern lists rather than short-circuiting", async () => {
    // Registering a process must not become a way to bypass every other
    // rule. With nothing allow-listed, an owned kill is still denied — by
    // the ordinary unmatched path, not by the guard.
    const verdict = await decide({
      event: event("kill 4821"),
      cache: { status: "fresh", rules: { allowPatterns: [], askPatterns: [] } },
      askServer: never,
      askKillGuard: guard({ decision: "allow", basis: "owned" }),
    });

    expect(verdict.decision).toBe("deny");
    expect(verdict.source).toBe("unmatched");
  });
});

describe("a kill wrapped in a shell does not slip past the guard", () => {
  // #122. These returned `not-a-kill` from the parser, and `not-a-kill` is
  // treated as final — so with the allow-list matching, they were allowed
  // with **no server round trip at all**. `sh -c "taskkill /F /IM node.exe"`
  // is byte-for-byte the machine-wide kill DECISIONS.md §4 exists to stop.
  //
  // Asserted at `decide` rather than only at the parser because that is where
  // the damage was: the parser was arguably answering its own question
  // correctly ("I see no kill verb"), and the bug only exists once that answer
  // is treated as permission.
  it.each([
    ["bash -c 'pkill -f node'"],
    ['sh -c "taskkill /F /IM node.exe"'],
    ["xargs kill -9"],
    ["ps aux | grep node | awk '{print $2}' | xargs kill -9"],
  ])(
    "%s reaches the guard and is denied, though the allow-list matches everything",
    async (command) => {
      // The server is asked and gives the unowned answer, which is the realistic
      // shape: these commands would end processes this session does not own.
      const askKillGuard = vi.fn<AskKillGuard>(async () => ({
        decision: "deny" as const,
        basis: "unowned" as const,
        reason: "node processes belong to another crew",
      }));
      const verdict = await decide({
        event: event(command),
        cache: ALLOW_EVERYTHING,
        askServer: never,
        askKillGuard,
      });

      // **The round trip is the assertion that matters.** The defect was not
      // that these were allowed by a lenient verdict — it was that the guard
      // was never consulted at all, so no verdict existed. With `.*`
      // allow-listed, a regression makes this `allow` via `allow-list` with
      // zero calls: the opposite result, not a softer message.
      expect(askKillGuard).toHaveBeenCalledTimes(1);
      expect(verdict.decision).toBe("deny");
      expect(verdict.source).toBe("kill-guard");
    },
  );

  it.each([["bash -c 'pkill -f node'"], ['sh -c "taskkill /F /IM node.exe"'], ["xargs kill -9"]])(
    "%s is denied fail-closed when the guard cannot be reached",
    async (command) => {
      // The other half: an unreachable guard must not become permission. This
      // is the state the bypass effectively produced — no answer — except that
      // it produced `allow` instead of a deny.
      const verdict = await decide({
        event: event(command),
        cache: ALLOW_EVERYTHING,
        askServer: never,
        askKillGuard: async () => undefined,
      });

      expect(verdict.decision).toBe("deny");
      expect(verdict.source).toBe("kill-guard-unreachable");
    },
  );

  it("a shell command that carries no kill is still allowed without a round trip", async () => {
    // The control. A fix that denied every `bash -c` would pass the four
    // cases above and make the hook unusable — every wrapped build command
    // would need a server verdict it should never have needed.
    const askKillGuard = vi.fn<AskKillGuard>(async () => undefined);
    const verdict = await decide({
      event: event("bash -c 'npm run build'"),
      cache: ALLOW_EVERYTHING,
      askServer: never,
      askKillGuard,
    });

    expect(verdict.decision).toBe("allow");
    expect(askKillGuard).not.toHaveBeenCalled();
  });
});

describe("what is NOT sent to the ownership check", () => {
  it("an ordinary command never reaches it", async () => {
    const askKillGuard = vi.fn<AskKillGuard>(async () => undefined);
    const verdict = await decide({
      event: event("git status"),
      cache: ALLOW_EVERYTHING,
      askServer: never,
      askKillGuard,
    });

    // Not merely "it was allowed" — the round trip was never made, which is
    // the cost property that makes a guard on this path affordable.
    expect(askKillGuard).not.toHaveBeenCalled();
    expect(verdict.decision).toBe("allow");
  });

  it("a Stop event, which carries no command, never reaches it", async () => {
    const askKillGuard = vi.fn<AskKillGuard>(async () => undefined);
    await decide({
      event: { eventType: "Stop", sessionId: "session-a" },
      cache: ALLOW_EVERYTHING,
      askServer: never,
      askKillGuard,
    });
    expect(askKillGuard).not.toHaveBeenCalled();
  });
});

describe("failing closed, at the narrowest scope that still does", () => {
  it("denies a kill when the ownership check cannot be reached", async () => {
    const verdict = await decide({
      event: event("kill 4821"),
      cache: ALLOW_EVERYTHING,
      askServer: never,
      askKillGuard: guard(undefined),
    });

    expect(verdict.decision).toBe("deny");
    expect(verdict.source).toBe("kill-guard-unreachable");
  });

  it("denies a kill when the ownership check throws", async () => {
    const verdict = await decide({
      event: event("kill 4821"),
      cache: ALLOW_EVERYTHING,
      askServer: never,
      askKillGuard: async () => {
        throw new Error("socket hang up");
      },
    });

    expect(verdict.decision).toBe("deny");
    expect(verdict.source).toBe("kill-guard-unreachable");
  });

  it("an unreachable check does NOT deny ordinary commands", async () => {
    // The scope of the fail-closed rule is the thing being asserted: an
    // outage must refuse kills, not stop every agent on the machine.
    const verdict = await decide({
      event: event("npm run build"),
      cache: ALLOW_EVERYTHING,
      askServer: never,
      askKillGuard: guard(undefined),
    });

    expect(verdict.decision).toBe("allow");
  });

  it("denies a kill the server could not read", async () => {
    const verdict = await decide({
      event: event('taskkill /F /FI "IMAGENAME eq node.exe"'),
      cache: ALLOW_EVERYTHING,
      askServer: never,
      askKillGuard: guard({
        decision: "deny",
        basis: "unparseable",
        reason: "the filter names processes this build cannot resolve",
      }),
    });

    expect(verdict.decision).toBe("deny");
    expect(verdict.source).toBe("kill-guard");
  });

  it("a not-a-kill basis from the server continues classification rather than allowing outright", async () => {
    // If the server disagrees with the local pre-filter, the command is not
    // waved through — it falls to the pattern lists like anything else.
    const verdict = await decide({
      event: event("kill 4821"),
      cache: { status: "fresh", rules: { allowPatterns: [], askPatterns: [] } },
      askServer: never,
      askKillGuard: guard({ decision: "allow", basis: "not-a-kill" }),
    });

    expect(verdict.decision).toBe("deny");
    expect(verdict.source).toBe("unmatched");
  });
});

describe("a build with no ownership check installed", () => {
  it("classifies exactly as it would without one", async () => {
    // Absent is not unreachable. An installation that has not configured a
    // machine name must not have every kill refused.
    const verdict = await decide({
      event: event("kill 4821"),
      cache: ALLOW_EVERYTHING,
      askServer: never,
    });

    expect(verdict.decision).toBe("allow");
    expect(verdict.source).toBe("allow-list");
  });
});

describe("the HTTP adapter for the ownership check", () => {
  function respond(body: unknown, ok = true): FetchLike {
    return async () => ({ ok, status: ok ? 200 : 500, json: async () => body });
  }

  it("sends the machine and the crew root alongside the command", async () => {
    const fetch = vi.fn<FetchLike>(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ decision: "allow", basis: "owned" }),
    }));

    const ask = createKillGuardAsk({
      baseUrl: "http://example.test/",
      fetch,
      machine: "laptop",
      rootSessionId: "root-a",
    });
    await ask(event("kill 4821"));

    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0]!;
    // The trailing slash on the base URL must not produce a double slash.
    expect(url).toBe("http://example.test/api/kill-guard");
    expect(JSON.parse(init.body)).toEqual({
      command: "kill 4821",
      machine: "laptop",
      sessionId: "session-a",
      rootSessionId: "root-a",
    });
  });

  it("omits the crew root when there is none, rather than sending an empty one", async () => {
    // A `.min(1)` schema server-side refuses an empty string, so sending one
    // would turn "this session is its own root" into an invalid_input.
    const fetch = vi.fn<FetchLike>(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ decision: "allow", basis: "owned" }),
    }));
    const ask = createKillGuardAsk({ baseUrl: "http://example.test", fetch, machine: "laptop" });
    await ask(event("kill 4821"));

    expect(JSON.parse(fetch.mock.calls[0]![1].body)).not.toHaveProperty("rootSessionId");
  });

  it.each([
    ["a non-success status", respond({ decision: "allow", basis: "owned" }, false)],
    [
      "a body that is not JSON",
      (() => {
        const f: FetchLike = async () => ({
          ok: true,
          status: 200,
          json: async () => {
            throw new Error("not json");
          },
        });
        return f;
      })(),
    ],
    ["an unrecognised decision", respond({ decision: "maybe", basis: "owned" })],
    // `basis` decides whether the answer is treated as a verdict at all, so
    // guessing it is guessing the one thing the response exists to say —
    // and the cheap guess would allow every kill against a server this
    // build cannot read.
    ["a missing basis", respond({ decision: "allow" })],
    ["an unrecognised basis", respond({ decision: "allow", basis: "probably" })],
  ])("returns no answer for %s", async (_name, fetch) => {
    const ask = createKillGuardAsk({ baseUrl: "http://example.test", fetch, machine: "laptop" });
    expect(await ask(event("kill 4821"))).toBeUndefined();
  });

  it("returns no answer when the request throws", async () => {
    const ask = createKillGuardAsk({
      baseUrl: "http://example.test",
      fetch: async () => {
        throw new Error("ECONNREFUSED");
      },
      machine: "laptop",
    });
    expect(await ask(event("kill 4821"))).toBeUndefined();
  });

  it("does not call out for an event with no command", async () => {
    const fetch = vi.fn<FetchLike>(respond({ decision: "allow", basis: "owned" }));
    const ask = createKillGuardAsk({ baseUrl: "http://example.test", fetch, machine: "laptop" });
    expect(await ask({ eventType: "Stop", sessionId: "session-a" })).toBeUndefined();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("reads a well-formed verdict through", async () => {
    const ask = createKillGuardAsk({
      baseUrl: "http://example.test",
      fetch: respond({ decision: "deny", basis: "unowned", reason: "not yours" }),
      machine: "laptop",
    });
    expect(await ask(event("kill 4821"))).toEqual({
      decision: "deny",
      basis: "unowned",
      reason: "not yours",
    });
  });
});
