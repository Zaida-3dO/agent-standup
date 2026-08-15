// The intervention registry — MILESTONES.md #128.
//
// A predicate says whether a situation is happening. **This module decides
// what to do about it**, and that separation is the whole design: the
// predicate returns a value and the registry applies the installation's
// configured level, timing and message to it. A predicate that emitted its
// own nudge could never be replaced by an external script; one that returns
// a finding can.
//
// ── The invariant this module enforces ─────────────────────────────────
//
// **A `post` entry cannot block.** By the time a `post` entry runs, the tool
// call has already happened, so refusing there would refuse something that
// already took effect. `INTERVENTIONS.md` states this as *"a fact rather
// than a policy"*, and it is enforced in three places rather than one,
// because each catches a different way of getting it wrong:
//
//   1. `assertRegistryValid` — a *registered* `post` entry whose default
//      level blocks is a programming error and throws at registration.
//   2. `resolveLevel` — an *override* that sets a `post` entry to a blocking
//      level is clamped to `nudge`. An installation is configuration, not
//      code, and configuration must not be able to construct a state the
//      code says is impossible.
//   3. `evaluate` — a *predicate* that returns a blocking level on a `post`
//      entry is clamped the same way. A predicate is the one input that may
//      eventually come from outside this repository, so it is the one that
//      must not be trusted to respect the rule.
//
// A blocking entry must be `pre`. There is deliberately no flag anywhere
// that relaxes this.
//
// ── Timing follows from level, not from preference ─────────────────────
//
// Blocks have no timing choice: a block that rode a digest would be
// delivered five minutes after the call it was meant to stop. So a blocking
// level resolves to `immediate` whatever the entry or the override says.
// Nudges keep the choice, and most of them should default to the digest.

import {
  isBlockingLevel,
  type Intervention,
  type InterventionContext,
  type InterventionFinding,
  type InterventionLevel,
  type InterventionMessages,
  type InterventionOverride,
  type InterventionPhase,
  type InterventionTiming,
} from "./types";

/** Raised when a registry is constructed in a state the design forbids. */
export class InterventionRegistryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InterventionRegistryError";
  }
}

/**
 * Checks a set of entries before anything can use them.
 *
 * Two failures, both programming errors rather than runtime conditions:
 * a duplicate id (settings rows attach to an id, so two entries sharing one
 * would have their configuration silently merged), and a `post` entry whose
 * default level blocks.
 */
export function assertRegistryValid(entries: readonly Intervention[]): void {
  const seen = new Set<string>();
  for (const entry of entries) {
    if (entry.id.trim() === "") {
      throw new InterventionRegistryError("an intervention must have a non-empty id");
    }
    if (seen.has(entry.id)) {
      throw new InterventionRegistryError(
        `two interventions share the id "${entry.id}"; ids key the settings rows and must be unique`,
      );
    }
    seen.add(entry.id);

    if (entry.phase === "post" && isBlockingLevel(entry.defaultLevel)) {
      throw new InterventionRegistryError(
        `intervention "${entry.id}" is a post entry with a blocking default level ` +
          `("${entry.defaultLevel}"). A post entry runs after the call has happened and cannot ` +
          `refuse it; anything that must stop an action has to be a pre entry.`,
      );
    }
  }
}

/**
 * Resolves the level an entry fires at, given its phase and any override.
 *
 * **Clamps a blocking level to `nudge` on a `post` entry**, rather than
 * throwing. This path is reached from configuration and from a predicate's
 * returned verdict, neither of which should be able to take a session down
 * — the honest response to "you asked for something impossible" here is to
 * do the strongest possible thing that is not impossible, which is to say
 * it loudly.
 *
 * Exported because it is the single place the clamp happens, and a test
 * that asserts the clamp by going through `evaluate` would also be
 * asserting everything else `evaluate` does.
 */
export function resolveLevel(phase: InterventionPhase, requested: InterventionLevel): InterventionLevel {
  if (phase === "post" && isBlockingLevel(requested)) return "nudge";
  return requested;
}

/**
 * Resolves the timing an entry fires at.
 *
 * A blocking level is always `immediate`, whatever was asked for. Note the
 * order this must be called in: pass the level *after* `resolveLevel` has
 * clamped it, or a `post` entry configured to block would be forced
 * immediate on the strength of a level it is never going to fire at.
 */
export function resolveTiming(
  level: InterventionLevel,
  requested: InterventionTiming,
): InterventionTiming {
  return isBlockingLevel(level) ? "immediate" : requested;
}

/** Applies an override's message fields over the entry's defaults, field by field. */
function resolveMessages(
  defaults: InterventionMessages,
  override: Partial<InterventionMessages> | undefined,
): InterventionMessages {
  return {
    plain: override?.plain ?? defaults.plain,
    prominent: override?.prominent ?? defaults.prominent,
  };
}

export interface EvaluateOptions {
  readonly entries: readonly Intervention[];
  readonly phase: InterventionPhase;
  readonly context: InterventionContext;
  /** Per-id installation overrides. An id with no entry here tracks the defaults. */
  readonly overrides?: Readonly<Record<string, InterventionOverride>>;
}

/**
 * Runs every entry for one phase and returns what triggered.
 *
 * ── What is deliberately not here ──────────────────────────────────────
 *
 * No emitting, no recording, no rate limiting, no digest. This function
 * turns context into findings; a caller decides where they go. That keeps
 * it pure, which is what makes every rejection path below testable as a
 * value rather than through a spy.
 *
 * ── A predicate that throws is a predicate that did not trigger ────────
 *
 * A built-in throwing is a bug worth finding, but a custom predicate
 * throwing is a Tuesday — and neither should be able to fail the tool call
 * that happened to be the thing that ran it. So a throw is swallowed per
 * entry: that entry produces nothing, and every other entry still runs. The
 * failure mode this chooses is *a missed finding*, over *an unrelated call
 * refused because someone's script had a typo*.
 */
export async function evaluate({
  entries,
  phase,
  context,
  overrides = {},
}: EvaluateOptions): Promise<readonly InterventionFinding[]> {
  const findings: InterventionFinding[] = [];

  for (const entry of entries) {
    if (entry.phase !== phase) continue;

    const override = overrides[entry.id];
    if (override?.enabled === false) continue;

    let verdict;
    try {
      verdict = await entry.predicate(context);
    } catch {
      continue;
    }

    if (verdict?.triggered !== true) continue;

    // Precedence: the predicate's own level, then the installation's
    // override, then the entry's default — narrowest first, because a
    // predicate naming a level is describing *this* firing while an
    // override describes every firing.
    const requestedLevel = verdict.level ?? override?.level ?? entry.defaultLevel;
    const level = resolveLevel(entry.phase, requestedLevel);

    // `nothing` is detected and recorded, and says nothing. It is still a
    // finding: that is the whole point of the level — observing a new entry
    // before it starts talking.
    const timing = resolveTiming(level, override?.timing ?? entry.defaultTiming);

    const configured = resolveMessages(entry.messages, override?.messages);
    // A predicate may substitute the text for this one firing. It replaces
    // both forms, because a predicate that knows enough to write a specific
    // sentence knows more than the generic prominent one does.
    const messages: InterventionMessages =
      verdict.message === undefined
        ? configured
        : { plain: verdict.message, prominent: verdict.message };

    findings.push({
      id: entry.id,
      source: entry.source,
      phase: entry.phase,
      audience: entry.audience,
      level,
      timing,
      messages,
      ...(verdict.data === undefined ? {} : { data: verdict.data }),
    });
  }

  return findings;
}

/**
 * The strongest level among a set of findings.
 *
 * `nothing` when there are none. This is what a caller uses to answer "does
 * anything here stop the call?" without re-deriving the ladder's order in
 * every call site.
 */
export function strongestLevel(findings: readonly InterventionFinding[]): InterventionLevel {
  const ORDER: readonly InterventionLevel[] = ["nothing", "nudge", "block-overridable", "hard-block"];
  let strongest: InterventionLevel = "nothing";
  for (const finding of findings) {
    if (ORDER.indexOf(finding.level) > ORDER.indexOf(strongest)) strongest = finding.level;
  }
  return strongest;
}
