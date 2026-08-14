// The state-to-column mapping, written out **independently of the source**
// so a test asserting "this target state really is in that column" is not
// reading its expectation from the same table the code under test uses.
//
// This is the same reasoning `src/lib/service/board/columns.ts` gives for
// spelling `STATE_TO_COLUMN` out literally rather than computing it, and
// the same reason `tests/board-columns.test.ts` names the terminal states
// itself: an assertion that imports the implementation's answer proves only
// that the implementation equals itself.
//
// Transcribed from SCHEMA.md §1.1 ("eleven values, four columns").
export const STATE_TO_COLUMN_FOR_TESTS: Readonly<Record<string, string>> = {
  someday: "backlog",
  on_deck: "backlog",
  planning: "in_progress",
  plan_review: "in_progress",
  executing: "in_progress",
  in_review: "in_progress",
  paused: "waiting",
  blocked: "waiting",
  merged: "completed",
  research_done: "completed",
  wont_do: "completed",
  cancelled: "completed",
};
