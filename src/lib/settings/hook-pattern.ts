// The shape of `hook.allow_patterns` / `hook.ask_patterns` — SCHEMA.md §19
// (`POST /hook`), DECISIONS.md §4 ("The hook layer").
//
// DECISIONS.md §4: "The ask-list is **patterns, not tool names.**" Each
// entry is matched as a regular expression against the observed command
// text (`src/lib/service/hook-decision.ts`), so this schema's whole job is
// refusing a string that cannot compile as one — the same "provable from the
// value alone, on write" posture `capability-doc.ts` uses for its own
// registry entries, and for the same reason: a bad pattern discovered for
// the first time on the hot path (every tool call) is a worse failure than
// the same bad pattern refused once, at the settings write that introduced
// it.
import { z } from "zod";

/** True if `pattern` compiles as a `RegExp`. The only thing worth checking here. */
function compiles(pattern: string): boolean {
  try {
    new RegExp(pattern);
    return true;
  } catch {
    return false;
  }
}

/**
 * One list of hook patterns: non-empty strings, each a valid regular
 * expression. Order is not load-bearing — `decideHook` checks a whole list
 * for *any* match, not first-match semantics that would make ordering
 * matter — but the type is an array rather than a set because a person
 * editing `/settings` reasons about a list, not a set, and a duplicate
 * pattern is harmless rather than a validation failure worth surfacing.
 */
export const hookPatternListSchema = z.array(
  z
    .string()
    .min(1, "a hook pattern must not be empty")
    .refine(compiles, (pattern) => ({
      message: `"${pattern}" is not a valid regular expression`,
    })),
);

export type HookPatternList = z.infer<typeof hookPatternListSchema>;
