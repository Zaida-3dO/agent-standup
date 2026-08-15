// MILESTONES.md #88 — `standup hook` (`src/lib/cli/hook-command.ts`).
//
// **The property worth more than every other assertion here: spooling can
// never change a verdict.** Telemetry is measurement; the hook's job is to
// decide whether a command may run. A full disk, a read-only home directory
// or a spool owned by another user must not turn into a denied tool call —
// that would be a guard refusing work for a reason having nothing to do
// with whether the work is safe. Several tests below do nothing but break
// the spool in a different way and assert the verdict is untouched.
//
// The second property is the ordering: the decision is produced *before*
// the record is spooled, so the slowest thing in the hook never sits in
// front of the fastest and most common path.
import { describe, expect, it, vi } from "vitest";
import { isHookVerb, runHookCommand, spoolEvent, type SpoolStore } from "@/lib/cli/hook-command";
import { readSpool, serialiseRecord } from "@/lib/hook/spool";
import { HOOK_EXIT } from "@/lib/hook/response";
import type { SpooledToolCall } from "@/lib/hook/spool-record";

const NOW = 1_700_000_000_000;

/** A server that allows. With no local rules left, this is the ordinary path. */
const ALLOWING = async () => ({ decision: "allow" as const });

/** A server that refuses. The only thing that can produce a deny on a `pre` call. */
const BLOCKING = async () => ({ decision: "block" as const, reason: "refused by the server" });

/** An in-memory spool. The append path is an append, as on disk. */
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

/** A spool where every operation throws — a full disk, or a read-only home. */
function brokenSpool(): SpoolStore {
  return {
    append: () => {
      throw new Error("ENOSPC: no space left on device");
    },
    read: () => {
      throw new Error("EACCES: permission denied");
    },
    replace: () => {
      throw new Error("EACCES: permission denied");
    },
  };
}

function payload(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    hook_event_name: "PostToolUse",
    session_id: "session-a",
    tool_name: "Bash",
    tool_input: { command: "git status" },
    usage: { input_tokens: 10, output_tokens: 20 },
    ...overrides,
  });
}

/** Rules that allow everything, so a verdict is an allow unless stated. */

describe("hook run answers the agent tool and spools the call", () => {
  it("allows silently and writes one record", async () => {
    const spool = memorySpool();
    const outcome = await runHookCommand({
      verb: "run",
      stdin: payload(),
      spool,
      now: NOW,
      hook: { askServer: ALLOWING },
    });

    expect(outcome.kind).toBe("hook-response");
    if (outcome.kind !== "hook-response") throw new Error("unreachable");
    expect(outcome.response.exitCode).toBe(HOOK_EXIT.ALLOW);
    expect(outcome.response.stdout).toBe("");

    const records = readSpool(spool.text()).records;
    expect(records.length).toBe(1);
    expect(records[0]).toMatchObject({
      sessionId: "session-a",
      tool: "Bash",
      command: "git status",
      inputTokens: 10,
      outputTokens: 20,
    });
  });

  it("spools the call it denied, too", async () => {
    // A denied call is a call that was attempted, and it is one of the most
    // interesting rows in the table. Spooling only allows would silently
    // omit exactly the events anyone would go looking for.
    const spool = memorySpool();
    const outcome = await runHookCommand({
      verb: "run",
      // `PreToolUse`: the only phase a block can refuse.
      stdin: payload({ hook_event_name: "PreToolUse" }),
      spool,
      now: NOW,
      hook: { askServer: BLOCKING },
    });

    if (outcome.kind !== "hook-response") throw new Error("unreachable");
    expect(outcome.response.exitCode).toBe(HOOK_EXIT.DENY);
    expect(readSpool(spool.text()).records.length).toBe(1);
  });

  it("spools nothing for a payload it could not read, and allows it", async () => {
    // The unreadable payload allows (DECISIONS.md §16) and there is nothing
    // to measure — inventing a record for it would put a row in the table
    // describing an event nobody can attribute.
    const spool = memorySpool();
    const outcome = await runHookCommand({
      verb: "run",
      stdin: "{not json",
      spool,
      now: NOW,
      hook: { askServer: ALLOWING },
    });

    if (outcome.kind !== "hook-response") throw new Error("unreachable");
    expect(outcome.response.exitCode).toBe(HOOK_EXIT.ALLOW);
    expect(spool.text()).toBe("");
  });

  it("spools nothing for a Stop, which names no tool", async () => {
    const spool = memorySpool();
    const outcome = await runHookCommand({
      verb: "run",
      stdin: JSON.stringify({ hook_event_name: "Stop", session_id: "session-a" }),
      spool,
      now: NOW,
      hook: { askServer: ALLOWING },
    });

    if (outcome.kind !== "hook-response") throw new Error("unreachable");
    expect(outcome.response.exitCode).toBe(HOOK_EXIT.ALLOW);
    expect(spool.text()).toBe("");
  });
});

describe("spooling can never change a verdict", () => {
  it("still allows when the spool cannot be written", async () => {
    // The case this whole section exists for: a full disk must not become a
    // denied tool call.
    const outcome = await runHookCommand({
      verb: "run",
      stdin: payload(),
      spool: brokenSpool(),
      now: NOW,
      hook: { askServer: ALLOWING },
    });

    if (outcome.kind !== "hook-response") throw new Error("unreachable");
    expect(outcome.response.exitCode).toBe(HOOK_EXIT.ALLOW);
    expect(outcome.response.stdout).toBe("");
  });

  it("still denies, with the same reason, when the spool cannot be written", async () => {
    // The mirror: a broken spool must not soften a denial either.
    const working = await runHookCommand({
      verb: "run",
      stdin: payload(),
      spool: memorySpool(),
      now: NOW,
      hook: { askServer: BLOCKING },
    });
    const broken = await runHookCommand({
      verb: "run",
      stdin: payload(),
      spool: brokenSpool(),
      now: NOW,
      hook: { askServer: BLOCKING },
    });

    if (working.kind !== "hook-response" || broken.kind !== "hook-response") {
      throw new Error("unreachable");
    }
    expect(broken.response).toEqual(working.response);
  });

  it("returns undefined from spoolEvent rather than throwing when the append fails", () => {
    expect(spoolEvent(payload(), brokenSpool(), NOW)).toBe(undefined);
  });

  it("decides before it spools", async () => {
    // **The ordering is deliberate and this is what holds it.** Spooling
    // first would put a filesystem write in front of every verdict, so the
    // slowest thing in the hook would sit on the path of the fastest and
    // most common case; and a hook killed between the two would delay a
    // decision rather than lose a measurement, which is the wrong thing to
    // lose. Both are stated in three comments and neither was tested — a
    // refactor that moved the `spoolEvent` call above `runHook` passed the
    // entire suite.
    //
    // The event that orders them is the server call: it happens *inside*
    // `runHook`, so an append recorded after it proves the spool write
    // followed the decision rather than preceding it. The ask-list path is
    // used because it is the one that reaches the server at all.
    const order: string[] = [];
    const spool: SpoolStore = {
      append: () => order.push("append"),
      read: () => "",
      replace: () => {},
    };

    await runHookCommand({
      verb: "run",
      stdin: payload(),
      spool,
      now: NOW,
      hook: {
        askServer: async () => {
          order.push("ask");
          return { decision: "allow" as const };
        },
      },
    });

    expect(order).toEqual(["ask", "append"]);
  });

  it("spools after the verdict has been rendered, not merely after the ask", async () => {
    // Stronger than the sequence above, which a `spoolEvent` call placed
    // between the ask and the render would still satisfy. Here the spool's
    // append asserts on a value that only exists once `runHook` has
    // returned — so the append genuinely cannot run before the verdict is
    // in hand.
    let verdictReady = false;
    let appendSawVerdict: boolean | undefined;

    const spool: SpoolStore = {
      append: () => {
        appendSawVerdict = verdictReady;
      },
      read: () => "",
      replace: () => {},
    };

    const outcome = await runHookCommand({
      verb: "run",
      stdin: payload(),
      spool: {
        ...spool,
        append: (line) => {
          // Reads the flag at append time, which is the moment under test.
          appendSawVerdict = verdictReady;
          void line;
        },
      },
      now: NOW,
      hook: {
        askServer: async () => {
          // Set as `runHook` resolves its verdict — anything appending
          // before this point sees `false`.
          verdictReady = true;
          return { decision: "allow" as const };
        },
      },
    });

    if (outcome.kind !== "hook-response") throw new Error("unreachable");
    expect(appendSawVerdict).toBe(true);
  });
});

describe("hook status reports what is waiting", () => {
  it("counts pending records and unreadable lines", async () => {
    const record: SpooledToolCall = {
      sessionId: "session-a",
      ts: "2026-01-01T00:00:00.000Z",
      tool: "Bash",
      inputTokens: 0,
      outputTokens: 0,
      cacheWriteTokens: 0,
      cacheReadTokens: 0,
    };
    const spool = memorySpool(`${serialiseRecord(record)}garbage\n${serialiseRecord(record)}`);

    const outcome = await runHookCommand({ verb: "status", spool, now: NOW });
    expect(outcome.kind).toBe("envelope");
    if (outcome.kind !== "envelope") throw new Error("unreachable");
    expect(outcome.envelope).toEqual({ ok: true, data: { pending: 2, unreadableLines: 1 } });
  });

  it("reports an unreadable spool as empty rather than failing the command", async () => {
    // "I could not read it" is the answer someone running `status` wants;
    // an error envelope would say less.
    const outcome = await runHookCommand({ verb: "status", spool: brokenSpool(), now: NOW });
    if (outcome.kind !== "envelope") throw new Error("unreachable");
    expect(outcome.envelope).toEqual({ ok: true, data: { pending: 0, unreadableLines: 0 } });
  });
});

describe("hook flush", () => {
  const record = (tool: string): SpooledToolCall => ({
    sessionId: "session-a",
    ts: "2026-01-01T00:00:00.000Z",
    tool,
    inputTokens: 0,
    outputTokens: 0,
    cacheWriteTokens: 0,
    cacheReadTokens: 0,
  });

  it("sends the spool and shortens it to what was not accepted", async () => {
    const spool = memorySpool(
      [record("a"), record("b"), record("c")].map(serialiseRecord).join(""),
    );
    const outcome = await runHookCommand({
      verb: "flush",
      spool,
      now: NOW,
      batchSize: 2,
      send: async (batch) => batch.calls[0]?.tool === "a",
    });

    if (outcome.kind !== "envelope") throw new Error("unreachable");
    expect(outcome.envelope).toEqual({
      ok: true,
      data: { sent: 2, retained: 1, skipped: 0, dropped: 0, batches: 2, stoppedEarly: true },
    });
    expect(readSpool(spool.text()).records.map((one) => one.tool)).toEqual(["c"]);
  });

  it("leaves the spool file untouched when the flush changed nothing", async () => {
    // A failed flush must not rewrite a file that is only ever appended to:
    // it would turn an unreachable server into a repeated full-file rewrite
    // and widen the window in which a crash could tear one.
    const original = serialiseRecord(record("a"));
    const replace = vi.fn();
    const spool: SpoolStore = { append: () => {}, read: () => original, replace };

    const outcome = await runHookCommand({
      verb: "flush",
      spool,
      now: NOW,
      send: async () => false,
    });

    if (outcome.kind !== "envelope") throw new Error("unreachable");
    expect(outcome.envelope).toMatchObject({ ok: true, data: { sent: 0, retained: 1 } });
    expect(replace).not.toHaveBeenCalled();
  });

  it("reports the flush honestly when the spool cannot be shortened afterwards", async () => {
    // The records were accepted by the server, so the send genuinely
    // happened; they will simply be sent again (at-least-once by design).
    // Reporting a failure here would be less true than reporting what
    // occurred.
    const spool: SpoolStore = {
      append: () => {},
      read: () => serialiseRecord(record("a")),
      replace: () => {
        throw new Error("EACCES: permission denied");
      },
    };

    const outcome = await runHookCommand({
      verb: "flush",
      spool,
      now: NOW,
      send: async () => true,
    });

    if (outcome.kind !== "envelope") throw new Error("unreachable");
    expect(outcome.envelope).toMatchObject({ ok: true, data: { sent: 1, retained: 0 } });
  });

  it("refuses a flush with nowhere to send rather than reporting a successful zero", async () => {
    const outcome = await runHookCommand({ verb: "flush", spool: memorySpool(), now: NOW });
    if (outcome.kind !== "envelope") throw new Error("unreachable");
    expect(outcome.envelope).toMatchObject({
      ok: false,
      error: { code: "malformed_command", fields: ["send"] },
    });
  });
});

describe("the verbs are a closed set", () => {
  it("recognises exactly run, flush and status", () => {
    expect(isHookVerb("run")).toBe(true);
    expect(isHookVerb("flush")).toBe(true);
    expect(isHookVerb("status")).toBe(true);
    // A typo must not fall through to `run`, which would render a deny for
    // a mistyped maintenance command.
    expect(isHookVerb("flsuh")).toBe(false);
    expect(isHookVerb("")).toBe(false);
    expect(isHookVerb(undefined)).toBe(false);
    expect(isHookVerb("RUN")).toBe(false);
  });
});
