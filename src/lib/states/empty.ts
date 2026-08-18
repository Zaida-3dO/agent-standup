// Which of the four "there is nothing to show" answers a region should give
// — as a plain function over plain data, so the decision is testable without
// rendering anything (`vitest.config.ts`: `environment: "node"`).
//
// **The four are not interchangeable, and that is the whole point.** #123
// established the principle against one column: "an empty state and a hidden
// state must not render identically". It was fixed where it was found — a
// Completed column reading `0` while the store held 175 terminal items — and
// the same confusion is reachable from every other region that can come back
// with nothing. So the distinction lives here, once, rather than being
// re-derived correctly in some components and forgotten in others.
//
// The four answers, and what each one costs a reader who is shown the wrong
// one:
//
//   - `empty` — there is genuinely nothing. Safe to believe.
//   - `withheld` — there IS something and this read deliberately did not
//     return it. Shown as `empty`, a reader concludes work does not exist
//     when it does; this is #123 exactly.
//   - `filtered` — the region has content, and the reader's own filter
//     excluded all of it. Shown as `empty`, a reader concludes the store is
//     empty when they are one click from their data. It is also the only one
//     of the four the reader can fix themselves, so it is the only one that
//     carries an action.
//   - `error` — the read failed. Shown as `empty`, a failure is reported as
//     a fact about the data, which is the worst of the four: it is silent,
//     and it is wrong in the direction of "everything is fine".

/** Which "nothing to show" answer a region is giving. */
export type EmptyKind = "empty" | "withheld" | "filtered";

/** What a region knows about its own emptiness. */
export interface EmptinessInput {
  /** How many rows this read actually returned. */
  readonly shown: number;
  /**
   * How many rows exist in this region, independent of what this read
   * returned. **Never `shown`** — the two differ on exactly the reads where
   * the distinction matters (#123).
   */
  readonly total: number;
  /** True when this read deliberately did not fetch this region. */
  readonly withheld: boolean;
  /** True when a filter is narrowing the region. */
  readonly filtered: boolean;
}

/**
 * Which empty state to render, or `null` when there is content to show.
 *
 * Order matters and is deliberate:
 *
 *   1. **Anything shown wins.** A region with rows is not empty in any of
 *      the four senses, whatever its flags say.
 *   2. **`withheld` outranks `filtered`.** A withheld region was not read,
 *      so nothing can be known about whether the filter would have excluded
 *      its contents — telling the reader "your filter hid these" would be a
 *      guess, and a wrong one whenever the filter would have matched.
 *   3. **`filtered` outranks `empty`, but only when something exists to have
 *      been filtered out.** A filter over a genuinely empty region has
 *      excluded nothing, and "clear your filter to see more" pointing at
 *      zero rows is a false lead — the same reasoning `buildSliceNotice`
 *      applies when it refuses to name an empty column in its notice.
 */
export function emptinessOf(input: EmptinessInput): EmptyKind | null {
  if (input.shown > 0) return null;
  if (input.withheld) return "withheld";
  if (input.filtered && input.total > 0) return "filtered";
  return "empty";
}
