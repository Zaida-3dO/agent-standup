// The caps on a tool-call telemetry record — MILESTONES.md #50 ("Tool-call
// ingest from the hook, with the item's state at the time, caps on the big
// fields"), SCHEMA.md §10 (`tool_calls`).
//
// ── Why caps are the interesting part of this row ──────────────────────
//
// `tool_calls` is, by SCHEMA.md §10's own description, "the highest-volume
// table" here: one row per tool call, written by the hook, with zero agent
// effort spent deciding whether a given call is worth recording. That is
// the right design for telemetry — the M7 warning is that facet and cost
// history cannot be backfilled, so the cheap thing to do is record
// everything and decide later what it meant.
//
// It is also exactly the design that makes an uncapped field catastrophic,
// and the arithmetic is worth writing down rather than gesturing at. Two of
// these fields are attacker-shaped without any attacker involved:
//
//   - `command` is *the tool's own input*. For `Bash` that is a command
//     line, usually well under a kilobyte. But `command` is populated from
//     the first command-shaped field of the tool input
//     (`src/lib/hook/payload.ts`), and a `Write` carries a whole file. A
//     single agent writing a 2 MB generated file produces a single 2 MB
//     telemetry row, and it produces one every time it rewrites that file.
//   - `paths` is *a list*, and the tools that produce the longest lists are
//     the ones agents call most (`Glob`, `Grep`). A glob over
//     `node_modules` legitimately returns tens of thousands of entries.
//
// At §10's own volume estimate — "tens of thousands of rows per busy week",
// and §11's "~450k rows a year" — a mean row size of a few hundred bytes is
// a table measured in hundreds of megabytes a year, which is fine. The same
// table with an uncapped `command` averaging even 50 KB is tens of
// gigabytes a year, for data nothing reads in full: the M9 model picker
// wants *facets* of a command (does it repeat, how wide is the file spread,
// read-to-write ratio — MILESTONES.md #54), not its transcript.
//
// So the caps here are not defensive trimming. They are the statement of
// what this table is for: enough of each field to identify and compare
// calls, and nothing past that.
//
// ── Truncate, never reject ─────────────────────────────────────────────
//
// An over-cap field is truncated and the row is still written. It is
// tempting to refuse the record instead — it is malformed input, after all
// — but refusing loses the row entirely, and the row is the thing that
// cannot be backfilled. A 4 KB prefix of a 2 MB `Write` still answers every
// question M7 and M9 ask of it (which tool, which session, which item
// state, how many tokens); dropping it answers none of them. The
// truncation is *visible* rather than silent — see `TRUNCATION_MARKER` —
// so nothing downstream mistakes a clipped command for a short one.
//
// Rejection is reserved for input that is wrong rather than merely large:
// a negative token count, a non-integer, a value past what the column can
// hold. Those are handled by the operation's schema, not here, because
// clamping them would fabricate a measurement — and a fabricated
// measurement in a table whose entire purpose is measurement is worse than
// a refused write.

/**
 * The longest `command` text stored, in characters.
 *
 * 4096 is chosen against what the field is *for* rather than against any
 * storage limit (the column is `text` and has none). Every consumer named
 * in M7 reads a command to compare it with another command — repeat
 * detection (#54), duration learning (§10), cost-per-stage attribution
 * (#53). All of those are satisfied by a prefix long enough to make two
 * genuinely different commands distinguishable, and none of them are
 * improved by the tail.
 *
 * 4096 clears real command lines with room to spare: a long shell pipeline
 * with paths is a few hundred characters, and the longest thing that
 * plausibly arrives as a *command* rather than as a file body is a heredoc,
 * which is already an outlier at 1–2 KB. It is deliberately not smaller —
 * a 256-byte cap would collide distinct commands that share a long prefix
 * (the same `npm run` invocation with different trailing arguments), and a
 * collision is a *wrong* measurement rather than a partial one.
 */
export const MAX_COMMAND_CHARS = 4096;

/**
 * The most `paths` entries stored, and the longest each may be.
 *
 * Two separate caps because the field has two independent ways to be huge,
 * and capping only the total would let either one hide inside the other. A
 * `Glob` returns many short paths; a single deeply-nested path on a machine
 * with a long home directory is one long entry. The product bounds the
 * field at ~16 KB in the worst case, which is the number that actually
 * matters for the table's size.
 *
 * 64 entries is set against path *spread* being the signal (§10: "Path
 * spread is a progress signal", #54: "how wide the file spread is"). Spread
 * is a question about breadth, and the difference between an agent touching
 * 64 files and one touching 6,400 is already fully expressed by the first
 * 64 — both read as "very wide" to any consumer, and the 6,336 additional
 * strings buy no further discrimination. Below ~64 it would start to matter:
 * a cap of 8 could not tell a focused edit apart from a moderate refactor.
 */
export const MAX_PATHS = 64;
export const MAX_PATH_CHARS = 256;

/**
 * The longest tool name stored.
 *
 * A tool name is an identifier — `Bash`, `Read`, `mcp__standup__get_item` —
 * and the longest real one is an MCP-namespaced tool, comfortably under
 * this. The cap exists because `tool` arrives from the same untrusted
 * payload every other field does and nothing upstream constrains its
 * length; a field that *should* be short is precisely the one where an
 * unbounded value would go unnoticed.
 */
export const MAX_TOOL_CHARS = 128;

/**
 * The longest session identifier stored.
 *
 * A UUID is 36 characters. This leaves room for prefixed or composite
 * session ids without being an unbounded index key — and this one is an
 * index key (`ToolCall_sessionId_ts_idx`), where an oversized value costs
 * more than the row it sits in.
 */
export const MAX_SESSION_ID_CHARS = 128;

/**
 * Appended to a value that was cut, so a clipped value is never mistaken
 * for a complete short one.
 *
 * This matters more than it looks. Repeat detection (#54) compares command
 * strings; without a marker, two *different* 10 KB commands sharing a 4 KB
 * prefix are stored as byte-identical rows and read as a repeat. With the
 * marker they are still stored identically — but the marker says outright
 * that the comparison is over a prefix, so a consumer can decline to call
 * it a repeat rather than being told a falsehood. The marker is counted
 * *inside* the cap, not added on top of it, so the cap is a real bound on
 * what is stored rather than an approximate one.
 */
export const TRUNCATION_MARKER = "…[truncated]";

/**
 * Cuts `value` to at most `limit` characters, marking it when it cut.
 *
 * Returns the input unchanged when it fits — including when it is exactly
 * at the limit, which is the boundary worth being explicit about: a value
 * of exactly `limit` characters is complete, so marking it would claim a
 * loss that did not happen.
 *
 * When it does not fit, the result is exactly `limit` characters: a prefix
 * plus the marker. A limit shorter than the marker itself cannot express
 * "this was cut", so it degrades to a bare prefix rather than to a value
 * that is all marker and no content — the content is what the field is for.
 */
export function capText(value: string, limit: number): string {
  if (value.length <= limit) return value;
  if (limit <= TRUNCATION_MARKER.length) return value.slice(0, limit);
  return value.slice(0, limit - TRUNCATION_MARKER.length) + TRUNCATION_MARKER;
}

/**
 * Applies both path caps: each entry is capped in length, then the list is
 * capped in count.
 *
 * The order is deliberate and not interchangeable. Capping the count first
 * would mean the entries that survive are still individually unbounded, so
 * the field's worst case would be `MAX_PATHS` × unbounded rather than
 * `MAX_PATHS` × `MAX_PATH_CHARS`. Capping length first makes the product a
 * real bound.
 *
 * Entries are kept from the front rather than sampled. The front of a path
 * list is the order the tool reported them in, which for the tools that
 * produce long lists is a stable traversal order — so the same glob run
 * twice truncates to the same 64 paths, and two runs are comparable. A
 * random or "widest spread" sample would make the same call look different
 * on every run, which destroys exactly the repeat detection #54 needs.
 */
export function capPaths(paths: readonly string[]): string[] {
  return paths.slice(0, MAX_PATHS).map((path) => capText(path, MAX_PATH_CHARS));
}
