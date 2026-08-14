// Session enforcement — the state that can refuse a session's tool calls
// outright, before any pattern is consulted.
//
// MILESTONES.md #42 delivers the hook script; this module is the seam it
// leaves for the rows that put judgement behind it. Two of those are already
// named and shaped:
//
//   - **Forced takeover.** When an item is taken from a live session, that
//     session is *displaced*: it holds no claim on the work, yet it is still
//     running and will keep calling tools against a claim it does not have.
//     The mechanism that stops it is this hook — the displaced session's
//     subsequent tool calls are refused. The server decides *that* a session
//     is displaced; this module decides what the hook does about it.
//   - **Registration (§21).** A session below `min_supported`, or one that
//     never registered, "may not claim". That is the same shape: a fact
//     about the session, not about the command.
//
// ── Why this is checked BEFORE the pattern lists, not folded into them ──
//
// A pattern list answers "is this command guarded?". Displacement answers
// "should this session be running at all?" — and those compose the wrong way
// round if displacement is expressed as a pattern. `hook.allow_patterns` is
// checked first by `decideHook` and is documented as winning ("a command
// matching both reads as allowed"), so a displaced session running an
// allow-listed command would be allowed, which is exactly the case the
// takeover exists to stop: the displaced agent's next call is overwhelmingly
// likely to be something ordinary. Making this a separate, earlier gate
// means **no allow-list entry can relax it**, and that property is
// structural rather than a rule someone has to remember when editing
// settings.
//
// ── Why the state is a plain, readable value ───────────────────────────
//
// The row that wires displacement server-side is not this one, so this
// module deliberately does not know *how* the state arrives — a field on the
// hook decision response, a session-registration reply, or a local file
// written by whatever performed the takeover. It defines the shape and the
// consequence, and `readSessionStatus` normalises any of those sources into
// it. That keeps the wiring row to "produce this shape" rather than
// "re-derive the enforcement".

/**
 * What the system holds true about a session.
 *
 * `active` is the ordinary case and the only one that lets a call proceed to
 * pattern matching. Every other value is a refusal with its own reason, so
 * a person reading a denied call's output learns which one it was rather
 * than seeing one generic message for four different situations.
 */
export const SESSION_STATUSES = ["active", "displaced", "unregistered", "incompatible"] as const;
export type SessionStatus = (typeof SESSION_STATUSES)[number];

export function isSessionStatus(value: unknown): value is SessionStatus {
  return typeof value === "string" && (SESSION_STATUSES as readonly string[]).includes(value);
}

/** The enforcement state for one session, as the hook sees it. */
export interface SessionEnforcement {
  readonly status: SessionStatus;
  /**
   * Free text from whoever set the status — who took the item, which
   * version is required. Rendered into the refusal so the agent reading it
   * can act, rather than retrying into the same wall.
   */
  readonly detail?: string;
}

/** The refusal a non-`active` status produces, or `null` when the call may proceed. */
export interface EnforcementRefusal {
  readonly status: Exclude<SessionStatus, "active">;
  readonly reason: string;
}

const REASONS: Readonly<Record<Exclude<SessionStatus, "active">, string>> = Object.freeze({
  displaced:
    "This session holds no claim on the work it is running — the item was taken over by another " +
    "session. Stop here and report what you had completed; do not continue making changes.",
  unregistered:
    "This session has not registered with the server, so its actions cannot be attributed or " +
    "guarded. Register the session, then retry.",
  incompatible:
    "This session's hook is older than the server's minimum supported protocol version, so the " +
    "rules it would enforce are not the rules the server expects. Update, then retry.",
});

/**
 * Whether this session may make tool calls at all.
 *
 * Returns `null` for `active` — the ordinary path, and the only one that
 * continues to pattern matching. Everything else refuses, and the refusal
 * carries both the machine-readable status and the sentence a person or an
 * agent reads.
 *
 * **An unrecognised status refuses**, on the same fail-closed rule as the
 * rest of the hook: a status this build does not know is a statement the
 * server made that this build cannot honour, and the safe reading of "I do
 * not understand what you said about this session" is not "carry on".
 */
export function enforcementRefusal(
  enforcement: SessionEnforcement | undefined,
): EnforcementRefusal | null {
  if (enforcement === undefined) return null;
  if (enforcement.status === "active") return null;

  if (!isSessionStatus(enforcement.status)) {
    return {
      status: "incompatible",
      reason:
        "The server reported a session status this hook does not recognise, so it cannot tell " +
        "whether this session is allowed to act. Update, then retry.",
    };
  }

  const base = REASONS[enforcement.status];
  return {
    status: enforcement.status,
    reason:
      enforcement.detail === undefined || enforcement.detail.length === 0
        ? base
        : `${base} (${enforcement.detail})`,
  };
}

/**
 * Normalises an arbitrary value — a field off a server response, a parsed
 * local file — into a `SessionEnforcement`.
 *
 * `undefined` for anything that does not carry a recognised status, so an
 * absent field means "nothing said about this session" (proceed to the
 * patterns) rather than a refusal. That asymmetry is deliberate and is the
 * one place this module is *not* fail-closed: the enforcement source is
 * optional by construction until the wiring row lands, and treating its
 * absence as a refusal would deny every tool call on every machine the day
 * this ships. What is fail-closed is a status that is *present and
 * unreadable* — see `enforcementRefusal` above.
 */
export function readSessionStatus(value: unknown): SessionEnforcement | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  const status = record.status;
  if (typeof status !== "string") return undefined;

  const detail = typeof record.detail === "string" ? record.detail : undefined;

  // A present-but-unknown status is kept, not dropped: dropping it would
  // turn "the server said something about this session that this build
  // cannot read" into "the server said nothing", which is precisely the
  // silent downgrade this hook must not perform. It is cast through the
  // type here so that `enforcementRefusal`'s unrecognised-status branch is
  // reachable rather than dead.
  return { status: status as SessionStatus, ...(detail === undefined ? {} : { detail }) };
}
