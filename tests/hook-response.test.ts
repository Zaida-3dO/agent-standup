// MILESTONES.md #42 — rendering a verdict (`src/lib/hook/response.ts`).
//
// A hook talks over two channels at once, and the tests below hold both
// open. Dropping either is a plausible "simplification" that passes any test
// asserting only the other:
//
//   - Stdout-only would let a tool that does not parse hook JSON run the
//     denied command.
//   - Exit-code-only would refuse it without ever saying why, which an agent
//     cannot act on.
import { describe, expect, it } from "vitest";
import { HOOK_EXIT, renderResponse } from "@/lib/hook/response";
import type { HookVerdict } from "@/lib/hook/decide";

const DENY: HookVerdict = {
  decision: "deny",
  reason: "this command matches neither list",
  source: "server",
};

describe("an allow says nothing", () => {
  it("writes nothing on either stream and exits zero", () => {
    // DECISIONS.md §4 calls the allow path "log silently". A hook that
    // printed on every allowed call would put a line of noise into the
    // session after every Read, Grep and Glob.
    const rendered = renderResponse(
      { decision: "allow", reason: "ok", source: "server" },
      "PreToolUse",
    );
    expect(rendered).toEqual({ stdout: "", stderr: "", exitCode: HOOK_EXIT.ALLOW });
  });
});

describe("a deny is emitted on both channels", () => {
  it("exits non-zero", () => {
    expect(renderResponse(DENY, "PreToolUse").exitCode).toBe(HOOK_EXIT.DENY);
  });

  it("exits 2 specifically, so the refusal reaches the model rather than only the person", () => {
    // `1` is an ordinary script failure that agent tools report and
    // otherwise ignore; `2` is the code that blocks and feeds stderr back.
    // A guard whose refusal the model never sees does not change what the
    // model does next.
    expect(HOOK_EXIT.DENY).toBe(2);
    expect(HOOK_EXIT.ALLOW).toBe(0);
  });

  it("writes the reason to stderr", () => {
    expect(renderResponse(DENY, "PreToolUse").stderr).toBe("this command matches neither list\n");
  });

  it("writes a JSON object to stdout carrying the decision, the reason and the source", () => {
    const parsed = JSON.parse(renderResponse(DENY, "PreToolUse").stdout);
    expect(parsed.decision).toBe("deny");
    expect(parsed.reason).toBe("this command matches neither list");
    // `source` distinguishes "denied because nothing matched" (a rules
    // question) from "denied because the server was unreachable" (an
    // outage). Without it the two are indistinguishable in a log.
    expect(parsed.source).toBe("unmatched");
  });

  it("also writes the nested permission shape, for readers that only understand that one", () => {
    const parsed = JSON.parse(renderResponse(DENY, "PostToolUse").stdout);
    expect(parsed.hookSpecificOutput).toEqual({
      hookEventName: "PostToolUse",
      permissionDecision: "deny",
      permissionDecisionReason: "this command matches neither list",
    });
  });

  it("echoes back the event name it was given", () => {
    const parsed = JSON.parse(renderResponse(DENY, "Stop").stdout);
    expect(parsed.hookSpecificOutput.hookEventName).toBe("Stop");
  });

  it("renders an event name of Unknown for a payload that was never parsed", () => {
    // The unreadable-payload path has no event name to take one from, and
    // inventing `PostToolUse` would produce a response claiming to describe
    // an event that may never have happened.
    const parsed = JSON.parse(renderResponse(DENY, "Unknown").stdout);
    expect(parsed.hookSpecificOutput.hookEventName).toBe("Unknown");
  });

  it("terminates stdout with a newline so a line-reading consumer sees a complete record", () => {
    expect(renderResponse(DENY, "Stop").stdout.endsWith("}\n")).toBe(true);
  });
});
