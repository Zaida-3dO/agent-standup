// The hook payload, as it arrives on stdin — MILESTONES.md #125,
// DECISIONS.md §4 ("One script, branching on the event type from stdin").
//
// The agent tool writes a JSON object to the hook process's stdin. This
// module turns that text into a normalised `HookEvent` — or says it could
// not, which is a *distinct* answer from "an event with nothing in it".
// That distinction is why this is a module rather than a `JSON.parse` at
// the call site: the caller must be able to tell "a `Stop`, which carries
// no command" apart from "a payload from a tool version this build has
// never seen", and there is no `HookEvent` on an `ok: false` for it to
// confuse them with.
//
// Both cases **allow** (DECISIONS.md §16), so the distinction decides what
// the session is *told* rather than what it is permitted — which is the
// difference between a person diagnosing a payload change in five seconds
// and not knowing anything changed.
//
// **Field names are read leniently, in a fixed order, and nothing is
// inferred.** Hook payload shapes differ between agent tools and between
// versions of one tool. The accepted spellings are listed explicitly below
// rather than discovered by scanning for any string property, because a
// scan would eventually pick up an unrelated field and report it as the
// command.

/** The event types the hook understands. Anything else is refused. */
import { readOverrideClaim, type OverrideClaim } from "./override";

export const HOOK_EVENT_TYPES = ["PreToolUse", "PostToolUse", "Stop"] as const;
export type HookEventType = (typeof HOOK_EVENT_TYPES)[number];

export function isHookEventType(value: unknown): value is HookEventType {
  return typeof value === "string" && (HOOK_EVENT_TYPES as readonly string[]).includes(value);
}

/** One normalised hook event: what happened, in whose session, to what. */
export interface HookEvent {
  readonly eventType: HookEventType;
  readonly sessionId: string;
  /** The tool the hook observed, e.g. `Bash`. Absent on a `Stop`. */
  readonly tool?: string;
  /**
   * The command text the call carried. Absent when the event carries none —
   * a `Stop`, or a tool whose input has no command-shaped field.
   *
   * Absent is **not** the same as "the payload was unreadable": that case
   * never produces a `HookEvent` at all.
   */
  readonly command?: string;
  /**
   * What the tool produced, on a `PostToolUse`.
   *
   * Carried as text and never interpreted here. The hook reports; the
   * server is the only party that decides whether a result means anything,
   * so parsing it locally would be exactly the kind of logic that makes a
   * script a reason to bump the protocol version.
   *
   * **Truncated** — see `MAX_TOOL_RESULT_CHARS`. A tool result is
   * unbounded (a file read, a full test log) and the hook is on the
   * critical path of every call; posting megabytes per call would make the
   * hook the slowest thing in the session.
   */
  readonly toolResult?: string;
  /**
   * An override the caller is asserting for a `block-overridable` finding.
   *
   * Present only when the caller deliberately sent one; absent is the
   * overwhelmingly common case and means "no override", which leaves every
   * block exactly as strong as it was. Validated by
   * `./override.ts`'s `readOverrideClaim`, which drops anything malformed
   * rather than partially accepting it — a garbled override must read as no
   * override, never as a weaker one.
   */
  readonly override?: OverrideClaim;
}

/**
 * How much of a tool result is carried.
 *
 * The head rather than the tail: a result's first characters identify what
 * it is, where its last characters are as likely to be the tail of a file
 * as anything meaningful. A server that needs more can ask the session.
 */
export const MAX_TOOL_RESULT_CHARS = 4000;

export type ParseResult =
  | { readonly ok: true; readonly event: HookEvent }
  | { readonly ok: false; readonly reason: string };

/**
 * The command-shaped fields of a tool input, in the order they are tried.
 *
 * `command` is the Bash-shaped one; the rest are here so that a Write or an
 * Edit reports the path it touches rather than reading as an event with no
 * command at all. Order is first-match, and it is fixed rather than
 * "whichever is longest" so the same payload always reports the same field —
 * an event whose content depends on field iteration order is one whose
 * server-side findings are not reproducible.
 */
const COMMAND_FIELDS = ["command", "file_path", "filePath", "path", "pattern", "url"] as const;

/** Reads one property off an unknown value without asserting its whole shape. */
function property(value: unknown, key: string): unknown {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)[key]
    : undefined;
}

/** The first of `keys` present on `source` as a non-empty string. */
function firstString(source: unknown, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = property(source, key);
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

/**
 * Parses one hook payload.
 *
 * Refuses — rather than defaulting — on: text that is not JSON, JSON that is
 * not an object, an unrecognised or missing `hook_event_name`, and a missing
 * session identifier. Each of those is a payload this build does not
 * understand, and reporting it as an event with no command would file it
 * under the same heading as a `Stop`, hiding a payload-shape change behind
 * a case that is entirely normal.
 *
 * The session identifier is required even though the local decision does not
 * turn on it, because every consumer of this event downstream
 * (the telemetry ingest of #50, the session handshake of #43, and the
 * displacement check in `./enforcement.ts`) is keyed on the session. An
 * event that cannot say whose it is would be attributed to the wrong
 * session, and a finding recorded against the wrong session is worse than
 * no finding at all.
 */
export function parseHookPayload(text: string): ParseResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, reason: "the hook payload was not valid JSON" };
  }

  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, reason: "the hook payload was not a JSON object" };
  }

  const eventType = firstString(raw, ["hook_event_name", "hookEventName", "eventType"]);
  if (!isHookEventType(eventType)) {
    return {
      ok: false,
      reason: `unrecognised hook event type ${eventType === undefined ? "(absent)" : `"${eventType}"`}`,
    };
  }

  const sessionId = firstString(raw, ["session_id", "sessionId"]);
  if (sessionId === undefined) {
    return { ok: false, reason: "the hook payload carried no session identifier" };
  }

  const tool = firstString(raw, ["tool_name", "toolName", "tool"]);
  const toolInput = property(raw, "tool_input") ?? property(raw, "toolInput");
  const command = firstString(toolInput, COMMAND_FIELDS);
  const toolResult = readToolResult(
    property(raw, "tool_response") ?? property(raw, "toolResponse"),
  );
  // Read from the top-level payload rather than from `tool_input`: an
  // override is a statement the *caller* makes about the guard, not an
  // argument to the tool being called, and putting it inside the tool input
  // would mean it reached whatever the tool does with unrecognised fields.
  const override = readOverrideClaim(
    property(raw, "standup_override") ?? property(raw, "standupOverride"),
  );

  return {
    ok: true,
    event: {
      eventType,
      sessionId,
      ...(tool === undefined ? {} : { tool }),
      ...(command === undefined ? {} : { command }),
      ...(toolResult === undefined ? {} : { toolResult }),
      ...(override === undefined ? {} : { override }),
    },
  };
}

/**
 * Normalises a tool response into bounded text.
 *
 * A string is taken as-is; anything else is serialised, because tools
 * differ on whether a result is a string or an object and the hook has no
 * business caring which. Serialisation that fails — a circular structure —
 * yields nothing rather than throwing: a tool result is the least important
 * field on the event, and losing it must never cost the call it describes.
 */
function readToolResult(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;

  let text: string;
  if (typeof value === "string") {
    text = value;
  } else {
    try {
      text = JSON.stringify(value) ?? "";
    } catch {
      return undefined;
    }
  }

  if (text.length === 0) return undefined;
  return text.length > MAX_TOOL_RESULT_CHARS ? text.slice(0, MAX_TOOL_RESULT_CHARS) : text;
}
