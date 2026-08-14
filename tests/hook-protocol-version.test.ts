// The CI assertion MILESTONES.md #43 asks for: **the shipped hook's declared
// protocol version equals the build constant, so nobody has to remember to
// bump the right one.**
//
// ── What a green run here does, and does not, mean ─────────────────────
//
// It means the number the hook script declares and the number the server
// compares against are the same number, in this build, for the variant the
// shipped hook implements. It does **not** mean the hook and the server
// actually speak a compatible protocol — nothing here reads either one's
// behaviour, and a change that altered the hook's wire format without
// touching either constant would pass every assertion below. That is the
// gap a protocol version exists to *describe*, not one a version check can
// close, and the honest statement is that this catches the mechanical
// failure (two constants drifting) rather than the semantic one.
//
// ── Why it is worth running even though both read one constant ─────────
//
// `src/lib/hook/protocol.ts` reads `SHIPPED_HOOK_PROTOCOL_VERSION` rather
// than repeating a literal, so the two cannot drift by construction.
// That is the *good* state, and this test is what keeps it: the cheapest way
// to make the hook report a different version is to replace that read with a
// literal, which is a one-line edit that looks entirely reasonable in a diff
// and would be caught by nothing else. The assertions are written against
// the two *published* surfaces — the hook's exported constant and the
// server's `HOOK_PROTOCOL` — so they keep holding whichever way either is
// later implemented, and the structural block below is what keeps the
// mechanism itself asserted rather than only its current output.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { HOOK_PROTOCOL, SHIPPED_HOOK_PROTOCOL_VERSION } from "@/lib/build-constants";
import { HOOK_PROTOCOL_VERSION, SHIPPED_HOOK_VARIANT } from "@/lib/hook/protocol";

/** The variant the shipped hook implements — see `protocol.ts` for why it is `http`. */
const SHIPPED_VARIANT = SHIPPED_HOOK_VARIANT;

describe("the shipped hook's declared protocol version", () => {
  it("equals this build's current version for the variant it implements", () => {
    expect(HOOK_PROTOCOL_VERSION).toBe(HOOK_PROTOCOL[SHIPPED_VARIANT].current);
  });

  it("is the same number the server compares reported versions against", () => {
    expect(SHIPPED_HOOK_PROTOCOL_VERSION).toBe(HOOK_PROTOCOL[SHIPPED_VARIANT].current);
    expect(HOOK_PROTOCOL_VERSION).toBe(SHIPPED_HOOK_PROTOCOL_VERSION);
  });

  it("is one this build would accept from a session reporting it", () => {
    // The circular-looking case that is worth stating: a build whose own
    // shipped hook is below its own minimum would refuse every session
    // running the hook it just published, and every individual comparison
    // would be behaving correctly while the installation was unusable.
    expect(HOOK_PROTOCOL_VERSION).toBeGreaterThanOrEqual(
      HOOK_PROTOCOL[SHIPPED_VARIANT].minSupported,
    );
  });

  it("is a whole number, because the comparison is an ordering and nothing else", () => {
    expect(Number.isInteger(HOOK_PROTOCOL_VERSION)).toBe(true);
    for (const variant of Object.keys(HOOK_PROTOCOL) as (keyof typeof HOOK_PROTOCOL)[]) {
      expect(Number.isInteger(HOOK_PROTOCOL[variant].current)).toBe(true);
      expect(Number.isInteger(HOOK_PROTOCOL[variant].minSupported)).toBe(true);
    }
  });
});

describe("how the hook declares its version", () => {
  const source = readFileSync(
    path.join(process.cwd(), "src", "lib", "hook", "protocol.ts"),
    "utf-8",
  );

  const entryPoint = readFileSync(
    path.join(process.cwd(), "src", "bin", "standup-hook.ts"),
    "utf-8",
  );

  it("is the version the shipped script itself reports", () => {
    // The entry point must read the declaration rather than carrying a
    // second one, or `--protocol-version` could print a number the server
    // never compares against — which is the exact failure this row's CI
    // assertion exists to make impossible.
    expect(entryPoint).toContain('from "@/lib/hook/protocol"');
    expect(entryPoint).toContain("HOOK_PROTOCOL_VERSION");
    expect(entryPoint).not.toMatch(/HOOK_PROTOCOL_VERSION\s*=\s*\d/);
  });

  it("reads the shared constant rather than repeating a literal", () => {
    // The structural half of this file. The numeric assertions above pass
    // whether the hook reads the constant or hard-codes a number that
    // happens to match it; this one is what makes the *mechanism*
    // the thing being asserted, so a later edit that swaps the read
    // for `= 1` fails here rather than passing silently until the day the
    // server's number moves.
    expect(source).toContain("SHIPPED_HOOK_PROTOCOL_VERSION");
    expect(source).toMatch(
      /export const HOOK_PROTOCOL_VERSION\s*=\s*SHIPPED_HOOK_PROTOCOL_VERSION\s*;/,
    );
  });

  it("does not assign a bare numeric literal to its version constant", () => {
    expect(source).not.toMatch(/export const HOOK_PROTOCOL_VERSION\s*=\s*\d/);
  });
});
