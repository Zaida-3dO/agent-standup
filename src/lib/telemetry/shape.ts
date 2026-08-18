// Session shape — MILESTONES.md #54 ("Repeat-command detection, how wide the
// file spread is, read-to-write ratio"), over the `tool_calls` rows #50
// ingests (SCHEMA.md §10).
//
// ── These are signals about shape, not about cost ──────────────────────
//
// The rest of M7 measures what a session *spent*: runs (#51), a price table
// (#52), aggregation per item and per stage (#53). This row measures what a
// session is *doing* — whether it is going in circles, how far it has
// spread, and whether it is mostly looking or mostly changing. A session can
// be cheap and stuck, or expensive and going fine, and no token count
// separates those two. That is why this is a separate row from the cost
// chain and why nothing here reads a token count or a price.
//
// ── Judgements, not raw numbers, and the reason is the consumer ────────
//
// Two rows wait on this and both want to *act*, not to display. #64's crew
// digest tells an orchestrator how its crew are getting on; #65 nudges a
// session to background a command. Neither can do anything with "spread =
// 23" — acting on a number means knowing what is normal for it, and if this
// module returns the number then every consumer re-derives that judgement,
// separately and differently, from thresholds nobody agreed. So each signal
// here returns a **verdict with the number attached**: the judgement is made
// once, in the place that can explain itself, and the number travels with it
// for a caller that wants to show its working.
//
// The thresholds are settings (`shape.*`, SCHEMA.md §17) rather than
// constants for the same reason: what counts as "wide" depends on the
// repository, and a constant would make every installation argue with a
// number it cannot reach.
//
// ── Everything here is pure ────────────────────────────────────────────
//
// Rows in, verdicts out — no database handle, no clock, no I/O. This is the
// same contract `../interventions/types.ts` puts on a predicate, and for the
// same reason: #65 is an intervention, and an intervention's predicate is
// handed its context and cannot go and get anything. A signal that reached
// for a query here could never be called from one.

import { TRUNCATION_MARKER } from "./contract";

/**
 * One tool call, as far as a shape signal is concerned.
 *
 * A deliberately narrow projection of the `ToolCall` row: the tool, the
 * command, and what it touched. No tokens, no usage, no item state — a
 * shape signal that read a token count would be measuring cost, which is
 * the cost chain's row (#51–#53) and not this one.
 *
 * `ts` is here because ordering matters to repeat detection and nothing
 * else, and it is the caller's ordering that decides what "consecutive"
 * means — see `countRepeats`.
 */
export interface ShapeCall {
  readonly tool: string;
  readonly command?: string | null;
  readonly paths?: readonly string[] | null;
  readonly ts?: Date | string | null;
}

/**
 * How a signal came out: the judgement, and the number behind it.
 *
 * `level` is the part a consumer acts on and `value` is the part it shows.
 * Both, rather than either alone, because the two failure modes are
 * opposite: a bare number cannot be acted on without re-deriving a
 * threshold, and a bare judgement cannot be explained to whoever is being
 * nudged by it. A nudge that says "you are going in circles" and cannot say
 * how many times is one an agent has no way to check.
 */
export interface ShapeSignal {
  readonly level: ShapeLevel;
  /** The measured number the level was derived from. */
  readonly value: number;
  /** How many calls the measurement was taken over, so a caller can weigh it. */
  readonly sampleSize: number;
}

/**
 * The three answers a shape signal gives.
 *
 * `unknown` is not a failure and not a zero — it is "too little evidence to
 * say", and it is a distinct value because the alternative is worse in both
 * directions. Reporting `normal` on a two-call sample tells a consumer that
 * a session is fine when nothing has been established; reporting `elevated`
 * makes every session trip on its first few calls. A consumer that treats
 * `unknown` as `normal` has made that choice explicitly, which is the point.
 */
export const SHAPE_LEVELS = ["unknown", "normal", "elevated"] as const;
export type ShapeLevel = (typeof SHAPE_LEVELS)[number];

/**
 * The thresholds a shape reading is taken against.
 *
 * Handed in rather than read from the settings resolver, because this module
 * is pure by contract (see the header) and because it makes every threshold
 * visible at the call site of a test. `../service/` resolves the `shape.*`
 * settings and passes them; nothing here knows a setting exists.
 */
export interface ShapeThresholds {
  /** Fewer calls than this and every signal answers `unknown`. */
  readonly minimumSample: number;
  /** Distinct repeats of one command at or above this reads as circling. */
  readonly repeatThreshold: number;
  /** Distinct paths at or above this reads as a wide spread. */
  readonly spreadThreshold: number;
  /**
   * A read share at or above this reads as mostly-looking.
   *
   * A fraction rather than a count, because the question is about the
   * balance of a session's work and a count would answer a different
   * question on a long session than on a short one.
   */
  readonly readShareThreshold: number;
}

/**
 * Tool names that only ever look at something.
 *
 * A closed list, and an unknown tool counts as **neither** a read nor a
 * write — see `readShare` for why the ratio is taken over the calls
 * it can classify rather than over all of them.
 *
 * `Bash` is deliberately absent from both lists, and that is the decision
 * worth knowing about in this module. `../hook/nudge.ts` classifies `Bash`
 * as write-shaped, which is right for the question it asks — *should this
 * session be told to commit* — because a shell call is the one that might
 * have changed something and the cost of missing it is a lost hour of work.
 * It is wrong for this question: most shell calls in a real session are
 * `ls`, `grep`, `cat` and `git status`, so counting every one as a write
 * would report almost every session as mostly-changing and the ratio would
 * separate nothing. Reusing that helper would have been the obvious
 * economy and it would have quietly destroyed the signal.
 *
 * Classifying a shell call properly means parsing the command, which is a
 * different and much larger problem — `../interventions/commands.ts` does
 * it for the narrow shapes a guard must recognise, and its precision there
 * comes from only having to answer about a handful of them. Until this
 * signal has a reason to pay that cost, an unclassifiable call is counted
 * as unclassifiable, which is honest and leaves the door open.
 */
const READ_TOOLS: ReadonlySet<string> = new Set([
  "Read",
  "Glob",
  "Grep",
  "WebFetch",
  "WebSearch",
  "NotebookRead",
]);

/** Tool names that change something. See `READ_TOOLS` for why `Bash` is in neither. */
const WRITE_TOOLS: ReadonlySet<string> = new Set(["Write", "Edit", "NotebookEdit", "MultiEdit"]);

/** Whether a tool only looks. */
export function isReadTool(tool: string): boolean {
  return READ_TOOLS.has(tool);
}

/** Whether a tool changes something. */
export function isWriteTool(tool: string): boolean {
  return WRITE_TOOLS.has(tool);
}

/**
 * How many times a command was re-run after other work happened in between.
 *
 * **This is the measurement the row asks to get right**, and the reason it
 * is not a count of duplicates is stated in #54 itself: "a repeat-command
 * count that fires on a legitimate retry loop is noise". Those are two
 * different situations that a naive count cannot tell apart:
 *
 *   - A **retry loop** is the same command run and immediately re-run
 *     because it is failing — `npm test`, fix, `npm test`, fix. That is a
 *     session working, and it is the single most normal thing an agent
 *     does. Counting each attempt would make a productive session look
 *     worse the harder it worked.
 *   - **Circling** is the same command coming back *after the session went
 *     and did something else* — read some files, edited one, and here is
 *     that same command again. That is the shape of a session that has lost
 *     the thread, and it is what a consumer wants to hear about.
 *
 * So a consecutive run of the same command counts **once**, however long it
 * is, and only a return to a command counts again. A session that runs
 * `npm test` forty times in a row scores 0; one that runs it, wanders, and
 * runs it again scores 1.
 *
 * Commands are compared by exact text. A truncated command
 * (`TRUNCATION_MARKER`, `./contract.ts`) is excluded rather than compared
 * on its prefix — two different long commands sharing a prefix are stored
 * byte-identically, so comparing them would report a repeat that did not
 * happen, and a wrong repeat is worse than a missed one for a signal whose
 * whole purpose is to say a session is stuck.
 *
 * Calls are read in the order given. The caller orders by `ts`; this
 * function does not sort, because a caller that has already ordered by an
 * index should not pay for a second sort and a caller that has not needs to
 * know that ordering is its job.
 */
export function countRepeats(calls: readonly ShapeCall[]): number {
  let repeats = 0;
  // What has been seen at all, versus what was seen on the call immediately
  // before. The pair is what separates circling from a retry loop: a command
  // in `seen` that is not `previous` has been returned to.
  const seen = new Set<string>();
  let previous: string | undefined;

  for (const call of calls) {
    const command = comparableCommand(call);
    if (command === undefined) {
      // A call carrying no comparable command breaks the consecutive run:
      // whatever comes next followed something else, which is exactly the
      // "went and did something in between" this counts.
      previous = undefined;
      continue;
    }

    if (command === previous) continue;
    if (seen.has(command)) repeats += 1;

    seen.add(command);
    previous = command;
  }

  return repeats;
}

/**
 * The command text to compare on, or `undefined` when this call has none
 * worth comparing.
 *
 * Truncated text is refused here rather than at the call site so that every
 * consumer of a command comparison in this module refuses it the same way.
 */
function comparableCommand(call: ShapeCall): string | undefined {
  const command = call.command;
  if (command === undefined || command === null) return undefined;
  const trimmed = command.trim();
  if (trimmed === "") return undefined;
  if (trimmed.endsWith(TRUNCATION_MARKER)) return undefined;
  return trimmed;
}

/**
 * How many distinct paths a set of calls touched.
 *
 * Distinct, not total: a session that reads one file thirty times has not
 * spread over thirty files, and the question is breadth. Paths are compared
 * as the strings they arrived as — normalising separators or resolving
 * relative paths would be inventing knowledge about a filesystem this
 * process cannot see, and would make two genuinely different paths collide.
 */
export function countSpread(calls: readonly ShapeCall[]): number {
  const paths = new Set<string>();
  for (const call of calls) {
    for (const path of call.paths ?? []) {
      const trimmed = path.trim();
      if (trimmed !== "") paths.add(trimmed);
    }
  }
  return paths.size;
}

/**
 * The share of classifiable calls that only looked, between 0 and 1.
 *
 * **Taken over the calls that could be classified, not over all of them.**
 * A session's shell calls are unclassifiable here (see `READ_TOOLS`), and
 * they are a large fraction of a real session — so dividing by every call
 * would drag every ratio towards zero in proportion to how much shell a
 * session used, which is a measurement of shell usage wearing a
 * read-to-write label. Dividing by the classifiable calls answers the
 * question actually asked, over the evidence that can answer it, and
 * `sampleSize` on the signal carries how much evidence that was.
 *
 * Returns `undefined` when nothing was classifiable, which is a different
 * statement from a ratio of zero: zero means this session only wrote, and
 * `undefined` means this function cannot tell. Collapsing the two would
 * report a session that ran nothing but shell commands as one that only
 * ever changed things.
 */
export function readShare(calls: readonly ShapeCall[]): number | undefined {
  let reads = 0;
  let writes = 0;
  for (const call of calls) {
    if (isReadTool(call.tool)) reads += 1;
    else if (isWriteTool(call.tool)) writes += 1;
  }
  const classifiable = reads + writes;
  if (classifiable === 0) return undefined;
  return reads / classifiable;
}

/**
 * Every shape signal for one session's calls.
 *
 * One function rather than three called separately, because a consumer
 * wants the session's shape and reading it in three calls invites two of
 * them being taken over different windows — a spread from one window and a
 * repeat count from another describe no session that ever existed.
 */
export interface SessionShape {
  /** A command returned to after other work — see `countRepeats`. */
  readonly repeats: ShapeSignal;
  /** Distinct paths touched. */
  readonly spread: ShapeSignal;
  /**
   * How much of the classifiable work was reading, as a percentage.
   *
   * A percentage rather than the raw fraction so that `value` is a number a
   * consumer can show without formatting it, and so `elevated` reads the
   * same way here as in the other two signals: further from normal, in the
   * direction worth mentioning. `unknown` when nothing was classifiable.
   */
  readonly readShare: ShapeSignal;
  /** How many calls the whole reading was taken over. */
  readonly calls: number;
}

/**
 * Reads the shape of one session's calls.
 *
 * Below `minimumSample` every signal answers `unknown` rather than being
 * computed on too little evidence. That gate is applied to the *whole
 * reading* rather than per signal, because the signals describe one session
 * and a reading where one signal is a judgement and another is a shrug is
 * one a consumer cannot present coherently.
 */
export function readSessionShape(
  calls: readonly ShapeCall[],
  thresholds: ShapeThresholds,
): SessionShape {
  const total = calls.length;
  const enough = total >= thresholds.minimumSample;

  const repeats = countRepeats(calls);
  const spread = countSpread(calls);
  const share = readShare(calls);

  return {
    calls: total,
    repeats: {
      level: !enough ? "unknown" : repeats >= thresholds.repeatThreshold ? "elevated" : "normal",
      value: repeats,
      sampleSize: total,
    },
    spread: {
      level: !enough ? "unknown" : spread >= thresholds.spreadThreshold ? "elevated" : "normal",
      value: spread,
      sampleSize: total,
    },
    readShare: {
      // `unknown` for an unclassifiable session even when the sample is
      // large: a thousand shell calls is plenty of evidence about the
      // session and none at all about this question.
      level:
        !enough || share === undefined
          ? "unknown"
          : share >= thresholds.readShareThreshold
            ? "elevated"
            : "normal",
      value: share === undefined ? 0 : Math.round(share * 100),
      sampleSize: countClassifiable(calls),
    },
  };
}

/** How many calls the read-share was taken over. See `readShare`. */
function countClassifiable(calls: readonly ShapeCall[]): number {
  let count = 0;
  for (const call of calls) {
    if (isReadTool(call.tool) || isWriteTool(call.tool)) count += 1;
  }
  return count;
}
