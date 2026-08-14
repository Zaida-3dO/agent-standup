// The hook, end to end — MILESTONES.md #42's "one file, fires after each
// tool call and at stop, cached rules".
//
// "One file" is the *installed* artefact: one script wired to both events,
// branching on the event type from stdin (DECISIONS.md §4). This module is
// that script's body, with every effect it needs supplied as a parameter —
// stdin as a string, the cache as read/write functions, the server as one
// async call, the clock as a number. `../../bin/standup-hook.ts` is the only
// place those become real, and it is eleven lines.
//
// The split matters more here than for an ordinary command. The behaviour
// worth testing in a guard is what it does when things go wrong — an
// unreadable cache, an unreachable server, a payload from a tool version
// nobody has seen — and every one of those is trivial to construct as an
// argument and painful to construct as a filesystem and a socket.

import { parseHookPayload } from "./payload";
import { readCache, serialiseCache, type CacheState, type HookRules } from "./rules-cache";
import { decideWithNudges, type AskKillGuard, type AskServer, type HookVerdict } from "./decide";
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
  /** The cache file's contents, or `undefined` when there is no file. */
  readonly cacheText?: string;
  /** Persists a freshly fetched rule set. Failures are swallowed by the caller. */
  readonly writeCache?: (text: string) => void;
  /** Asks the server. See `AskServer` — `undefined` means "no answer", for any reason. */
  readonly askServer: AskServer;
  /** Epoch milliseconds. Injected so cache freshness is decided without a clock. */
  readonly now: number;
  readonly ttlMs?: number;
  /** Enforcement known locally, before any server call. */
  readonly enforcement?: SessionEnforcement;
  /**
   * Asks the ownership check (MILESTONES.md #45). Absent means the guard is
   * not installed — see `decide` for why that is not the same as
   * unreachable.
   */
  readonly askKillGuard?: AskKillGuard;
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
 * **An unreadable payload denies.** This is the case most likely to be
 * reached by accident — a tool version whose payload shape this build has
 * never seen — and it is also the one where allowing is most tempting,
 * because the failure is obviously "ours" rather than the command's. It
 * still denies: the hook was asked whether a command it could not read
 * should run, and the honest answer to that is no. The reason names the
 * parse failure, so the fix is a five-second read rather than a mystery.
 *
 * The event name rendered for that case is `"Unknown"` — there is no
 * payload to take one from, and inventing `PostToolUse` would produce a
 * response claiming to describe an event that may never have occurred.
 */
export async function runHook(options: RunHookOptions): Promise<RenderedResponse> {
  const parsed = parseHookPayload(options.stdin);
  if (!parsed.ok) {
    const verdict: HookVerdict = {
      decision: "deny",
      reason: `the hook could not read this event (${parsed.reason}), and denies when it cannot tell what is being run`,
      source: "no-rules",
    };
    return renderResponse(verdict, "Unknown");
  }

  const event = parsed.event;
  const cache: CacheState = readCache({
    text: options.cacheText,
    now: options.now,
    ...(options.ttlMs === undefined ? {} : { ttlMs: options.ttlMs }),
  });

  // A stale or unavailable cache is refreshed opportunistically from
  // whatever the server volunteers on the call this event already makes —
  // never by a second, dedicated round trip. §4's cost argument is that the
  // common path is free; buying freshness with an extra request on every
  // stale call would spend exactly what the cache was built to save.
  let refreshed: HookRules | undefined;
  let volunteeredStop: StopContext | undefined;
  const askServer: AskServer = async (asked) => {
    const answer = await options.askServer(asked);
    if (answer?.rules !== undefined) refreshed = answer.rules;
    // Advisory, and read alongside the rules for the same reason: whatever
    // the server volunteers on a round trip this event was making anyway is
    // free. It never triggers a request of its own — a `Stop` carries no
    // command, so it makes no server call at all, and the catch has to work
    // from what the caller already knows.
    if (answer?.stop !== undefined) volunteeredStop = answer.stop;
    return answer;
  };

  const { verdict, nudges } = await decideWithNudges({
    event,
    cache,
    askServer,
    ...(options.enforcement === undefined ? {} : { enforcement: options.enforcement }),
    ...(options.askKillGuard === undefined ? {} : { askKillGuard: options.askKillGuard }),
    ...(options.nudge === undefined ? {} : { nudge: options.nudge }),
  });

  if (refreshed !== undefined && options.writeCache !== undefined) {
    try {
      options.writeCache(serialiseCache(refreshed, options.now));
    } catch {
      // A cache that cannot be written is a slower hook, not a wrong one:
      // the next call simply asks again. Failing the tool call over it would
      // turn a full disk into an outage of every agent on the machine.
    }
  }

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
  // catch is the most actionable thing the hook has to say. So nudges are
  // rendered first and the catch wraps them, landing at the end.
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
