// The tool-call telemetry contract — MILESTONES.md #50 (ingest) and #88
// (the hook's spool and its batched flush), SCHEMA.md §10 (`tool_calls`).
//
// **This module is the single definition of the record both halves speak.**
// The client builds one of these and puts it on the spool; the server parses
// one of these and writes a row. Both import this file, so there is exactly
// one place the shape and the caps are decided.
//
// ── Why this exists as a module rather than as two agreeing copies ─────
//
// It was two copies, briefly, and every one of the four fields they could
// disagree about did:
//
//   | | ingest | spool |
//   |---|---|---|
//   | command cap | 4096 | 4000 |
//   | path count cap | 64 | 32 |
//   | path length cap | 256 | 512 |
//   | truncation marker | inside the cap | appended past it |
//
// Three of those are merely wasteful — the smaller cap wins in practice and
// the difference is silently discarded work. The fourth is not: a client
// that appends its marker *past* its own cap emits a string longer than the
// cap, which the server then truncates again, producing a value ending
// `…[truncated]…[truncated]`. Neither side is wrong on its own terms and
// neither side's tests can see it, because the defect exists only in the
// composition.
//
// The disagreement that forced this module was larger than the caps: the
// two sides did not agree on the *shape* either — where the session lives,
// which fields a record carries, and whether the body is an object or a
// bare array. Each side was internally consistent and fully tested, and
// neither side's tests could see it, because the defect existed only in the
// composition.
//
// The general shape is the one MILESTONES.md names for #98–#102: a
// composition gap between two rows that are each individually complete. The
// durable fix is not to reconcile the numbers by hand — that just re-arms
// the trap for #51, #52, #53 and #54 — but to remove the possibility of two
// definitions existing. Hence one module, imported by both.
//
// ── What lives here, and what deliberately does not ────────────────────
//
// Here: the record shape, the caps, and the two pure functions that apply
// them. All of it is transport-free and I/O-free, so the client can import
// it into a hook that must not touch a database and the server can import
// it into a service operation that must not touch a filesystem.
//
// Not here: the Zod schema (the server's parsing concern, and the client
// does not validate — it constructs), the spool's file format, and the
// database write. Those belong to the side that owns them.

/**
 * The longest `command` text kept, in characters.
 *
 * Chosen against what the field is *for* rather than against any storage
 * limit (the column is `text` and has none). Every consumer named in M7
 * reads a command to compare it with another — repeat detection (#54),
 * duration learning (§10), cost-per-stage attribution (#53) — and all of
 * those are satisfied by a prefix long enough to make two genuinely
 * different commands distinguishable. None are improved by the tail.
 *
 * 4096 clears real command lines with room to spare. The pathological case
 * is a heredoc carrying a whole source file as its command text, which is a
 * single Bash call whose `command` is the file; that is the case this
 * refuses. It is deliberately not smaller — a 256-byte cap would collide
 * distinct commands sharing a long prefix (the same `npm run` invocation
 * with different trailing arguments), and a collision is a *wrong*
 * measurement rather than a partial one.
 */
export const MAX_COMMAND_CHARS = 4096;

/**
 * The most `paths` entries kept, and the longest each may be.
 *
 * Two separate caps because the field has two independent ways to be huge,
 * and capping only the total would let either hide inside the other. A
 * `Glob` returns many short paths; one deeply-nested path is a single long
 * entry. The product bounds the field at ~16 KB worst case, which is the
 * number that decides whether this table stays small.
 *
 * 64 entries is set against path *spread* being the signal (§10: "Path
 * spread is a progress signal"; #54: "how wide the file spread is"). Spread
 * is a question about breadth, and the difference between an agent touching
 * 64 files and one touching 6,400 is already fully expressed by the first
 * 64. Below ~64 it would start to matter: a cap of 8 could not tell a
 * focused edit from a moderate refactor.
 */
export const MAX_PATHS = 64;
export const MAX_PATH_CHARS = 256;

/**
 * The longest tool name kept.
 *
 * A tool name is an identifier — `Bash`, `Read`, a namespaced MCP tool —
 * and the longest real one is comfortably under this. The cap exists
 * because `tool` arrives from the same untrusted payload every other field
 * does and nothing upstream constrains its length; a field that *should* be
 * short is precisely the one where an unbounded value goes unnoticed.
 */
export const MAX_TOOL_CHARS = 200;

/**
 * The longest session identifier kept.
 *
 * A UUID is 36 characters. This leaves room for prefixed or composite
 * session ids without being an unbounded index key — and this one *is* an
 * index key (`ToolCall_sessionId_ts_idx`), where an oversized value costs
 * more than the row it sits in. Worse than the cost: an uncapped id that
 * differs only past the cap would split one session's telemetry across two
 * keys, which is a wrong measurement rather than an expensive one.
 */
export const MAX_SESSION_ID_CHARS = 128;

/**
 * The most records accepted in one flush request.
 *
 * A cap on the *batch* as well as on the fields, for a reason the field
 * caps do not cover: a request holding an unbounded array is a memory cost
 * on the server before any cap can be applied, since the whole body is
 * parsed before a handler runs.
 *
 * 500 is comfortably above the client's own batch size, and the headroom is
 * deliberate — a client that raises its batching a little must not start
 * failing every flush against a server that has not been redeployed.
 */
export const MAX_BATCH_SIZE = 500;

/**
 * Appended to a value that was shortened, so a clipped value is never
 * mistaken for a complete short one.
 *
 * This matters more than it looks. Repeat detection (#54) compares command
 * strings; without a marker, two *different* long commands sharing a prefix
 * are stored byte-identically and read as a repeat. With the marker they
 * are still stored identically — but the marker says outright that the
 * comparison is over a prefix, so a consumer can decline to call it a
 * repeat rather than being told a falsehood.
 */
export const TRUNCATION_MARKER = "…[truncated]";

/**
 * Shortens `value` to at most `limit` characters, marking it when it cut.
 *
 * **The marker is counted inside the limit, not added past it**, so the
 * return value is never longer than `limit`. That is the property that
 * makes a cap a real bound, and it is the one both halves of this feature
 * must agree on: a client that appends its marker past its own cap emits a
 * value the server truncates a second time, producing a doubled marker and
 * a shorter prefix than either side intended.
 *
 * A value of exactly `limit` characters is complete and comes back
 * unmarked — marking it would claim a loss that did not happen.
 *
 * A limit shorter than the marker itself cannot express "this was cut", so
 * it degrades to a bare prefix rather than to a value that is all marker
 * and no content; the content is what the field is for. No cap defined here
 * is in that range, and a test asserts so.
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
 * would leave the surviving entries individually unbounded, so the worst
 * case would be `MAX_PATHS` × unbounded rather than `MAX_PATHS` ×
 * `MAX_PATH_CHARS`. Capping length first makes the product a real bound.
 *
 * Entries are kept from the front rather than sampled. The front of a path
 * list is the order the tool reported them in, which for the tools that
 * produce long lists is a stable traversal order — so the same glob run
 * twice truncates to the same paths and two runs are comparable. A random
 * or "widest spread" sample would make one call look different on every
 * run, destroying exactly the repeat detection #54 needs.
 */
export function capPaths(paths: readonly string[]): string[] {
  return paths.slice(0, MAX_PATHS).map((path) => capText(path, MAX_PATH_CHARS));
}

/**
 * One tool call, as the client spools it and the server ingests it.
 *
 * Field names are the API's camelCase rather than the table's snake_case:
 * this travels over an HTTP endpoint, not into Postgres directly, and every
 * other transport surface in this application is camelCase.
 *
 * **The session is not on this record.** It belongs to the batch
 * (`ToolCallBatch`), because a flush is one session's work: the records in
 * it came from one hook process in one session, so saying it once says it
 * structurally rather than trusting up to 500 records to repeat the same
 * value — and it makes the server's assignment lookup once per request
 * rather than once per record. A spool that spans sessions groups by
 * session before posting, which is free while the batch is being built.
 *
 * **`model` and `effort` are not here either.** SCHEMA.md §11 is explicit
 * that they are not columns on `tool_calls` ("two strings on ~450k rows a
 * year buys little"). MILESTONES.md #51 is the row that consumes them, and
 * it owns deciding how they travel — putting them on this record now would
 * be defining a field with nowhere to go and no reader.
 *
 * The four token counts are separate and never folded into a total, for the
 * reason §10 states outright: they price at wildly different rates, so one
 * total destroys the information the table exists to hold.
 */
export interface ToolCallRecord {
  /** When the call happened, per the client's clock, as an ISO-8601 string. */
  readonly ts: string;
  readonly tool: string;
  readonly command?: string;
  readonly paths?: readonly string[];
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheWriteTokens: number;
  readonly cacheReadTokens: number;
  readonly usage5h?: number;
  readonly usageWeekly?: number;
}

/**
 * One flush: whose calls these are, and the calls.
 *
 * This is the whole wire body — the client posts an object of this shape,
 * not a bare array. An envelope rather than a top-level array because the
 * session has to live somewhere and a naked array has nowhere to put it,
 * and because an object leaves room for a future field (an idempotency key
 * for the de-duplication this feature still owes) without changing the
 * shape of every request that already exists.
 */
export interface ToolCallBatch {
  readonly sessionId: string;
  readonly calls: readonly ToolCallRecord[];
}
