// `decideHook` — MILESTONES.md #41's own row text: "allow-list silent,
// ask-list answered, denies when unsure." Pure function, no I/O, so every
// case here is one-character-of-input-in, one-decision-out.
//
// The mutants this suite is written to kill, named per case below:
//   - swapping `allow`/`ask`/`deny` for one another
//   - checking the ask-list before the allow-list (order matters: a command
//     matching both must read as allowed)
//   - `.test()` becoming `!.test()`, or `find` becoming "match all" / "match
//     none"
//   - the "matches neither list" branch silently returning `allow` instead
//     of `deny` (the fail-closed default the row text names explicitly)
//   - an invalid pattern crashing the whole call instead of being skipped
import { describe, expect, it } from "vitest";
import { decideHook, HOOK_DECISIONS } from "@/lib/service/hook-decision";

describe("decideHook", () => {
  it("allows a command matching only the allow-list, silently — no list confusion", () => {
    const result = decideHook({
      command: "git status",
      allowPatterns: ["^git status$"],
      askPatterns: ["^rm "],
    });
    expect(result.decision).toBe("allow");
    expect(result.matchedList).toBe("allow");
    expect(result.matchedPattern).toBe("^git status$");
  });

  it("asks for a command matching only the ask-list", () => {
    const result = decideHook({
      command: "rm -rf build",
      allowPatterns: ["^git status$"],
      askPatterns: ["^rm "],
    });
    expect(result.decision).toBe("ask");
    expect(result.matchedList).toBe("ask");
    expect(result.matchedPattern).toBe("^rm ");
  });

  it("denies when unsure — a command matching neither list is refused, not allowed", () => {
    // This is the row's explicit fail-closed requirement. If the "neither
    // matched" branch ever became `allow`, this is the only assertion that
    // would notice.
    const result = decideHook({
      command: "curl https://example.invalid/hook",
      allowPatterns: ["^git status$"],
      askPatterns: ["^rm "],
    });
    expect(result.decision).toBe("deny");
    expect(result.matchedList).toBeNull();
    expect(result.matchedPattern).toBeNull();
  });

  it("denies when both lists are empty — the floor with nothing configured", () => {
    const result = decideHook({ command: "anything at all", allowPatterns: [], askPatterns: [] });
    expect(result.decision).toBe("deny");
  });

  it("prefers the allow-list when a command matches both — allow-list is checked first", () => {
    // Both patterns match "npm install". If the ask-list were checked
    // first, or if the two checks were combined with the wrong precedence,
    // this would come back "ask" instead of "allow".
    const result = decideHook({
      command: "npm install",
      allowPatterns: ["^npm install$"],
      askPatterns: ["^npm "],
    });
    expect(result.decision).toBe("allow");
    expect(result.matchedList).toBe("allow");
  });

  it("matches as a regular expression, not a literal substring — proves it is not string equality", () => {
    const result = decideHook({
      command: "rm -rf /tmp/scratch",
      allowPatterns: [],
      askPatterns: ["^rm -rf .*scratch$"],
    });
    expect(result.decision).toBe("ask");
  });

  it("does not match a pattern anchored to a prefix the command lacks", () => {
    // `^rm ` must not match "confirm the deploy" — proves the matcher is a
    // real regex test, not a substring/`includes` check that would wrongly
    // fire on "rm" appearing inside another word.
    const result = decideHook({
      command: "confirm the deploy",
      allowPatterns: [],
      askPatterns: ["^rm "],
    });
    expect(result.decision).toBe("deny");
  });

  it("skips an invalid pattern rather than throwing, and keeps checking the rest of the list", () => {
    const result = decideHook({
      command: "git status",
      allowPatterns: ["(unterminated", "^git status$"],
      askPatterns: [],
    });
    expect(result.decision).toBe("allow");
    expect(result.matchedPattern).toBe("^git status$");
  });

  it("denies when every pattern in both lists is invalid", () => {
    const result = decideHook({
      command: "git status",
      allowPatterns: ["(unterminated"],
      askPatterns: ["(also unterminated"],
    });
    expect(result.decision).toBe("deny");
  });

  it("HOOK_DECISIONS names exactly the three outcomes, allow/ask/deny in that order", () => {
    expect(HOOK_DECISIONS).toEqual(["allow", "ask", "deny"]);
  });
});
