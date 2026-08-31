// Launch prompts, composed server-side — MILESTONES.md #60, DECISIONS.md §5
// ("Launch prompts are server-composed").
//
// ── Why the composition is here and not on the machine ──────────────────
//
// M8's end state is that "each machine runs nothing but a ~30-line poller on
// a scheduled task, and every decision it acts on was made server-side."
// A prompt template living on each machine would be a decision made on the
// machine — and worse, a decision made by whichever copy of the template
// that machine happened to have. §5 settles it:
//
//   > "The user's own design already returns 'an array of prompts,' so
//   > composition is server-side and rich templating is free — no template
//   > on disk to go stale, and it can be **shaped to the situation** (fresh
//   > start vs rework vs stalled pickup want different briefings)."
//
// So this module turns a planned dispatch into the text a launcher hands
// straight to the agent, with no interpretation of its own. The launcher
// stays dumb, which is the whole architecture.
//
// ── The line that decides what may go in a prompt ───────────────────────
//
// §5, and it is the single most important rule in this file:
//
//   > "Line held: **stable instructions in, live state fetched** —
//   > checkpoints, open loops and crew state stay behind `orientation`
//   > because they change between composition and use."
//
// A prompt is composed at poll time and read by an agent some seconds or
// minutes later, after a launch that may itself have been retried. Anything
// baked in is a **snapshot with no expiry stamp**: an agent told "your last
// checkpoint says X" believes it, with no way to notice X is stale and no
// prompt to re-read it. Whereas an agent told to *call* `orientation` gets
// whatever is true at the moment it asks.
//
// The practical test applied throughout this module: a fact belongs in the
// prompt only if it cannot change between composition and use. An item's id
// cannot. Its checkpoints, its open loops, who else is working nearby, and
// even its state all can — so they are pointed at, never quoted.
//
// This is why the composed prompt contains an instruction to orient rather
// than an orientation. It looks like an indirection; it is the difference
// between briefing an agent and misleading one.

import type { PlanCandidate } from "./plan";

/**
 * Why this dispatch is happening, which is what shapes the briefing.
 *
 * §5 names the three explicitly — "fresh start vs rework vs stalled pickup
 * want different briefings" — and they are an enum rather than free text so
 * that the reason can be recorded on the dispatch event and counted later.
 */
export const DISPATCH_REASONS = ["fresh", "rework", "stalled"] as const;
export type DispatchReason = (typeof DISPATCH_REASONS)[number];

/** What the server knows at composition time about one planned dispatch. */
export interface LaunchPromptInput {
  /** The item to work, straight from the plan. */
  readonly candidate: PlanCandidate;
  /** Which of the three situations this is. */
  readonly reason: DispatchReason;
  /**
   * The item's title, purely so the prompt reads as being about something.
   *
   * A title is the one piece of item content stable enough to quote: it is
   * an identifier people use, not working state, and an out-of-date title
   * misleads nobody about what to do next. Optional because a dispatch is
   * still valid without one.
   */
  readonly title?: string;
  /**
   * How many times this has been dispatched with no durable progress since.
   *
   * Included for `stalled` only, where it is the whole point of the
   * briefing — an agent picking up a third attempt should know it is a
   * third attempt, because "try the same thing again" is the wrong
   * instinct there. See `items.resume_attempts` in SCHEMA.md §1.
   */
  readonly resumeAttempts?: number;
}

/**
 * The instruction that stands in for every piece of live state.
 *
 * One sentence, and it names the tool rather than describing it, because
 * the agent has the tool and does not need it explained.
 */
const ORIENT =
  "Call `orientation` for this item before doing anything else — it returns the current " +
  "checkpoints, open loops and crew state. Do not assume anything about the state of the work " +
  "from this prompt: this was written when the dispatch was planned, and `orientation` is what " +
  "is true now.";

const OPENING: Record<DispatchReason, string> = {
  fresh:
    "You are picking up a piece of work that has not been started. Read the item, plan it, then " +
    "build it.",
  rework:
    "You are picking up work that has already been through review and came back with findings. " +
    "The findings are the brief — address them rather than re-deriving the task from scratch.",
  stalled:
    "You are taking over work that stalled: it was dispatched, and it stopped making progress. " +
    "Establish where it actually got to before you write anything, because some of it is " +
    "probably already done.",
};

/**
 * How a stalled pickup is warned about its own history.
 *
 * Deliberately silent at zero and one: "this is attempt 1" is noise, and an
 * agent that is nagged on a first attempt learns to skip the paragraph that
 * matters on the third.
 */
function attemptsWarning(attempts: number | undefined): string | undefined {
  if (attempts === undefined || !Number.isFinite(attempts) || attempts < 2) return undefined;
  return (
    `This work has been dispatched ${attempts} times with no durable progress recorded since. ` +
    "Whatever was tried before did not work — establish why before repeating it, and if the " +
    "obstacle is not something you can move, say so and stop rather than spending the attempt."
  );
}

/**
 * Composes the prompt for one planned dispatch.
 *
 * Pure, and returns the finished text. The launcher does not template, fill
 * in, or append to it — that is the point of composing here.
 */
export function composeLaunchPrompt(input: LaunchPromptInput): string {
  const subject =
    input.title === undefined || input.title.length === 0
      ? `Work item \`${input.candidate.id}\`.`
      : `Work item \`${input.candidate.id}\` — ${input.title}.`;

  const paragraphs = [
    subject,
    OPENING[input.reason],
    ...(input.reason === "stalled" ? [attemptsWarning(input.resumeAttempts)] : []),
    ORIENT,
  ];

  return paragraphs.filter((p): p is string => p !== undefined).join("\n\n");
}
