// What the hook does with one event — MILESTONES.md #125, DECISIONS.md §4
// and §16.
//
// **The hook pings the server and does what it is told.** That sentence is
// the whole of this module's design, and everything below follows from it:
// there is no local classification, no cached rule set, no matcher, and no
// judgement of any kind. The event goes out, an answer comes back, and the
// answer is rendered. Anything that decides something — whether a call is
// blocked, what a session is told, how often it is told it, whether a
// finding rides a digest — is server-side, where the item state, claim
// state, review artifacts and budget that every real rule is conditional on
// actually live.
//
// **The point of keeping it this thin is the protocol version.** A hook
// script is installed on a machine and then forgotten; every behaviour put
// in it is a reason to one day need every installation to update. So the
// script carries nothing that could become such a reason. Adding a rule
// here — even a small one, even a safe one — spends that property.
//
// ── Fail OPEN — a deliberate reversal, see DECISIONS.md §16 ────────────
//
// An unreachable server, an unparseable payload, an unrecognised decision
// and an unexpected throw all **allow**. Every one of those used to deny.
//
// The reason the posture flipped is that the thing it was protecting no
// longer exists. Fail-closed is the right trade when the hook enforces
// rules: denying on no answer refuses a handful of guarded commands during
// an outage, which beats permitting them unwatched. With the pattern lists
// deleted (#125) the hook enforces nothing at all, so the trade has one
// side left — a server hiccup would kill *every tool call in every session*
// to protect rules that would have allowed all of them, including the Edit
// that would unwire the hook.
//
// **This must be revisited when real blocking arrives** (Interventions,
// #128). At that point a `pre` decision genuinely gates something again and
// the argument above stops holding for it. `post` never needs revisiting:
// the call has already run.
//
// ── The two phases are not symmetrical ─────────────────────────────────
//
//   - **`PreToolUse`** holds the tool call until the server answers. Server
//     says block → deny. Anything else → allow, surfacing whatever nudge
//     came back.
//   - **`PostToolUse`** reports what ran and what it produced, and may
//     carry back a nudge. **It can never block** — the call already
//     happened, so a refusal there refuses something that already took
//     effect. That is enforced here in code, not left to the server to
//     remember: `decide` cannot return a deny for a `post` event.
//   - **`Stop`** is advisory throughout (DECISIONS.md §6) and is treated as
//     `post` is: reported, never refused.

import type { HookEvent } from "./payload";
import { enforcementRefusal, type SessionEnforcement } from "./enforcement";
import type { StopContext } from "./stop-catch";
import { evaluateNudges, isWriteShaped, type Nudge, type NudgeContext } from "./nudge";
import { overrideApplies, overrideRemedy } from "./override";
import { isBlockingLevel, type InterventionFinding } from "../interventions/types";

/**
 * What the hook concluded, and why.
 *
 * Two outcomes. There is no `ask`: by the time this function returns, the
 * deciding is done, and a hook that answered `ask` to the agent tool would
 * be answering a question with a question.
 */
export interface HookVerdict {
  readonly decision: "allow" | "deny";
  /** A sentence naming the cause. Rendered for a denied call; unused for an allow. */
  readonly reason: string;
  /**
   * Where the verdict came from. Kept because "allowed because the server
   * said so" and "allowed because the server could not be reached" are
   * operationally different situations that look identical without it — the
   * second is an outage, and an outage that leaves no trace is one nobody
   * finds.
   */
  readonly source:
    | "enforcement"
    /** The server answered. */
    | "server"
    /** No answer — unreachable, non-success, unreadable body. Allows (§16). */
    | "server-unreachable"
    /** The payload could not be read at all. Allows (§16). */
    | "unreadable-payload"
    /** A `post` or `Stop` event: reported, never refused. */
    | "post-cannot-block"
    /**
     * The caller overrode a `block-overridable` finding with a written
     * reason — MILESTONES.md #128's middle tier. Distinct from `"server"`
     * on purpose: "allowed because nothing objected" and "allowed because
     * someone overrode an objection" are different facts, and collapsing
     * them would make overriding invisible to anything reading the source.
     */
    | "override";
}

/** The server's answer, as this build understands it. */
export interface ServerVerdict {
  /**
   * `block` is the only value that refuses anything, and only on a `pre`
   * event. **Anything else allows**, including a value this build has never
   * seen — see §16. The field is deliberately named for what it does rather
   * than mirroring an enum, so a server adding a fourth decision cannot
   * accidentally flip an allow into a deny in a script that predates it.
   */
  readonly decision?: "block" | "allow";
  readonly reason?: string;
  /** Session enforcement the server volunteered. */
  readonly enforcement?: SessionEnforcement;
  /**
   * What the server knows about this session's crew, for the stop-hook
   * catch (MILESTONES.md #47). Advisory only — `decide` never reads it.
   */
  readonly stop?: StopContext;
  /**
   * Nudge context the server volunteered. Advisory only: nothing here can
   * change `decision`, and `decide` never reads it while choosing one.
   */
  readonly nudge?: NudgeContext;
  /**
   * The findings behind the decision — `hook_decision`'s own `findings`
   * field, carried through unread.
   *
   * This is intervention-evidence plumbing (MILESTONES.md #128's capture
   * loop, `src/lib/interventions/capture.ts`), not part of the decision
   * itself: `decide` never inspects it, the same way it never inspects
   * `stop` or `nudge`. It exists on `ServerVerdict` so a caller that wants
   * to record what fired — `../../bin/standup-hook.ts`, via
   * `RunHookOptions.onFindings` — has the same round trip's answer to
   * build a capture from, rather than needing a second request for data
   * the server already computed.
   */
  readonly findings?: readonly InterventionFinding[];
}

export type AskServer = (event: HookEvent) => Promise<ServerVerdict | undefined>;

/**
 * A verdict and anything the session should be told alongside it.
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
  /**
   * The findings the server's answer carried, in registry order. Empty when
   * there was no answer, or the answer carried none — never `undefined`, so
   * a caller can iterate unconditionally the way `buildCaptures` already
   * does for its own `findings` parameter.
   */
  readonly findings: readonly InterventionFinding[];
}

export interface DecideOptions {
  readonly event: HookEvent;
  /**
   * Asks the server. Returns `undefined` for **any** failure — unreachable,
   * a non-success status, a body this build cannot read. Collapsing all of
   * those into one value is deliberate: they have exactly one consequence
   * here (allow), and a caller that had to enumerate them could forget one.
   */
  readonly askServer: AskServer;
  /** Enforcement known before the call, e.g. read from a local file. */
  readonly enforcement?: SessionEnforcement;
  /** Nudge context known before the call. Advisory — see `DecidedEvent`. */
  readonly nudge?: NudgeContext;
}

const ALLOW = (source: HookVerdict["source"], reason: string): HookVerdict => ({
  decision: "allow",
  reason,
  source,
});

/**
 * Whether an event's phase permits a refusal at all.
 *
 * Only `PreToolUse` does. This is the "post can never block" invariant, and
 * it is a function of the *event* rather than of anything the server says —
 * so no server response, however emphatic, can refuse a call that has
 * already run.
 */
export function canBlock(event: HookEvent): boolean {
  return event.eventType === "PreToolUse";
}

/**
 * Decides one hook event.
 *
 * Never throws. Every failure — including one thrown out of `askServer` —
 * is an allow with a reason naming it, because a hook process that dies
 * before printing produces no output, and a tool call refused by a crashed
 * guard is refused for no stated reason at all.
 */
export async function decide({
  event,
  askServer,
  enforcement,
}: DecideOptions): Promise<HookVerdict> {
  // Session enforcement is the one thing decided without asking, because it
  // is a fact about the session rather than about the call — a displaced
  // session should not be acting whatever it is running. It still only
  // refuses on `pre`: displacing a session cannot un-run the call it just
  // made.
  const localRefusal = enforcementRefusal(enforcement);
  if (localRefusal !== null && canBlock(event)) {
    return { decision: "deny", reason: localRefusal.reason, source: "enforcement" };
  }

  let answer: ServerVerdict | undefined;
  try {
    answer = await askServer(event);
  } catch {
    answer = undefined;
  }

  if (answer === undefined) {
    // §16. No answer allows — it does not deny, and there is no setting that
    // makes it deny. The reason is still emitted on the ordinary telemetry
    // path so an outage is visible rather than merely silent.
    return ALLOW(
      "server-unreachable",
      "the server could not be reached for a verdict; the hook allows when it has no answer",
    );
  }

  if (!canBlock(event)) {
    // A `post` or a `Stop`. Reported, never refused — including when the
    // server said `block`, which on this phase is a server asking for
    // something the phase cannot do.
    return ALLOW(
      "post-cannot-block",
      "this event fires after the call has run, so it reports rather than refuses",
    );
  }

  // The server may report enforcement on the same round trip. Checked here
  // as well as at the top because this is the first moment it can be known —
  // a session displaced a second ago has nothing about it on disk.
  const refusal = enforcementRefusal(answer.enforcement);
  if (refusal !== null) {
    return { decision: "deny", reason: refusal.reason, source: "enforcement" };
  }

  if (answer.decision === "block") {
    // ── The override channel ────────────────────────────────────────────
    //
    // MILESTONES.md #128's middle tier, and until this existed it was not
    // reachable: a `block-overridable` finding denied exactly as hard as a
    // `hard-block`, so the two levels differed in name only. See
    // `./override.ts` for why that mattered enough to fix — two built-ins
    // had already had their stated remedies deleted because the exit they
    // named did not exist.
    //
    // **Only the findings the server actually reported are consulted.** An
    // override names one entry, and it is honoured only if that entry is
    // among the blocking findings behind *this* refusal. So an override
    // written for one guard cannot excuse a different guard that fired on
    // the same call, and an override sent against a refusal carrying no
    // findings at all — an `enforcement` refusal, or a server that reported
    // none — changes nothing, because there is no entry for it to match.
    const blocking = (answer.findings ?? []).filter((finding) =>
      isBlockingLevel(finding.level),
    );
    const overridden = blocking.filter(
      (finding) => overrideApplies(event.override, finding.id, finding.level).applies,
    );

    // Every blocking finding must be covered, and there must have been at
    // least one. A call refused by two guards is not released by a reason
    // written about one of them — the other guard has said nothing about
    // whether proceeding is safe, and letting it through would be reading
    // "I considered X" as "I considered everything".
    if (blocking.length > 0 && overridden.length === blocking.length) {
      return ALLOW(
        "override",
        `overridden by the caller with a written reason: ${
          overrideApplies(event.override, blocking[0]!.id, blocking[0]!.level).reason ?? ""
        }`,
      );
    }

    // Still refused — but say so in a way the caller can act on. A refusal
    // that conceals an available exit is what teaches sessions to route
    // around guards rather than answer them.
    const remedies = blocking
      .map((finding) => overrideRemedy(finding.id, finding.level))
      .filter((remedy): remedy is string => remedy !== null);

    const base = answer.reason ?? "blocked by the server";
    return {
      decision: "deny",
      reason: remedies.length === 0 ? base : `${base} ${remedies.join(" ")}`,
      source: "server",
    };
  }

  // Everything else allows, including a decision string this build does not
  // recognise. §16: an unknown value is not an answer, and no answer allows.
  return ALLOW("server", answer.reason ?? "allowed by the server");
}

/**
 * Decides one event **and** works out what to tell the session about it.
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
 * still needs to hear that it should be pausing rather than retrying.
 */
export async function decideWithNudges(options: DecideOptions): Promise<DecidedEvent> {
  let volunteered: NudgeContext | undefined;
  // Same posture as `volunteered` above: read off whatever round trip
  // `decide` was already making, never triggering one of its own. Findings
  // ride every answer the server gives, not only a `nudge`-bearing one, so
  // this is set unconditionally rather than guarded on a defined check the
  // way `nudge` and `stop` are — an answer with an empty array is still an
  // answer, and `findings` below defaults it to one only when there was no
  // answer at all.
  let findings: readonly InterventionFinding[] | undefined;
  const askServer: AskServer = async (asked) => {
    const answer = await options.askServer(asked);
    if (answer?.nudge !== undefined) volunteered = answer.nudge;
    if (answer?.findings !== undefined) findings = answer.findings;
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
    // upstream should have to restate it. A `writeShaped` already on the
    // context still wins.
    writeShaped: merged.writeShaped ?? isWriteShaped(options.event.tool),
  });

  return { verdict, nudges, findings: findings ?? [] };
}
