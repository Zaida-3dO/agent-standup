// The hook, end to end — MILESTONES.md #125.
//
// One installed script wired to `PreToolUse`, `PostToolUse` and `Stop`,
// branching on the event type from stdin. This module is that script's body,
// with every effect it needs supplied as a parameter — stdin as a string,
// the server as one async call, the clock as a number.
// `../../bin/standup-hook.ts` is the only place those become real.
//
// The split matters more here than for an ordinary command. The behaviour
// worth testing in a hook is what it does when things go wrong — an
// unreachable server, a payload from a tool version nobody has seen — and
// every one of those is trivial to construct as an argument and painful to
// construct as a socket.
//
// **This module holds no rules**, and that is the design rather than an
// accident of it: see `./decide.ts` for why the script is kept thin enough
// that its protocol version should rarely need bumping again.

import { parseHookPayload } from "./payload";
import { decideWithNudges, type AskServer, type HookVerdict } from "./decide";
import {
  renderResponse,
  renderWithNudges,
  renderWithStopCatch,
  type RenderedResponse,
} from "./response";
import type { SessionEnforcement } from "./enforcement";
import { evaluateStopCatch, type StopContext } from "./stop-catch";
import type { NudgeContext } from "./nudge";

export interface RunHookOptions {
  /** Everything the agent tool wrote to the hook's stdin. */
  readonly stdin: string;
  /** Asks the server. See `AskServer` — `undefined` means "no answer", for any reason. */
  readonly askServer: AskServer;
  /** Epoch milliseconds. Injected so nothing here reads a clock. */
  readonly now?: number;
  /** Enforcement known locally, before any server call. */
  readonly enforcement?: SessionEnforcement;
  /**
   * What is known about this session's crew when it tries to stop
   * (MILESTONES.md #47). Advisory: nothing here can refuse the stop.
   */
  readonly stop?: StopContext;
  /**
   * Nudge context known locally, before any server call (MILESTONES.md #46).
   * Advisory throughout: nothing supplied here can change a verdict.
   */
  readonly nudge?: NudgeContext;
}

/**
 * Runs the hook once and returns what the process should emit.
 *
 * **An unreadable payload allows** (DECISIONS.md §16), and it is worth
 * being explicit about why, because "we could not read the question" is the
 * case where refusing feels most defensible. A payload shape this build has
 * never seen is a *client* failure, and the cost of denying on it is every
 * tool call in the session refused the moment the agent tool changes its
 * payload — for a hook that enforces nothing locally and would have allowed
 * all of them. The reason still names the parse failure, on the channel a
 * person reads.
 */
export async function runHook(options: RunHookOptions): Promise<RenderedResponse> {
  const parsed = parseHookPayload(options.stdin);
  if (!parsed.ok) {
    const verdict: HookVerdict = {
      decision: "allow",
      reason: `the hook could not read this event (${parsed.reason})`,
      source: "unreadable-payload",
    };
    // Rendered through the ordinary path so an unreadable payload produces
    // exactly what any other allow does — an empty stdout and exit zero —
    // rather than a special shape a reader would have to know about.
    return renderResponse(verdict, "Unknown");
  }

  const event = parsed.event;

  let volunteeredStop: StopContext | undefined;
  const askServer: AskServer = async (asked) => {
    const answer = await options.askServer(asked);
    // Advisory. Whatever the server volunteers on a round trip this event
    // was making anyway is free; it never triggers a request of its own.
    if (answer?.stop !== undefined) volunteeredStop = answer.stop;
    return answer;
  };

  const { verdict, nudges } = await decideWithNudges({
    event,
    askServer,
    ...(options.enforcement === undefined ? {} : { enforcement: options.enforcement }),
    ...(options.nudge === undefined ? {} : { nudge: options.nudge }),
  });

  // The stop-hook catch (MILESTONES.md #47). Evaluated after the verdict and
  // composed beside it — never inside it — so that no branch here can turn
  // the catch into a refusal of the stop. Field-by-field merge, so a server
  // that reports only the crew count does not erase a locally-known wait.
  const stopCatch = evaluateStopCatch(event, mergeStopContext(options.stop, volunteeredStop));

  // Two advisory decorators over one verdict (MILESTONES.md #46 and #47).
  //
  // **Order is the only real decision here, and it is about reading, not
  // correctness.** The two cannot fight: both append to stderr, both leave
  // stdout untouched, and both carry the exit code through from what they
  // wrap — so neither can block, and neither can undo the other. What the
  // order settles is which line the agent reads last, and on a `Stop` the
  // catch is the most actionable thing the hook has to say.
  return renderWithStopCatch(renderWithNudges(verdict, event.eventType, nudges), stopCatch);
}

/**
 * Combines what was known locally with whatever the server volunteered.
 *
 * **The server wins field by field**, because it is strictly newer: it
 * answered on the round trip this event was already making, whereas the
 * local value was read before the call went out. Field by field rather than
 * wholesale so a response mentioning only the crew count does not erase a
 * locally-known backgrounded wait.
 *
 * Exported for the test that pins that precedence. Asserting it through a
 * hand-rolled spread in the test would prove only that object spread works;
 * the property worth protecting is which side *this* function prefers.
 */
export function mergeStopContext(
  local: StopContext | undefined,
  volunteered: StopContext | undefined,
): StopContext | undefined {
  if (local === undefined) return volunteered;
  if (volunteered === undefined) return local;
  return { ...local, ...volunteered };
}
