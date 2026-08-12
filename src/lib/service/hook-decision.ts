// The hook decision — pure classification, no I/O. MILESTONES.md #41;
// DECISIONS.md §4 ("The hook layer"); SCHEMA.md §19 (`POST /hook`: "Returns
// allow/deny for guarded patterns, or nudge text, or nothing.").
//
// DECISIONS.md §4: "Two lists: patterns it always allows (log silently) and
// patterns where it **waits for a server verdict**. Fails **closed** — no
// answer means denied." And: "The ask-list is **patterns, not tool names.**"
//
// This module is the "no answer means denied" rule made literal: a command
// that matches neither list is not a maybe, it is a `deny`. Every later PR
// that adds judgement (the merge gate #44, the kill guard #45, nudges #46)
// narrows what happens on the `ask` path — it never has to touch this
// function, because none of them can turn a `deny` into anything softer by
// construction: there is no "unsure, but allow anyway" branch here to find.
//
// Deliberately independent of `ServiceContext`/settings: the decision
// function takes the two pattern lists as plain input, so its rejections can
// be tested as one-character-of-input-in, one-decision-out — no snapshot,
// no database, nothing to seed.

/** The three outcomes a hook call can receive. */
export const HOOK_DECISIONS = ["allow", "ask", "deny"] as const;
export type HookDecision = (typeof HOOK_DECISIONS)[number];

export interface HookDecisionResult {
  readonly decision: HookDecision;
  /**
   * Which list produced the decision, and the exact pattern that matched —
   * `null` when nothing matched (the fail-closed `deny`). Kept so a caller
   * can log *why*, and so a test can assert the match was attributed to the
   * right list rather than merely getting the right verdict by accident.
   */
  readonly matchedList: "allow" | "ask" | null;
  readonly matchedPattern: string | null;
}

/**
 * One command string against one pattern list.
 *
 * Patterns are regular expressions, not tool names or literal strings —
 * DECISIONS.md §4 is explicit that matching on the tool name alone would
 * send every command through the same list regardless of what it actually
 * does. An invalid pattern (one that cannot compile as a `RegExp`) is
 * skipped rather than thrown on: a single malformed override must not take
 * down every hook call on the process, and `hook.allow_patterns` /
 * `hook.ask_patterns` are validated against `hookPatternListSchema` at write
 * time (`src/lib/settings/registry.ts`) precisely so this path is not the
 * place a bad pattern is first discovered.
 */
function findMatch(command: string, patterns: readonly string[]): string | null {
  for (const pattern of patterns) {
    let regex: RegExp;
    try {
      regex = new RegExp(pattern);
    } catch {
      continue;
    }
    if (regex.test(command)) return pattern;
  }
  return null;
}

export interface HookDecisionInput {
  /** The command text the hook observed. Matched against both lists. */
  readonly command: string;
  readonly allowPatterns: readonly string[];
  readonly askPatterns: readonly string[];
}

/**
 * Classifies one command against the allow-list and the ask-list.
 *
 * Order matters and is the row's own wording: **allow-list silent, ask-list
 * answered, denies when unsure.** The allow-list is checked first, so a
 * command matching both an allow pattern and an ask pattern reads as
 * intentional configuration overlap that skews toward *not* interrupting —
 * the same posture DECISIONS.md §4 states for the mechanism as a whole
 * ("no match → allow locally, zero network" is the *client's* cache of this
 * same list; nothing here is stricter than that for an allow match). A
 * command matching neither list is the "unsure" case the row names
 * explicitly, and it denies — never falls through to an implicit allow.
 */
export function decideHook(input: HookDecisionInput): HookDecisionResult {
  const allowMatch = findMatch(input.command, input.allowPatterns);
  if (allowMatch !== null) {
    return { decision: "allow", matchedList: "allow", matchedPattern: allowMatch };
  }

  const askMatch = findMatch(input.command, input.askPatterns);
  if (askMatch !== null) {
    return { decision: "ask", matchedList: "ask", matchedPattern: askMatch };
  }

  return { decision: "deny", matchedList: null, matchedPattern: null };
}
