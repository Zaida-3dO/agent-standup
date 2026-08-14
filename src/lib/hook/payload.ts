// The hook payload, as it arrives on stdin — MILESTONES.md #42
// ("The hook script: one file, fires after each tool call and at stop"),
// DECISIONS.md §4 ("One script, wired to both `PostToolUse` and `Stop`,
// branching on the event type from stdin").
//
// The agent tool writes a JSON object to the hook process's stdin. This
// module turns that text into a normalised `HookEvent` — or says it could
// not, which is a *distinct* answer from "an event with nothing in it".
// That distinction is the whole reason this is a module rather than a
// `JSON.parse` at the call site:
//
//   - An event that genuinely carries no command (a `Stop`, which has no
//     tool at all) is well-formed, and the decision layer allows it because
//     there is nothing to be unsure *about*.
//   - A payload that could not be understood is NOT that. It might have
//     carried `rm -rf /`. Returning a command-less event for it would route
//     it into the same "nothing to match" branch and allow it — the exact
//     shape of failure DECISIONS.md §4 forbids ("Fails **closed** — no
//     answer means denied").
//
// So `parseHookPayload` returns a discriminated result, and the caller
// cannot accidentally treat the second case as the first: there is no
// `HookEvent` on an `ok: false`, so there is nothing to pass on.
//
// **Field names are read leniently, in a fixed order, and nothing is
// inferred.** Hook payload shapes differ between agent tools and between
// versions of one tool, and a field this module does not recognise must
// degrade to "no command found", which denies — never to a guess that
// happens to allow. The accepted spellings are listed explicitly below
// rather than discovered by scanning for any string property, because a
// scan would eventually pick up an unrelated field and classify against it.

/** The event types the hook understands. Anything else is refused. */
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
   * The command text to classify. Absent when the event carries none —
   * a `Stop`, or a tool whose input has no command-shaped field.
   *
   * Absent is **not** the same as "the payload was unreadable": that case
   * never produces a `HookEvent` at all.
   */
  readonly command?: string;
}

export type ParseResult =
  | { readonly ok: true; readonly event: HookEvent }
  | { readonly ok: false; readonly reason: string };

/**
 * The command-shaped fields of a tool input, in the order they are tried.
 *
 * `command` is the Bash-shaped one and the only one the guarded patterns are
 * really written against; the rest are here so that a Write or an Edit is
 * classified against the path it touches rather than silently reading as an
 * event with no command. Order is first-match, and it is fixed rather than
 * "whichever is longest" so that the same payload always classifies the same
 * way — a matcher whose input depends on field iteration order is a matcher
 * whose denials are not reproducible.
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
 * understand, and the honest answer to "should this tool call run?" when the
 * question itself was unreadable is that we do not know, which denies.
 *
 * The session identifier is required even though the local decision does not
 * turn on it, because every consumer of this event downstream
 * (the telemetry ingest of #50, the session handshake of #43, and the
 * displacement check in `./enforcement.ts`) is keyed on the session. An
 * event that cannot say whose it is cannot be enforced against the right
 * session, and enforcing against the wrong one is worse than refusing.
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

  return {
    ok: true,
    event: {
      eventType,
      sessionId,
      ...(tool === undefined ? {} : { tool }),
      ...(command === undefined ? {} : { command }),
    },
  };
}
