// `standup service info` — the CLI's `buildInput` half, at the level
// `cli-item-verbs.test.ts` already exercises other commands at.
//
// `service_info` declares `kind: z.enum(["read", "write"]).optional()` —
// "Restrict the catalogue to one kind" — and this command bound `noInput`,
// so `--kind` could never reach the operation. `service_info` has no HTTP
// route and is waived off both MCP transports (`tests/cli-http-binding.test.ts`
// names it explicitly), so the command line is its ONLY surface: before this
// fix, the field was unreachable everywhere, on every adapter, permanently.
//
// The single-character change that breaks this: reverting
// `buildInput: (_rest, flags) => flagsToInput(flags)` back to
// `buildInput: noInput` in `src/lib/cli/commands.ts` makes the second case
// below fail — `--kind` would vanish from the built input again.
import { describe, expect, it } from "vitest";
import { COMMANDS } from "@/lib/cli";

function commandFor(noun: string, verb: string) {
  const command = COMMANDS.find((c) => c.noun === noun && c.verb === verb);
  if (!command) throw new Error(`no such command: ${noun} ${verb}`);
  return command;
}

describe("service info", () => {
  const info = commandFor("service", "info");

  it("builds an empty input when --kind is absent", () => {
    const built = info.buildInput([], {});
    expect(built).toEqual({ ok: true, input: {} });
  });

  it("carries --kind through to the operation's input", () => {
    const built = info.buildInput([], { kind: "read" });
    expect(built).toEqual({ ok: true, input: { kind: "read" } });
  });

  it("drops the global flags, same as every other flag-passthrough command", () => {
    const built = info.buildInput([], { kind: "write", json: true, as: "user-a" });
    expect(built).toEqual({ ok: true, input: { kind: "write" } });
  });
});
