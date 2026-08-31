// The mobile status picker — MILESTONES.md #76, "a list with a status
// picker instead of drag".
//
// Two halves, both without a DOM (`vitest.config.ts`: `environment:
// "node"`):
//
//   - The pure logic in `@/lib/board/status-picker` — which statuses are
//     offered, to which items, and what counts as a move.
//   - The component's OUTPUT, by calling `StatusPicker` as a function and
//     walking the element tree it returns (`tests/helpers/react-element.ts`).
//     `StatusPicker` is hook-free precisely so this works.
//
// ── Why these assert on the element tree, never on rendered text ────────
//
// This repository has repeatedly been bitten by an assertion satisfied by
// ambient copy — `expect(container.textContent).toContain(...)` passing
// against static page text with the feature entirely absent. Every
// assertion below names a specific element, a specific prop, or a specific
// option value: things only the working control produces. "Backlog" as a
// bare string would appear on the page whether or not a picker exists; an
// `<option>` whose `value` is `backlog` inside a `<select>` whose
// `aria-label` names this item would not.
//
// ── What would break these tests (they are not hollow) ─────────────────
//
//   - Offering Waiting as a choice (adding a target state for it, or
//     dropping the `acceptsDrop` filter) fails "never offers Waiting".
//   - Offering a picker on a project fails "a project gets no choices".
//   - Returning choices without marking the current one fails "marks the
//     item's own column as current".
//   - Treating a pick of the item's existing column as a move fails "is
//     not a move when the item is already in that column".
//   - Dropping the placeholder option for an item in Waiting fails "gives
//     an item in Waiting a placeholder" — the regression that would make a
//     blocked item read as though it were in Backlog.
//   - Firing `onPick` for the placeholder fails "ignores the placeholder".
//   - Dropping the `disabled` while a move is in flight fails "disables
//     the control while that row's move is in flight".
//   - Removing the per-row `aria-label` fails "names the item it belongs
//     to".
import { describe, expect, it } from "vitest";
import {
  columnLabel,
  isStatusMove,
  readOnlyStatusLabel,
  statusChoices,
  statusPickerLabel,
} from "@/lib/board/status-picker";
import { TARGET_STATE } from "@/lib/board/drag";
import { BOARD_COLUMNS } from "@/lib/board/view";
import { StatusPicker } from "@/components/board/StatusPicker";
import { findAllByType, findOneByType } from "./helpers/react-element";
import type { BoardColumnId, BoardEntry, BoardItem } from "@/lib/board/types";

function item(overrides: Partial<BoardItem> = {}): BoardItem {
  return {
    id: "item-1",
    title: "An item",
    headline: null,
    kind: "task",
    state: "executing",
    priority: "P2",
    area: "web",
    repo: "web",
    blockedOnPersonId: null,
    blockedOnType: null,
    blockedReason: null,
    pauseReason: null,
    ...overrides,
  };
}

function entry(column: BoardColumnId, overrides: Partial<BoardItem> = {}): BoardEntry {
  return { item: item(overrides), column, assignments: [], trust: null, subtasks: null };
}

/**
 * An element's props, narrowed for reading.
 *
 * `findOneByType` returns a `ReactElement`, whose `props` is `unknown` under
 * this repo's TypeScript settings — the same reason
 * `board-filter-bar-component.test.ts` casts at each access site. One named
 * helper is used here instead, so the shape being assumed is stated once
 * rather than re-spelled at every assertion.
 */
function props(element: ReturnType<typeof findOneByType>): {
  readonly value?: unknown;
  readonly disabled?: boolean;
  readonly children?: unknown;
  readonly "aria-label"?: string;
  readonly onChange?: (event: { target: { value: string } }) => void;
} {
  return element.props as {
    value?: unknown;
    disabled?: boolean;
    children?: unknown;
    "aria-label"?: string;
    onChange?: (event: { target: { value: string } }) => void;
  };
}

describe("statusChoices", () => {
  it("never offers Waiting, because both of its states need a reason no picker collects", () => {
    // The single most important property here. `blocked` needs a
    // `blocked_reason` and a `blocked_on_type`; `paused` needs a
    // `pause_reason` and a `resume_condition` (`guards/blocked-paused.ts`).
    // A picker offering Waiting would offer a move the server must always
    // refuse, which teaches that the control is unreliable.
    const choices = statusChoices(entry("backlog"));
    expect(choices.map((choice) => choice.column)).not.toContain("waiting");
  });

  it("offers exactly the columns the drag can target, so the two surfaces cannot disagree", () => {
    // Derived from TARGET_STATE rather than restated, which is the point:
    // a column that becomes reachable changes both surfaces at once.
    const expected = BOARD_COLUMNS.filter((column) => TARGET_STATE[column] !== null);
    const choices = statusChoices(entry("backlog"));
    expect(choices.map((choice) => choice.column)).toEqual(expected);
  });

  it("gives every choice the state that column actually moves to", () => {
    // A choice carrying the wrong state would move the item somewhere
    // other than where its label says.
    for (const choice of statusChoices(entry("backlog"))) {
      expect(choice.state, `${choice.column} carries the wrong state`).toBe(
        TARGET_STATE[choice.column],
      );
    }
  });

  it("marks the item's own column as current, and only that one", () => {
    const choices = statusChoices(entry("in_progress"));
    const current = choices.filter((choice) => choice.current);
    expect(current).toHaveLength(1);
    expect(current[0]!.column).toBe("in_progress");
  });

  it("marks nothing current for an item in Waiting, which is not an offered column", () => {
    // The boundary the brief names: an item whose state cannot legally be
    // a target. It must not silently read as being in the first choice.
    const choices = statusChoices(entry("waiting", { state: "blocked" }));
    expect(choices.some((choice) => choice.current)).toBe(false);
  });

  it("gives a project no choices at all — its column is derived from its children", () => {
    // DECISIONS.md §13c: a project has no state of its own to transition,
    // and the service refuses outright. Offering a control that can only
    // be refused teaches the wrong model of the data.
    expect(statusChoices(entry("backlog", { kind: "project" }))).toHaveLength(0);
  });
});

describe("isStatusMove", () => {
  it("is not a move when the item is already in that column", () => {
    // A no-op transition would write a state-change event recording that
    // nothing happened.
    expect(isStatusMove(entry("backlog"), "backlog")).toBe(false);
  });

  it("is a move to a different, reachable column", () => {
    expect(isStatusMove(entry("backlog"), "in_progress")).toBe(true);
  });

  it("is never a move to Waiting", () => {
    expect(isStatusMove(entry("backlog"), "waiting")).toBe(false);
  });

  it("is never a move for a project", () => {
    expect(isStatusMove(entry("backlog", { kind: "project" }), "in_progress")).toBe(false);
  });
});

describe("labels", () => {
  it("reads a column as a phrase rather than an identifier", () => {
    // "In progress", not "in_progress" — the underscore form is not a
    // phrase and would be shown to a person.
    expect(columnLabel("in_progress")).toBe("In progress");
  });

  it("names the item in the picker's accessible name", () => {
    // Forty rows each announcing a bare "Status" gives a screen-reader
    // user no way to tell which row is focused.
    expect(statusPickerLabel("Fix the header")).toContain("Fix the header");
  });

  it("reads a state as a phrase for the read-only case", () => {
    expect(readOnlyStatusLabel("in_review")).toBe("in review");
  });
});

describe("StatusPicker component", () => {
  const noop = () => {};

  it("renders a select whose options are the offered columns", () => {
    const tree = StatusPicker({ entry: entry("backlog"), onPick: noop });
    const select = findOneByType(tree, "select");
    const options = findAllByType(tree, "option");
    // Asserting on option VALUES, not on visible text: the labels also
    // appear elsewhere on a board page, the values do not.
    expect(options.map((option) => props(option).value)).toEqual([
      "backlog",
      "in_progress",
      "completed",
    ]);
    expect(props(select).value).toBe("backlog");
  });

  it("names the item it belongs to", () => {
    const tree = StatusPicker({
      entry: entry("backlog", { title: "Fix the header" }),
      onPick: noop,
    });
    const select = findOneByType(tree, "select");
    expect(props(select)["aria-label"]).toContain("Fix the header");
  });

  it("renders a project's status as text, with no control to operate", () => {
    const tree = StatusPicker({
      entry: entry("backlog", { kind: "project", state: "executing" }),
      onPick: noop,
    });
    expect(findAllByType(tree, "select")).toHaveLength(0);
  });

  it("gives an item in Waiting a placeholder describing where it actually is", () => {
    // Without this the select's value matches no option and the browser
    // shows the first one — a blocked item reading as though it were in
    // Backlog.
    const tree = StatusPicker({
      entry: entry("waiting", { state: "blocked" }),
      onPick: noop,
    });
    const select = findOneByType(tree, "select");
    expect(props(select).value).toBe("");
    const placeholder = findAllByType(tree, "option").find((option) => props(option).value === "");
    expect(placeholder).toBeDefined();
    expect(props(placeholder!).children).toBe("blocked");
  });

  it("issues the pick when a column is chosen", () => {
    const picked: { itemId: string; column: BoardColumnId }[] = [];
    const tree = StatusPicker({
      entry: entry("backlog", { id: "item-9" }),
      onPick: (itemId, column) => picked.push({ itemId, column }),
    });
    const select = findOneByType(tree, "select");
    // The handler is a plain function reference on the returned element —
    // invoking it directly is what this harness can do without a DOM.
    props(select).onChange!({ target: { value: "in_progress" } });
    expect(picked).toEqual([{ itemId: "item-9", column: "in_progress" }]);
  });

  it("ignores the placeholder, which is not a destination", () => {
    // Choosing it would mean "move to Waiting", which no picker can
    // express — sending it would be issuing a request certain to be
    // refused.
    const picked: string[] = [];
    const tree = StatusPicker({
      entry: entry("waiting", { state: "blocked" }),
      onPick: (itemId) => picked.push(itemId),
    });
    props(findOneByType(tree, "select")).onChange!({ target: { value: "" } });
    expect(picked).toEqual([]);
  });

  it("disables the control while that row's move is in flight", () => {
    // Two picks racing on one row would leave the board settling on
    // whichever response happened to land last.
    const tree = StatusPicker({ entry: entry("backlog"), onPick: noop, pending: true });
    expect(props(findOneByType(tree, "select")).disabled).toBe(true);
  });

  it("leaves the control usable when no move is in flight", () => {
    const tree = StatusPicker({ entry: entry("backlog"), onPick: noop });
    expect(props(findOneByType(tree, "select")).disabled).toBe(false);
  });
});
