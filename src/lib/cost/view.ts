// The `/cost` screen's derivations — pure, so every judgement it makes is
// testable without a DOM.
//
// The judgements are all versions of one question: **what may this screen
// claim?** The task brief is blunt about it — "a cost dashboard that implies
// completeness it does not have is worse than no cost dashboard" — because
// the rows that populate `Run` (M7 #51–#54) are only partly built, so the
// corpus behind these totals is genuinely sparse. Every function here exists
// to keep a gap visible rather than let it round to zero.
import type { CostGroup, CostsPayload } from "./types";

/**
 * Whether a figure may be presented as a total at all.
 *
 * Three things independently make a total partial, and the screen has to say
 * so when any of them holds: the group list was cut (`truncated`), some runs
 * could not be priced (`unpricedRuns`), or a model in the result has no rate
 * (`unpricedModels`). They are separate facts with separate remedies —
 * raising the limit, configuring a rate — so they are reported separately
 * rather than collapsed into one "incomplete" flag.
 */
export interface CostCompleteness {
  /** True when nothing is known to be missing. */
  readonly complete: boolean;
  /** The group list was cut at the limit. */
  readonly truncated: boolean;
  /** How many runs across all returned groups had no rate. */
  readonly unpricedRuns: number;
  /** The models with no rate, so an operator knows what to configure. */
  readonly unpricedModels: readonly string[];
}

export function completenessOf(payload: CostsPayload): CostCompleteness {
  const unpricedRuns = payload.groups.reduce((total, group) => total + group.unpricedRuns, 0);
  return {
    // A total is complete only when *nothing* is known to be missing. The
    // conjunction is the point: any one of these alone makes the figure a
    // floor rather than a total.
    complete: !payload.truncated && unpricedRuns === 0 && payload.unpricedModels.length === 0,
    truncated: payload.truncated,
    unpricedRuns,
    unpricedModels: payload.unpricedModels,
  };
}

/**
 * The sum of every returned group's cost, and whether that sum is whole.
 *
 * `null` groups contribute nothing and are counted, rather than being
 * treated as zero — the distinction this whole module exists to preserve.
 * A sum over groups where *none* could be priced is `null`, not `0`: there
 * is no figure, as opposed to a figure that happens to be nothing.
 */
export interface CostTotal {
  readonly cost: number | null;
  readonly runs: number;
  readonly toolCalls: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheWriteTokens: number;
  readonly cacheReadTokens: number;
  /** How many of the returned groups had no cost at all. */
  readonly unpricedGroups: number;
}

export function totalOf(groups: readonly CostGroup[]): CostTotal {
  let cost: number | null = null;
  let unpricedGroups = 0;
  const sums = {
    runs: 0,
    toolCalls: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheWriteTokens: 0,
    cacheReadTokens: 0,
  };

  for (const group of groups) {
    sums.runs += group.runs;
    sums.toolCalls += group.toolCalls;
    sums.inputTokens += group.inputTokens;
    sums.outputTokens += group.outputTokens;
    sums.cacheWriteTokens += group.cacheWriteTokens;
    sums.cacheReadTokens += group.cacheReadTokens;
    if (group.cost === null) {
      unpricedGroups += 1;
      continue;
    }
    // `?? 0` rather than `+=` on a null, so a priced group after an unpriced
    // one still contributes — the total must not depend on the order groups
    // arrived in.
    cost = (cost ?? 0) + group.cost;
  }

  return { ...sums, cost, unpricedGroups };
}

/**
 * A cost as money, or the honest absence of one.
 *
 * **Null formats as an em dash, never as a zero.** This is the single most
 * load-bearing line in the file: `$0.00` asserts the work was free, which is
 * a different and much stronger claim than "we do not have a rate for the
 * model that served it". The screen renders unpriced work all the time —
 * `Run.model` is free text and a locally-served model has no rate — so this
 * path is common rather than exceptional.
 */
export function formatCost(cost: number | null): string {
  if (cost === null) return "—";
  return `$${cost.toFixed(2)}`;
}

/**
 * A token count, abbreviated.
 *
 * Thousands and millions because that is the scale these actually reach —
 * a single run routinely reports millions of cache-read tokens, and eight
 * digits in a table cell are unreadable. One decimal place is kept so 1.2M
 * and 1.9M stay distinguishable.
 */
export function formatTokens(count: number): string {
  if (count < 1_000) return String(count);
  if (count < 1_000_000) return `${(count / 1_000).toFixed(1)}k`;
  return `${(count / 1_000_000).toFixed(1)}M`;
}

/**
 * What to call a group whose key is null.
 *
 * Named per grouping because the *reason* the key is missing differs and is
 * worth stating: a run with no session was ingested without one, whereas a
 * run with no stage had an item in no particular state. "Unknown" for both
 * would be true and useless.
 */
export function labelForKey(key: string | null, groupBy: string): string {
  if (key !== null) return key;
  switch (groupBy) {
    case "session":
      return "No session recorded";
    case "stage":
      return "No stage recorded";
    case "item":
      return "Not attributed to an item";
    case "project":
      return "Outside any project";
    case "model":
      return "No model reported";
    default:
      return "Unknown";
  }
}

/**
 * The share one group holds of the whole, as a fraction between 0 and 1.
 *
 * Used to draw the bar beside each row. Returns 0 rather than dividing when
 * there is nothing to take a share of — an unpriced group, or a total of
 * zero — because a bar is a comparison and there is nothing here to compare
 * against. Notably this is *not* the same as the group being cheap, which is
 * why the row still shows `formatCost`'s em dash beside a zero-width bar.
 */
export function shareOf(group: CostGroup, total: number | null): number {
  if (group.cost === null || total === null || total <= 0) return 0;
  return Math.min(1, group.cost / total);
}
