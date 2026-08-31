// Nudges — MILESTONES.md #46 ("Nudges: delegate mode, staging, escalation,
// wind-down"), DECISIONS.md §6 and §7.
//
// ── A nudge is a third channel, not a third decision ────────────────────
//
// The hook already answers one question — may this run? — with `allow` or
// `deny` (`./decide.ts`). A nudge answers a different question that happens
// to arrive on the same event: *is there something this session should be
// told?* Those are independent, and the whole value of the mechanism depends
// on keeping them independent:
//
//   > "**Nudge, not block**: a refused stop can trap an agent in a loop, and
//   > the server's staleness ladder is already the backstop." (§6)
//
// So a nudge **never changes a verdict**. It cannot turn an allow into a
// deny, it cannot soften a deny into an allow, and there is deliberately no
// field on a nudge that could express either. A nudge that blocks is a bug,
// and it is the property most worth a test: the failure mode is silent —
// a nudge that quietly began denying would look, from the agent's side,
// exactly like a rule it had never been told about.
//
// This module is therefore pure and decision-free: facts in, advisory text
// out. It is the *whole* of the nudge judgement, and `./decide.ts` composes
// it alongside a verdict rather than inside one.
//
// ── Why the four kinds are a closed set ─────────────────────────────────
//
// DECISIONS.md §6/§7 name four things a session can be told on a tool call:
// delegate mode, staging, escalation, wind-down. They are an enum rather
// than free-form server text because the *event* row that records a nudge
// carries `{kind}` (SCHEMA.md §2, the `nudge` event payload) — a typo in a
// free-form kind would silently create a class of nudge that every later
// count misses, which is the same reasoning that made the event `type`
// column an enum.
//
// ── Fire on the edge, not on every turn ─────────────────────────────────
//
// §6 states the rule for the stop-hook catch — "silent if a wait is already
// backgrounded, or you'd nag every turn" — and it generalises to all four:
// a nudge repeated on every tool call is one an agent learns to ignore,
// which costs the mechanism its only power. Edge detection needs to know
// what was already said, and the hook process is per-call and holds no
// memory, so the *caller* supplies what has already been delivered
// (`alreadyNudged`) and this module filters against it. That keeps the
// evaluation pure while making the suppression testable, which a timestamp
// read off a clock inside here would not be.
//
// This mirrors #25's discipline (`src/lib/notifications.ts`, "fires on the
// edge only") without reusing its code: that evaluator answers a question
// about an item's field snapshot, this one answers a question about a
// session's situation. Sharing an implementation would mean one function
// with two unrelated input shapes.

/**
 * The kinds of nudge this build can emit. Closed set — see the module note
 * on why this is an enum rather than server-supplied text.
 *
 * `wind-down` is `budget` in DECISIONS.md §7's prose; the name here is the
 * band's name because that is what a reader of the nudge sees.
 *
 * `background` (MILESTONES.md #65, DECISIONS.md §6) is the one kind that
 * fires *before* its call rather than after — see `typicalDurationSeconds`.
 */
export const NUDGE_KINDS = [
  "delegate",
  "staging",
  "escalation",
  "wind-down",
  "background",
] as const;
export type NudgeKind = (typeof NUDGE_KINDS)[number];

export function isNudgeKind(value: unknown): value is NudgeKind {
  return typeof value === "string" && (NUDGE_KINDS as readonly string[]).includes(value);
}

/** One thing to tell the session. Note there is no field that could block. */
export interface Nudge {
  readonly kind: NudgeKind;
  /** The sentence the agent reads. Written to be actionable, not merely true. */
  readonly text: string;
}

/**
 * The budget bands, from DECISIONS.md §7 ("free · selective · **wind down** ·
 * stop"). Taken as an input rather than computed here: the evaluator that
 * turns `budget.windows` plus elapsed time into a band is not built yet, and
 * inventing half of it inside a nudge module would put the arithmetic in a
 * place nothing else could reach.
 */
export const BUDGET_BANDS = ["free", "selective", "wind-down", "stop"] as const;
export type BudgetBand = (typeof BUDGET_BANDS)[number];

/**
 * What the server (or a local file) knows about a session's situation, as
 * far as nudging is concerned. Every field is optional because every one of
 * them comes from a different source and any of them may be absent — an
 * absent field means "nothing known", which produces no nudge rather than a
 * default one.
 */
export interface NudgeContext {
  /**
   * `agents.subagent_delegation` (SCHEMA.md §17). Only `allowed` nudges;
   * `never` and `required` are *blocks* enforced elsewhere, and emitting
   * advisory text for them would tell a session to consider doing something
   * it will then be refused for.
   */
  readonly delegationMode?: "never" | "allowed" | "required";
  /** Whether this event's tool call is write-shaped — see `isWriteShaped`. */
  readonly writeShaped?: boolean;
  /** Whether this session is acting as an orchestrator with crew beneath it. */
  readonly isOrchestrator?: boolean;
  /** Uncommitted or unstaged work the server believes this session has left. */
  readonly unstagedFiles?: number;
  /** An escalation raised against this session's work, as prose from the server. */
  readonly escalation?: string;
  /** The budget band this session's spend falls in. */
  readonly budgetBand?: BudgetBand;
  /**
   * Kinds already delivered to this session that should not be repeated.
   * Edge suppression — see the module note.
   */
  readonly alreadyNudged?: readonly NudgeKind[];
  /**
   * How long this exact command has typically taken before, in seconds
   * (MILESTONES.md #65, DECISIONS.md §6 "the backgrounding nudge").
   *
   * The server learns this for free: "the gap between consecutive tool
   * calls *is* the duration of the call between them", so a command seen
   * before carries a duration without anything having to time it. A command
   * never seen before has none, and an absent value nudges nothing —
   * guessing a duration for an unknown command is the "retrospective
   * flagging" fallback §6 names, which belongs after the call, not here.
   */
  readonly typicalDurationSeconds?: number;
  /**
   * Whether this call is *already* going to run in the background.
   *
   * The single most important suppression in this kind. §6's rule for the
   * stop-hook catch — "silent if a wait is already backgrounded" — applies
   * with full force here: telling a session to background a call it has
   * already backgrounded is advice it has already taken, and it is the
   * exact shape of nag that trains an agent to stop reading nudges.
   */
  readonly alreadyBackgrounded?: boolean;
  /**
   * Whether this event fires *before* the tool call runs.
   *
   * The backgrounding nudge is the only kind whose value depends on this.
   * §6 is explicit that the server "can nudge **before** the call via the
   * ask-list" — because backgrounding is a choice about how to *make* a
   * call, and after the call has already blocked the session for eighteen
   * minutes the advice has no remaining value. So this nudge requires a
   * `PreToolUse`; a `PostToolUse` is too late to act on and would only be
   * noise.
   */
  readonly beforeCall?: boolean;
}

/**
 * Tool names whose calls change something. Used for the "nudge on the first
 * write-shaped action" rule (DECISIONS.md §7, ghost tasks): "nudging on a
 * read trains people to ignore nudges."
 *
 * A closed list rather than a guess, and an *unknown* tool is read as **not**
 * write-shaped. That direction is deliberate and is the opposite of the
 * hook's fail-closed posture for verdicts, because the consequences are
 * opposite: an unrecognised tool wrongly treated as write-shaped produces a
 * nudge nobody needed, on every call, from a tool this build does not know —
 * which is precisely the "nag every turn" failure that makes nudges
 * worthless. Missing one is cheap; crying wolf is not.
 */
const WRITE_SHAPED_TOOLS: ReadonlySet<string> = new Set(["Write", "Edit", "NotebookEdit", "Bash"]);

export function isWriteShaped(tool: string | undefined): boolean {
  return tool !== undefined && WRITE_SHAPED_TOOLS.has(tool);
}

const DELEGATE_TEXT =
  "You are orchestrating and this call changes something directly. Consider dispatching it to a " +
  "crew member instead — delegation is the configured preference here. This is advice, not a " +
  "refusal: the call has already run.";

const STAGING_TEXT = (count: number) =>
  `There ${count === 1 ? "is" : "are"} ${count} file${count === 1 ? "" : "s"} of uncommitted work ` +
  "in this session. Commit at a logical checkpoint so the work is not lost if the session ends " +
  "unexpectedly.";

/**
 * How long a command must typically take before backgrounding it is worth
 * suggesting, in seconds.
 *
 * Two minutes. The number is a judgement and the direction of error is the
 * part worth defending: a threshold set too low nudges on every `npm test`
 * that happens to take ninety seconds, and a nudge that fires on ordinary
 * work is one an agent learns to skip — which costs the mechanism its only
 * power (see the module note). Set too high, some genuinely slow calls go
 * un-nudged, which loses one piece of advice and nothing else. Cheap in one
 * direction, expensive in the other, so it sits well clear of routine.
 *
 * Exported because the boundary is the interesting case to test and a test
 * that restates the number would keep passing if the source changed.
 */
export const BACKGROUND_NUDGE_THRESHOLD_SECONDS = 120;

const WIND_DOWN_TEXT =
  "The budget window has reached its wind-down band. Start nothing new: bring in-flight work to a " +
  "good stopping point, take shortcuts to a clean pause, and write the handoff. Finishing is not " +
  "required — a clean pause is.";

/**
 * Renders a duration the way a person reads one. Whole minutes past a
 * minute, seconds below it — "~18 min" is the phrasing DECISIONS.md §6
 * itself uses, and a bare "1080 seconds" makes the reader do the division.
 */
function approximateDuration(seconds: number): string {
  if (seconds < 60) return `~${Math.round(seconds)}s`;
  return `~${Math.round(seconds / 60)} min`;
}

const BACKGROUND_TEXT = (seconds: number) =>
  `This command has taken ${approximateDuration(seconds)} on previous runs. Consider running it ` +
  "in the background and picking the result up later, rather than blocking this session while it " +
  "runs. Some calls genuinely cannot be backgrounded — this is advice, not a refusal.";

/**
 * Decides what to tell a session on one event.
 *
 * Returns every applicable nudge, in a fixed order, with anything already
 * delivered filtered out. An empty array is the overwhelmingly common
 * answer and is not an error.
 *
 * **This function cannot block anything.** It returns text; it has no access
 * to a verdict and no return shape that could carry one. That is structural
 * rather than a rule to remember — see the module header.
 */
export function evaluateNudges(context: NudgeContext): readonly Nudge[] {
  const already = new Set(context.alreadyNudged ?? []);
  const nudges: Nudge[] = [];

  // 1. Delegate mode. Only when an orchestrator does write-shaped work
  //    itself, and only under `allowed` — see `delegationMode` above.
  if (
    context.delegationMode === "allowed" &&
    context.isOrchestrator === true &&
    context.writeShaped === true
  ) {
    nudges.push({ kind: "delegate", text: DELEGATE_TEXT });
  }

  // 2. Staging. Write-shaped only, for the same reason as the delegate
  //    nudge: telling a session to commit in the middle of a run of reads is
  //    noise, because nothing has changed since the last time it was told.
  if (
    context.writeShaped === true &&
    context.unstagedFiles !== undefined &&
    context.unstagedFiles > 0
  ) {
    nudges.push({ kind: "staging", text: STAGING_TEXT(context.unstagedFiles) });
  }

  // 3. Escalation. Prose from the server — this build does not compose it,
  //    because what an escalation says is a judgement the server made and
  //    re-wording it here would strip the detail that makes it actionable.
  //    An empty string is "no escalation", not an escalation with no text.
  if (context.escalation !== undefined && context.escalation.length > 0) {
    nudges.push({ kind: "escalation", text: context.escalation });
  }

  // 4. Wind-down. §7: "Wind-down reaches in-flight agents through the
  //    per-tool-call nudge, which costs nothing extra." Only the wind-down
  //    band nudges — `stop` is an enforcement, not advice, and `free`/
  //    `selective` have nothing to say.
  if (context.budgetBand === "wind-down") {
    nudges.push({ kind: "wind-down", text: WIND_DOWN_TEXT });
  }

  // 5. Backgrounding. §6: long-running tools should be backgrounded rather
  //    than blocking a session, and the duration is learnable from data the
  //    server already has. Four conditions, and each one drops the nudge
  //    for a different reason:
  //
  //      - `beforeCall` — after the call the advice is unactionable.
  //      - a known duration — an unseen command has nothing to say.
  //      - over the threshold — under it, backgrounding is not worth it.
  //      - not already backgrounded — otherwise it is pure nag.
  //
  //    The comparison is strictly greater-than, so a command sitting
  //    exactly on the threshold does not nudge. Either direction is
  //    defensible at the boundary; what matters is that it is one fixed
  //    rule rather than an accident, because "typically 120s" is precisely
  //    the routine-length call the threshold exists to stay quiet about.
  if (
    context.beforeCall === true &&
    context.alreadyBackgrounded !== true &&
    context.typicalDurationSeconds !== undefined &&
    Number.isFinite(context.typicalDurationSeconds) &&
    context.typicalDurationSeconds > BACKGROUND_NUDGE_THRESHOLD_SECONDS
  ) {
    nudges.push({
      kind: "background",
      text: BACKGROUND_TEXT(context.typicalDurationSeconds),
    });
  }

  return nudges.filter((nudge) => !already.has(nudge.kind));
}

/**
 * Reads a `NudgeContext` off an arbitrary value — the `nudge` field of a
 * server response, or a parsed local file.
 *
 * Every field is validated individually and a malformed one is *dropped*
 * rather than failing the whole read. A response whose `unstagedFiles` came
 * back as a string should still deliver the escalation next to it: a nudge
 * lost is a message not shown, which is the failure this mechanism can
 * tolerate, and it is the only sensible direction for a channel that is
 * advisory by definition.
 */
export function readNudgeContext(value: unknown): NudgeContext | undefined {
  // An array is an object in JavaScript, so it is rejected explicitly. It
  // would otherwise fall through and read as an object with none of the
  // recognised keys — the same answer by accident rather than by rule,
  // which stops being true the moment a numeric key means something.
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;

  const delegationMode =
    record.delegationMode === "never" ||
    record.delegationMode === "allowed" ||
    record.delegationMode === "required"
      ? record.delegationMode
      : undefined;

  const budgetBand = (BUDGET_BANDS as readonly string[]).includes(record.budgetBand as string)
    ? (record.budgetBand as BudgetBand)
    : undefined;

  const unstagedFiles =
    typeof record.unstagedFiles === "number" && Number.isInteger(record.unstagedFiles)
      ? record.unstagedFiles
      : undefined;

  const escalation = typeof record.escalation === "string" ? record.escalation : undefined;

  const alreadyNudged = Array.isArray(record.alreadyNudged)
    ? record.alreadyNudged.filter(isNudgeKind)
    : undefined;

  // A duration must be a finite, non-negative number. `Number.isFinite`
  // rejects `NaN` and both infinities, which JSON cannot carry but a
  // hand-built object can — and a `NaN` here would compare false against
  // the threshold and silently never nudge, which is the failure mode that
  // looks like the feature simply not working.
  const typicalDurationSeconds =
    typeof record.typicalDurationSeconds === "number" &&
    Number.isFinite(record.typicalDurationSeconds) &&
    record.typicalDurationSeconds >= 0
      ? record.typicalDurationSeconds
      : undefined;

  const context: NudgeContext = {
    ...(delegationMode === undefined ? {} : { delegationMode }),
    ...(typeof record.isOrchestrator === "boolean"
      ? { isOrchestrator: record.isOrchestrator }
      : {}),
    ...(unstagedFiles === undefined ? {} : { unstagedFiles }),
    ...(escalation === undefined ? {} : { escalation }),
    ...(budgetBand === undefined ? {} : { budgetBand }),
    ...(alreadyNudged === undefined ? {} : { alreadyNudged }),
    ...(typicalDurationSeconds === undefined ? {} : { typicalDurationSeconds }),
    ...(typeof record.alreadyBackgrounded === "boolean"
      ? { alreadyBackgrounded: record.alreadyBackgrounded }
      : {}),
  };

  return Object.keys(context).length === 0 ? undefined : context;
}
