// What the hook does with one event — MILESTONES.md #42, DECISIONS.md §4.
//
// This is the whole of the hook's behaviour, expressed as a function with no
// I/O of its own: the event in, the cache state in, a way to ask the server
// in, a verdict out. `../../bin/standup-hook.ts` supplies stdin, the
// filesystem and the network; nothing here knows they exist, which is what
// makes every refusal below testable without a process, a server, or a
// temporary directory.
//
// ── The order, and why it is this order ────────────────────────────────
//
//   1. **Session enforcement** (`./enforcement.ts`). A displaced or
//      unregistered session is refused whatever it is running — see that
//      module's header for why this cannot be a pattern-list entry.
//   2. **Nothing to classify.** A `Stop` carries no command. There is
//      nothing to be unsure *about*, so it is allowed by construction —
//      the same reading `hook_decision` already applies server-side
//      (`src/lib/service/operations/hook-decision.ts`).
//   3. **The cached lists**, matched by `decideHook` — the *same function*
//      the server calls, imported rather than reimplemented. DECISIONS.md
//      §4's "one script has nothing to agree with" applies to the matcher
//      too: two implementations of one match are two things that can
//      disagree about whether a pattern matched, and the disagreement would
//      be invisible until it allowed something.
//        - `allow` → silent, zero network. §4's explicit optimisation.
//        - `deny` (matched neither list) → **denied locally.** This is
//          "denies when unsure", and it does not consult the server: the
//          server's answer for the same input is the same function over the
//          same lists, so a round trip could only change the verdict if the
//          lists had changed, which is what the TTL is for.
//        - `ask` → the server decides.
//   4. **The server's verdict**, when asked. Anything other than a verdict
//      this build understands — a network failure, a non-200, a body that
//      is not one of the three decisions — is a **deny**.
//
// ── Fail closed, stated once ───────────────────────────────────────────
//
// Every branch below that cannot produce a confident `allow` produces a
// `deny`. There is deliberately no path that turns a failure into an allow,
// and no configuration flag that could add one, because such a flag is the
// first thing reached for during an incident and the thing nobody removes
// afterwards. The cost of this posture is that a machine which cannot reach
// the server has its *guarded* commands refused; the cost of the opposite is
// that a machine which cannot reach the server has its guarded commands
// **permitted**, silently, exactly when nobody is watching.

import { decideHook, type HookDecision } from "@/lib/service/hook-decision";
import type { HookEvent } from "./payload";
import type { CacheState, HookRules } from "./rules-cache";
import { enforcementRefusal, type SessionEnforcement } from "./enforcement";

/**
 * What the hook concluded, and why.
 *
 * Two outcomes, not the service layer's three: `ask` is the service's word
 * for "a human or a server rule must decide", and by the time this function
 * returns that decision has already been made. A hook that answered `ask` to
 * the agent tool would be answering a question with a question.
 */
export interface HookVerdict {
  readonly decision: Exclude<HookDecision, "ask">;
  /** A sentence naming the cause. Rendered for a denied call; unused for an allow. */
  readonly reason: string;
  /**
   * Where the verdict came from. Kept because "denied locally because it
   * matched nothing" and "denied because the server could not be reached"
   * are operationally different problems that look identical without it —
   * the first is a rules-configuration question, the second is an outage.
   */
  readonly source:
    | "enforcement"
    | "no-command"
    | "allow-list"
    | "unmatched"
    | "server"
    | "server-unreachable"
    | "no-rules";
  /** The pattern that matched, when one did. */
  readonly matchedPattern?: string;
}

/** The server's answer to an ask-list match, as this build understands it. */
export interface ServerVerdict {
  readonly decision: "allow" | "deny";
  readonly reason?: string;
  /** Rules the server volunteered, for the caller to re-cache. */
  readonly rules?: HookRules;
  /** Session enforcement the server volunteered. */
  readonly enforcement?: SessionEnforcement;
}

export type AskServer = (event: HookEvent) => Promise<ServerVerdict | undefined>;

export interface DecideOptions {
  readonly event: HookEvent;
  readonly cache: CacheState;
  /**
   * Asks the server. Returns `undefined` for **any** failure — unreachable,
   * a non-success status, a body this build cannot read. Collapsing all of
   * those into one value is deliberate: they have exactly one consequence
   * here (deny), and a caller that had to enumerate them could forget one
   * and let it fall through to the success branch.
   */
  readonly askServer: AskServer;
  /** Enforcement known before the call, e.g. read from a local file. */
  readonly enforcement?: SessionEnforcement;
}

const ALLOW = (source: HookVerdict["source"], reason: string): HookVerdict => ({
  decision: "allow",
  reason,
  source,
});

/**
 * Decides one hook event.
 *
 * Never throws for an expected failure — every one of them is a `deny` with
 * a reason. A thrown exception from `askServer` is caught here rather than
 * left to the entry point, because an uncaught throw would leave the hook
 * process with no output at all, and a hook that says nothing is read by the
 * agent tool as "no objection".
 */
export async function decide({
  event,
  cache,
  askServer,
  enforcement,
}: DecideOptions): Promise<HookVerdict> {
  // 1. Is this session allowed to be acting at all?
  const refusal = enforcementRefusal(enforcement);
  if (refusal !== null) {
    return { decision: "deny", reason: refusal.reason, source: "enforcement" };
  }

  // 2. Nothing to classify.
  if (event.command === undefined || event.command.length === 0) {
    return ALLOW("no-command", "this event carries no command to classify");
  }

  // 3. No usable rules at all — the local half cannot answer, so the server
  //    must. Note this is NOT the same as empty rule lists, which are a
  //    complete answer meaning "guard nothing by name, deny the unknown".
  if (cache.status === "unavailable") {
    return await askOrDeny(event, askServer, `no rules are available (${cache.reason})`);
  }

  const local = decideHook({
    command: event.command,
    allowPatterns: cache.rules.allowPatterns,
    askPatterns: cache.rules.askPatterns,
  });

  if (local.decision === "allow") {
    return {
      ...ALLOW("allow-list", "allowed by the cached allow-list"),
      ...(local.matchedPattern === null ? {} : { matchedPattern: local.matchedPattern }),
    };
  }

  if (local.decision === "deny") {
    // "Denies when unsure", decided locally and at zero network cost. A
    // stale cache does not change this: the lists are what the server last
    // said, and asking would return the same verdict from the same function
    // unless they have since changed — which the TTL already schedules a
    // refresh for.
    return {
      decision: "deny",
      reason:
        "this command matches neither the allow-list nor the ask-list, so the hook cannot tell " +
        "whether it is safe to run. Add a pattern for it if it should be allowed or examined.",
      source: "unmatched",
    };
  }

  // 4. An ask-list match. The server is the authority.
  return await askOrDeny(event, askServer, "the server could not be reached for a verdict");
}

async function askOrDeny(
  event: HookEvent,
  askServer: AskServer,
  unreachableReason: string,
): Promise<HookVerdict> {
  let answer: ServerVerdict | undefined;
  try {
    answer = await askServer(event);
  } catch {
    answer = undefined;
  }

  if (answer === undefined) {
    return {
      decision: "deny",
      reason: `${unreachableReason}, and the hook denies when it cannot get an answer`,
      source: "server-unreachable",
    };
  }

  // The server may report enforcement on the same round trip. It is checked
  // here as well as at the top because this is the first moment it can be
  // known — a session displaced a second ago has nothing about it on disk.
  const refusal = enforcementRefusal(answer.enforcement);
  if (refusal !== null) {
    return { decision: "deny", reason: refusal.reason, source: "enforcement" };
  }

  if (answer.decision === "allow") {
    return ALLOW("server", answer.reason ?? "allowed by the server");
  }

  return {
    decision: "deny",
    reason: answer.reason ?? "denied by the server",
    source: "server",
  };
}
