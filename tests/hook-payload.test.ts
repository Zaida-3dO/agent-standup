// MILESTONES.md #42 — the hook payload parser (`src/lib/hook/payload.ts`).
//
// The assertions that matter here are the refusals. A payload this build
// cannot read must not become "an event with no command", because that
// shape is allowed by construction (`decide.ts` step 2) — so a parser that
// degraded instead of refusing would turn every unreadable payload into a
// silent allow. Each rejection below is one spelling of that mistake.
import { describe, expect, it } from "vitest";
import { HOOK_EVENT_TYPES, isHookEventType, parseHookPayload } from "@/lib/hook/payload";

function payload(extra: Record<string, unknown>): string {
  return JSON.stringify({ session_id: "s-1", ...extra });
}

describe("parseHookPayload accepts what it understands", () => {
  it("reads a PostToolUse Bash call into event type, session, tool and command", () => {
    const result = parseHookPayload(
      payload({
        hook_event_name: "PostToolUse",
        tool_name: "Bash",
        tool_input: { command: "git status" },
      }),
    );

    expect(result).toEqual({
      ok: true,
      event: {
        eventType: "PostToolUse",
        sessionId: "s-1",
        tool: "Bash",
        command: "git status",
      },
    });
  });

  it("reads a Stop as a well-formed event with no tool and no command", () => {
    const result = parseHookPayload(payload({ hook_event_name: "Stop" }));

    expect(result.ok).toBe(true);
    // Not merely "no command" — no tool either, and still `ok`. This is the
    // one shape that legitimately carries nothing to classify, and it has to
    // be distinguishable from a payload that was unreadable.
    expect(result.ok && result.event).toEqual({ eventType: "Stop", sessionId: "s-1" });
  });

  it("accepts the camelCase spellings of every field", () => {
    const result = parseHookPayload(
      JSON.stringify({
        hookEventName: "PreToolUse",
        sessionId: "s-2",
        toolName: "Write",
        toolInput: { filePath: "src/a.ts" },
      }),
    );

    expect(result).toEqual({
      ok: true,
      event: {
        eventType: "PreToolUse",
        sessionId: "s-2",
        tool: "Write",
        command: "src/a.ts",
      },
    });
  });

  it("classifies a Write against its path rather than reading as command-less", () => {
    // Without this, every Write and Edit would take the "nothing to
    // classify" branch and be allowed unconditionally — the pattern lists
    // would guard Bash and nothing else.
    const result = parseHookPayload(
      payload({
        hook_event_name: "PreToolUse",
        tool_name: "Write",
        tool_input: { file_path: "/etc/hosts" },
      }),
    );

    expect(result.ok && result.event.command).toBe("/etc/hosts");
  });

  it("prefers `command` over the other command-shaped fields", () => {
    // Order is fixed and first-match so that one payload always classifies
    // the same way; a matcher whose input depends on field iteration order
    // produces denials nobody can reproduce.
    const result = parseHookPayload(
      payload({
        hook_event_name: "PostToolUse",
        tool_name: "Bash",
        tool_input: { path: "/tmp/x", command: "rm -rf /" },
      }),
    );

    expect(result.ok && result.event.command).toBe("rm -rf /");
  });

  it("treats a tool input with no command-shaped field as carrying no command", () => {
    const result = parseHookPayload(
      payload({
        hook_event_name: "PostToolUse",
        tool_name: "TodoWrite",
        tool_input: { todos: [] },
      }),
    );

    expect(result.ok).toBe(true);
    expect(result.ok && result.event.command).toBeUndefined();
  });
});

describe("parseHookPayload refuses what it cannot read", () => {
  it("refuses text that is not JSON", () => {
    const result = parseHookPayload("not json at all");
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toContain("not valid JSON");
  });

  it("refuses an empty stdin", () => {
    // The realistic shape of "the tool invoked the hook wrongly". It must
    // not parse to a command-less event.
    expect(parseHookPayload("").ok).toBe(false);
  });

  it("refuses JSON that is not an object", () => {
    for (const text of ["[]", '"a string"', "42", "null"]) {
      const result = parseHookPayload(text);
      expect(result.ok, `expected ${text} to be refused`).toBe(false);
    }
  });

  it("refuses an unrecognised event type, naming it", () => {
    const result = parseHookPayload(payload({ hook_event_name: "SessionStart" }));
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toContain("SessionStart");
  });

  it("refuses a payload with no event type at all", () => {
    const result = parseHookPayload(payload({ tool_name: "Bash" }));
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toContain("(absent)");
  });

  it("refuses a payload with no session identifier", () => {
    // Required even though the local decision does not turn on it: every
    // downstream consumer is keyed on the session, and enforcing against
    // the wrong session is worse than refusing.
    const result = parseHookPayload(JSON.stringify({ hook_event_name: "Stop" }));
    expect(result.ok).toBe(false);
    expect(!result.ok && result.reason).toContain("session identifier");
  });

  it("refuses an empty-string session identifier rather than accepting it", () => {
    const result = parseHookPayload(JSON.stringify({ hook_event_name: "Stop", session_id: "" }));
    expect(result.ok).toBe(false);
  });
});

describe("the event-type list", () => {
  it("is exactly the three events the hook is wired to, and nothing else", () => {
    expect(HOOK_EVENT_TYPES).toEqual(["PreToolUse", "PostToolUse", "Stop"]);
  });

  it("isHookEventType rejects non-strings and unknown strings", () => {
    expect(isHookEventType("PostToolUse")).toBe(true);
    expect(isHookEventType("posttooluse")).toBe(false);
    expect(isHookEventType(undefined)).toBe(false);
    expect(isHookEventType(1)).toBe(false);
  });
});
