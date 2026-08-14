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
//   2b. **The kill guard** (MILESTONES.md #45). An ownership question, not
//      a pattern question: would this command end a process this session's
//      crew did not start? It runs BEFORE the pattern lists for the same
//      structural reason enforcement does — `hook.allow_patterns` is
//      documented as winning, so a kill expressed as a pattern could be
//      relaxed by an allow-list entry someone added for an unrelated
//      reason, and the blast radius §4 describes would be back. It is also
//      deliberately not on the *ask*-list: an ask-list match resolves to a
//      deny in this build, which refuses a crew killing its own dev server
//      — the ordinary case.
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
import { parseKillCommand } from "@/lib/kill/parse";
import type { StopContext } from "./stop-catch";
import { evaluateNudges, isWriteShaped, type Nudge, type NudgeContext } from "./nudge";

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
    | "no-rules"
    /** The ownership check refused, or could not read the command (#45). */
    | "kill-guard"
    /** The ownership check was needed and could not be reached (#45). */
    | "kill-guard-unreachable";
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
  /**
   * What the server knows about this session's crew, for the stop-hook
   * catch (MILESTONES.md #47). Advisory only — `decide` never reads it, and
   * nothing in it can change a verdict.
   */
  readonly stop?: StopContext;
  /**
   * Nudge context the server volunteered (MILESTONES.md #46). Advisory only:
   * nothing here can change `decision`, and `decide` never reads it while
   * choosing one.
   */
  readonly nudge?: NudgeContext;
}

export type AskServer = (event: HookEvent) => Promise<ServerVerdict | undefined>;

/**
 * The kill guard's answer, as this build understands it (MILESTONES.md #45).
 *
 * `basis` is carried through rather than collapsed into the decision
 * because `not-a-kill` is the one value that means *nothing was guarded* —
 * the hook must go on to classify the command normally, and a plain
 * `allow` here would short-circuit the pattern lists for every command on
 * the machine. That is the single most consequential distinction in this
 * type, so it is a field rather than an inference from the reason text.
 */
export interface KillGuardVerdict {
  readonly decision: "allow" | "deny";
  readonly basis: "not-a-kill" | "owned" | "unowned" | "unparseable";
  readonly reason?: string;
}

/**
 * Asks the server whether this command's kill targets belong to the caller.
 *
 * `undefined` for **any** failure, on the same collapsing rule as
 * `askServer`. Unlike `askServer`, an unreachable kill guard does not deny
 * unconditionally — see `decide` for what it does instead, and why.
 */
export type AskKillGuard = (event: HookEvent) => Promise<KillGuardVerdict | undefined>;

/**
 * A verdict and anything the session should be told alongside it
 * (MILESTONES.md #46).
 *
 * The two travel together and are computed apart. `verdict` is produced by
 * `decide`, which cannot see the nudge context at all; `nudges` are produced
 * by `evaluateNudges`, which cannot see the verdict. Composing them here —
 * rather than letting `decide` return nudges — is what makes "a nudge never
 * blocks" a property of the code's shape instead of a rule to remember.
 */
export interface DecidedEvent {
  readonly verdict: HookVerdict;
  readonly nudges: readonly Nudge[];
}

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
  /**
   * Asks the ownership check (MILESTONES.md #45).
   *
   * Optional so that a build wired before #45's route exists behaves
   * exactly as it did — absent means the guard is not installed, which is
   * different from installed-and-unreachable and must not read as a
   * refusal of every kill on the machine.
   */
  readonly askKillGuard?: AskKillGuard;
  /** Nudge context known before the call. Advisory — see `DecidedEvent`. */
  readonly nudge?: NudgeContext;
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
  askKillGuard,
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

  // 2b. The ownership check. Only consulted for a command that could end a
  //     process — decided locally, by the same parser the server uses, so
  //     the overwhelming majority of tool calls cost nothing here. That
  //     local read is a *pre-filter and never a verdict*: it can only send
  //     a command to the server or not, and the server's registry is the
  //     only thing that decides ownership.
  const killVerdict = await consultKillGuard(event, askKillGuard);
  if (killVerdict !== null) return killVerdict;

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

/**
 * The ownership check, or `null` when it has nothing to say and the ordinary
 * classification should continue (MILESTONES.md #45).
 *
 * ── Why the local parse is a filter and not a decision ─────────────────
 *
 * `parseKillCommand` runs here to answer one question — *could this end a
 * process?* — and its answer is used for exactly one thing: whether to
 * spend a round trip. It never allows and never denies on its own. Two
 * properties follow, and both matter:
 *
 *   - **A command it reads as not-a-kill costs nothing.** That is what
 *     keeps the guard affordable on a path that runs on every tool call,
 *     and it is the same trade DECISIONS.md §4 makes for the allow-list.
 *   - **A command it reads as a kill is never resolved locally**, not even
 *     the obvious refusals. The registry is server-side and is the only
 *     thing that knows whose a pid is; a local shortcut would be the second
 *     implementation of one safety rule that §4 explicitly rejects.
 *
 * ── When the guard is installed and cannot be reached ──────────────────
 *
 * Deny — but only for a command the local parse already identified as a
 * kill. This is the fail-closed rule applied at the narrowest scope that
 * still honours it: a server outage refuses kills, and leaves every other
 * command to be classified exactly as it would have been. The alternative,
 * denying everything while the server is down, is a rule this hook already
 * declines to make elsewhere and would turn one outage into a full stop.
 */
async function consultKillGuard(
  event: HookEvent,
  askKillGuard: AskKillGuard | undefined,
): Promise<HookVerdict | null> {
  if (askKillGuard === undefined) return null;
  if (event.command === undefined) return null;

  const local = parseKillCommand(event.command);
  if (local.kind === "not-a-kill") return null;

  let answer: KillGuardVerdict | undefined;
  try {
    answer = await askKillGuard(event);
  } catch {
    answer = undefined;
  }

  if (answer === undefined) {
    return {
      decision: "deny",
      reason:
        "this command would end one or more processes, and the ownership check could not be " +
        "reached to confirm they are this session's own. The hook denies when it cannot get an answer.",
      source: "kill-guard-unreachable",
    };
  }

  // The server read the command as ending nothing. It is the authority on
  // that too — its parser is the same one — so classification continues
  // rather than this returning an allow that would skip the pattern lists.
  if (answer.basis === "not-a-kill") return null;

  if (answer.decision === "deny") {
    return {
      decision: "deny",
      reason: answer.reason ?? "this command would end a process this session's crew does not own",
      source: "kill-guard",
    };
  }

  // Owned. That settles the *ownership* question and nothing else, so the
  // command still goes to the pattern lists: a kill being yours does not
  // make it allow-listed, and short-circuiting here would let the registry
  // be used to bypass every other rule by registering a process first.
  return null;
}

/**
 * Decides one event **and** works out what to tell the session about it.
 *
 * This is the entry point the hook script uses; `decide` remains exported
 * and unchanged for callers that want only a verdict.
 *
 * ── The one invariant worth stating outright ───────────────────────────
 *
 * `verdict` here is the *same value* `decide` returned, passed through
 * untouched. Nudges are computed from a separate input and appended beside
 * it. There is no branch in which a nudge is consulted before a verdict is
 * chosen, and no branch in which the presence of a nudge alters one — so a
 * denied call stays denied with its own reason, and an allowed call stays
 * allowed no matter how much advice rides along with it.
 *
 * **Nudges are still computed for a denied call.** They are not suppressed,
 * because the reason a call was denied is frequently the reason the advice
 * matters — a session in the wind-down band that just had a command refused
 * still needs to hear that it should be pausing rather than retrying. The
 * deny is rendered as the refusal; the nudge rides alongside as advice.
 */
export async function decideWithNudges(options: DecideOptions): Promise<DecidedEvent> {
  let volunteered: NudgeContext | undefined;
  const askServer: AskServer = async (asked) => {
    const answer = await options.askServer(asked);
    if (answer?.nudge !== undefined) volunteered = answer.nudge;
    return answer;
  };

  const verdict = await decide({ ...options, askServer });

  // Anything the server volunteered on this round trip wins over what was
  // known locally, because it is strictly newer — but only field by field,
  // so a response that mentions only the budget band does not erase a
  // locally-known escalation.
  const merged: NudgeContext = { ...options.nudge, ...volunteered };

  const nudges = evaluateNudges({
    ...merged,
    // The event knows which tool ran; the context does not, and nothing
    // upstream should have to restate it.
    //
    // A `writeShaped` already on the context still wins — but note where
    // one can come from: `readNudgeContext` does not parse the field, so
    // this override is reachable only from context supplied locally by the
    // caller, never from a server response. That is deliberate for now:
    // write-shapedness is a fact about the tool the hook just observed, and
    // the hook is better placed to know it than a server being told about
    // it second-hand.
    writeShaped: merged.writeShaped ?? isWriteShaped(options.event.tool),
  });

  return { verdict, nudges };
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
