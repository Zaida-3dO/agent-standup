// Comparing two versions of `budget.windows` — MILESTONES.md #87.
//
// `budget.windows` is a single setting holding a map, so an edit is a
// read-modify-write of the whole object: two sessions saving at once means
// the later one silently overwrites the earlier, including removing a
// window the other had just added. Acceptance criterion 3 is that this does
// not happen *silently*.
//
// ── Why comparison rather than a precondition ───────────────────────────
//
// The right fix is a server-side precondition, the way `transition_item`
// gained `expectedFrom` (MILESTONES.md #257): the write itself refuses when
// the value is not what the writer thought. `put_setting` has no such
// parameter — its input is `z.object({ key, value }).strict()`, and
// `.strict()` *rejects* an unknown key rather than ignoring it, so a client
// cannot opt into a check that is not there. Adding one means changing a
// core write operation, its HTTP adapter, the CLI and the MCP surface,
// which is a service-layer change rather than a UI one.
//
// So the editor re-reads immediately before writing and compares. These are
// the functions that do the comparing, kept pure so that "what counts as a
// change" and "how a change is described" are both provable as data.
//
// **What this is not.** A check-then-act is not atomic. It catches the case
// that actually happens — somebody else saved while this form was open, on
// a page open for minutes — and leaves a window of milliseconds it cannot
// catch. That limit is stated in the editor's own comment too, because a
// safety claim this code does not deliver would be worse than the race.
import type { BudgetWindows } from "../settings/budget-windows";

/**
 * Whether two stored values are the same configuration.
 *
 * Compared by canonical JSON rather than field by field: the value is
 * arbitrary nested JSON whose shape the schema owns, and a hand-written
 * comparison would have to be updated every time the schema gains a field —
 * silently missing changes until somebody noticed. Key order is normalised
 * so that a value which round-tripped through a database is not reported as
 * different from an identical one that did not.
 */
export function sameWindows(a: BudgetWindows, b: BudgetWindows): boolean {
  return canonical(a) === canonical(b);
}

/** JSON with object keys sorted at every level, so key order is not a difference. */
function canonical(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value === null || typeof value !== "object") return value;
  const entries = Object.entries(value as Record<string, unknown>).sort(([x], [y]) =>
    x < y ? -1 : x > y ? 1 : 0,
  );
  return Object.fromEntries(entries.map(([key, inner]) => [key, sortKeys(inner)]));
}

/**
 * What somebody else changed, in the reader's words.
 *
 * Names the windows rather than saying "the value changed", because the
 * decision the reader has to make — keep mine, or take theirs — depends
 * entirely on *what* moved. "Somebody added `nightly`" is a different
 * situation from "somebody changed the window you are editing", and a
 * message that flattened them would push the reader toward discarding work
 * without knowing what they were discarding.
 */
export function describeConcurrentChange(mine: BudgetWindows, theirs: BudgetWindows): string {
  const mineNames = Object.keys(mine);
  const theirNames = Object.keys(theirs);
  const added = theirNames.filter((name) => !mineNames.includes(name)).sort();
  const removed = mineNames.filter((name) => !theirNames.includes(name)).sort();
  const changed = theirNames
    .filter((name) => mineNames.includes(name))
    .filter((name) => canonical(mine[name]) !== canonical(theirs[name]))
    .sort();

  const parts: string[] = [];
  if (added.length > 0) parts.push(`added ${list(added)}`);
  if (removed.length > 0) parts.push(`removed ${list(removed)}`);
  if (changed.length > 0) parts.push(`changed ${list(changed)}`);

  // The generic branch is reachable: the values differ by canonical JSON
  // but no *window* differs — which is what a change to a window's name
  // casing or an unexpected top-level key would look like. Saying so
  // plainly beats naming nothing.
  const what = parts.length === 0 ? "changed the budget windows" : `${parts.join(", ")}`;

  return (
    `Somebody else ${what} while this page was open. ` +
    `Your changes have not been saved, so nothing of theirs was overwritten. ` +
    `Reload to take their version, or copy your changes elsewhere first.`
  );
}

/** `a`, `a and b`, `a, b and c` — a list a person would read out. */
function list(names: readonly string[]): string {
  const quoted = names.map((name) => `"${name}"`);
  if (quoted.length === 1) return quoted[0] as string;
  const last = quoted[quoted.length - 1] as string;
  return `${quoted.slice(0, -1).join(", ")} and ${last}`;
}
