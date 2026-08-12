// The state vocabulary. See docs/plans/SCHEMA.md §1.1.
//
// Eleven values, written out here rather than read off `ItemState` at
// runtime, because a test asserting "every state can reach every other
// state" needs a list it did not get from the same place the implementation
// did — reading `Object.values(ItemState)` would make that test circular:
// it would pass identically whether the implementation actually accepted
// every value or merely iterated whatever the enum happened to contain.
//
// The values are `snake_case` to match `prisma/schema.prisma`'s `ItemState`
// enum literally (`on_deck`, not `on-deck` as SCHEMA.md's prose spells it) —
// this module is the seam between the two, so nothing downstream has to
// remember which vocabulary a string is using.
export const ITEM_STATES = [
  "someday",
  "on_deck",
  "planning",
  "plan_review",
  "executing",
  "in_review",
  "paused",
  "blocked",
  "merged",
  "research_done",
  "wont_do",
  "cancelled",
] as const;

export type ItemStateValue = (typeof ITEM_STATES)[number];

const STATE_SET: ReadonlySet<string> = new Set(ITEM_STATES);

export function isItemState(value: string): value is ItemStateValue {
  return STATE_SET.has(value);
}

/** Every `(from, to)` pair as a plain array, for tests that want to sweep the whole grid. */
export function allStatePairs(): ReadonlyArray<readonly [ItemStateValue, ItemStateValue]> {
  const pairs: Array<readonly [ItemStateValue, ItemStateValue]> = [];
  for (const from of ITEM_STATES) {
    for (const to of ITEM_STATES) {
      pairs.push([from, to]);
    }
  }
  return pairs;
}
