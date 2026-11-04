// src/lib/standup/view.ts — the Standup home's view-model. Pure functions over
// plain data: no DOM, no database, no clock (every age is measured from a
// fixed NOW).
//
// What a green run means: each rule below has a case that fails if the rule is
// broken, and the REFUSALS are the point (a paused item is not stuck, an item
// blocked on the reader is not stuck, a cancelled child is not progress, an
// unknown count is never a zero, two holders are one row). It does not mean
// the page reads well; that is the reviewer's render.
import { describe, expect, it } from "vitest";
import type { BoardAssignment, BoardEntry, BoardItem } from "@/lib/board/types";
import type { NeedsYouItem } from "@/lib/needs-you/types";
import type { ProjectRollup } from "@/lib/projects/types";
import type { OvernightLine, OvernightReport } from "@/lib/standup/overnight";
import type { ColumnRead, SectionState, StandupData } from "@/lib/standup/state";
import {
  MAX_DONE_ROWS,
  MAX_NEEDS_YOU_ROWS,
  MAX_PROJECT_CARDS,
  MAX_STUCK_ROWS,
  barOf,
  buildSentence,
  buildStandupView,
  dateLine,
  everySectionFailed,
  pageErrorMessage,
  shortDuration,
  type SentenceInput,
  type StandupView,
} from "@/lib/standup/view";

// ── Fixtures: invented content only ─────────────────────────────────────

const MIN = 60_000;
const H = 60 * MIN;
const DAY = 24 * H;
// Local time on purpose: the cutoff, the date line and the clock times all
// read local getters, so building NOW locally keeps these tests zone-proof.
const NOW = new Date(2026, 7, 19, 9, 0, 0).getTime(); // Wednesday 19 August, 09:00
const ago = (ms: number, now = NOW) => new Date(now - ms).toISOString();

const VIEWER = "user-a";
const RECIPE = { id: "project-recipe", title: "Recipe box" };
const GARDEN = { id: "project-garden", title: "Garden lights" };

function boardItem(overrides: Partial<BoardItem> = {}): BoardItem {
  return {
    id: "item-1",
    title: "Item 1",
    headline: null,
    kind: "task",
    project: null,
    state: "executing",
    priority: "P2",
    area: "web",
    repo: null,
    blockedOnPersonId: null,
    blockedOnType: null,
    blockedReason: null,
    pauseReason: null,
    ...overrides,
  };
}

function holder(overrides: Partial<BoardAssignment> = {}): BoardAssignment {
  return {
    holderId: "agent-1",
    holderType: "agent",
    displayName: "Agent One",
    role: "builder",
    roleCustom: null,
    liveness: "running",
    lastActive: ago(5 * MIN),
    ...overrides,
  };
}

function entry(
  item: Partial<BoardItem> = {},
  assignments: readonly BoardAssignment[] = [],
): BoardEntry {
  return {
    item: boardItem(item),
    column: "in_progress",
    assignments,
    trust: null,
    subtasks: null,
  };
}

function column(entries: readonly BoardEntry[], capped = false): ColumnRead {
  return { entries, total: entries.length, capped };
}

function needs(overrides: Partial<NeedsYouItem> = {}): NeedsYouItem {
  return {
    id: "need-1",
    title: "Need 1",
    headline: null,
    project: null,
    state: "plan_review",
    reason: "plan_review",
    blockedReason: null,
    updatedAt: ago(5 * H),
    mergeAuthority: "pre_approved",
    needsVisualReview: false,
    tipCommitSha: null,
    ...overrides,
  };
}

const ZERO_COUNTS = {
  someday: 0,
  on_deck: 0,
  planning: 0,
  plan_review: 0,
  executing: 0,
  in_review: 0,
  paused: 0,
  blocked: 0,
  merged: 0,
  research_done: 0,
  wont_do: 0,
  cancelled: 0,
};

function rollup(
  id: string,
  counts: Partial<typeof ZERO_COUNTS> = { executing: 1 },
  overrides: Partial<ProjectRollup> = {},
): ProjectRollup {
  const full = { ...ZERO_COUNTS, ...counts };
  const total = Object.values(full).reduce((sum, n) => sum + n, 0);
  return {
    id,
    title: `Project ${id}`,
    headline: "A project for testing.",
    area: "web",
    repo: null,
    priority: "P2",
    total,
    merged: full.merged,
    finished: full.merged + full.research_done + full.wont_do + full.cancelled,
    counts: full,
    progress: total === 0 ? null : 0,
    childless: total === 0,
    lastActivity: ago(2 * H),
    assignments: [],
    ...overrides,
  };
}

function report(overrides: Partial<OvernightReport> = {}): OvernightReport {
  return {
    since: ago(15 * H),
    merged: [],
    cost: null,
    costUnavailable: false,
    eventsTruncated: false,
    ...overrides,
  };
}

function line(overrides: Partial<OvernightLine> = {}): OvernightLine {
  return { itemId: "done-1", itemTitle: "Done 1", ts: ago(2 * H), project: null, ...overrides };
}

const loadedOf = <T>(data: T): SectionState<T> => ({ status: "loaded", data });
const failed = (message = "Could not load."): { status: "error"; message: string } => ({
  status: "error",
  message,
});

function standup(overrides: Partial<StandupData> = {}): StandupData {
  return {
    viewerId: VIEWER,
    overnight: loadedOf(report()),
    inProgress: loadedOf(column([])),
    waiting: loadedOf(column([])),
    projects: loadedOf({ projects: [], childlessCount: 0 }),
    needsYou: loadedOf({ items: [], total: 0 }),
    ...overrides,
  };
}

const viewOf = (overrides: Partial<StandupData> = {}, now = NOW): StandupView =>
  buildStandupView(standup(overrides), now);

function needsOf(view: StandupView) {
  if (view.needsYou.status !== "loaded") throw new Error("needs-you errored");
  return view.needsYou;
}
function stuckOf(view: StandupView) {
  if (view.stuck.status !== "loaded") throw new Error(`stuck errored: ${view.stuck.message}`);
  return view.stuck;
}
function projectsOf(view: StandupView) {
  if (view.projects.status !== "loaded") throw new Error("projects errored");
  return view.projects;
}
function doneOf(view: StandupView) {
  if (view.done.status !== "loaded") throw new Error("done errored");
  return view.done;
}

// ── Time ────────────────────────────────────────────────────────────────

describe("time wording", () => {
  it.each([
    [-5 * MIN, "under a minute"],
    [0, "under a minute"],
    [59_999, "under a minute"],
    [MIN, "1m"],
    [40 * MIN, "40m"],
    [59 * MIN + 59_999, "59m"],
    [H, "1h"],
    [5 * H, "5h"],
    [24 * H - 1, "23h"],
    [DAY, "1 day"],
    [3 * DAY, "3 days"],
    [29 * DAY, "29 days"],
    [30 * DAY, "1 month"],
    [75 * DAY, "2 months"],
    [400 * DAY, "1 year"],
  ])("%d ms reads %s", (ms, expected) => {
    expect(shortDuration(ms)).toBe(expected);
  });

  it("writes the date line without depending on the runtime's locale", () => {
    expect(dateLine(NOW)).toBe("Wednesday 19 August");
    expect(dateLine(new Date(2026, 10, 4, 12).getTime())).toBe("Wednesday 4 November");
  });
});

// ── The sentence ────────────────────────────────────────────────────────

const FULL: SentenceInput = {
  needs: { count: 4, atLeast: false },
  work: { agents: { count: 6, atLeast: false }, projects: { count: 5, atLeast: false } },
  done: { count: 9, atLeast: false },
  sinceLabel: "yesterday evening",
};

describe("the sentence", () => {
  const cases: [string, SentenceInput, string][] = [
    [
      "every clause",
      FULL,
      "4 things need you. 6 agents are working across 5 projects, and 9 things were finished since yesterday evening.",
    ],
    [
      "singulars",
      {
        ...FULL,
        needs: { count: 1, atLeast: false },
        work: { agents: { count: 1, atLeast: false }, projects: { count: 1, atLeast: false } },
        done: { count: 1, atLeast: false },
      },
      "1 thing needs you. 1 agent is working across 1 project, and 1 thing was finished since yesterday evening.",
    ],
    [
      "nothing needs you",
      { ...FULL, needs: { count: 0, atLeast: false } },
      "Nothing needs you. 6 agents are working across 5 projects, and 9 things were finished since yesterday evening.",
    ],
    [
      "events failed: the finished clause is dropped, not zeroed",
      { ...FULL, done: null },
      "4 things need you. 6 agents are working across 5 projects.",
    ],
    [
      "in-progress read failed: the agents clause is dropped",
      { ...FULL, work: null },
      "4 things need you. 9 things were finished since yesterday evening.",
    ],
    [
      "needs-you failed: the lead is dropped and the next clause starts the sentence",
      { ...FULL, needs: null },
      "6 agents are working across 5 projects, and 9 things were finished since yesterday evening.",
    ],
    ["only the lead", { ...FULL, work: null, done: null }, "4 things need you."],
    [
      "only finished work",
      { ...FULL, needs: null, work: null },
      "9 things were finished since yesterday evening.",
    ],
    ["every read failed", { ...FULL, needs: null, work: null, done: null }, ""],
    [
      "a known zero is stated as a zero",
      {
        ...FULL,
        work: { agents: { count: 0, atLeast: false }, projects: { count: 0, atLeast: false } },
        done: { count: 0, atLeast: false },
      },
      "4 things need you. No agents are working right now, and nothing was finished since yesterday evening.",
    ],
    [
      "nothing finished and nothing else known",
      { ...FULL, needs: null, work: null, done: { count: 0, atLeast: false } },
      "Nothing was finished since yesterday evening.",
    ],
    [
      "agents with no project to name",
      {
        ...FULL,
        work: { agents: { count: 2, atLeast: false }, projects: { count: 0, atLeast: false } },
      },
      "4 things need you. 2 agents are working, and 9 things were finished since yesterday evening.",
    ],
    [
      "capped counts are floors",
      {
        ...FULL,
        work: { agents: { count: 6, atLeast: true }, projects: { count: 5, atLeast: true } },
        done: { count: 9, atLeast: true },
      },
      "4 things need you. 6+ agents are working across 5+ projects, and 9+ things were finished since yesterday evening.",
    ],
    [
      "a floor of one is still plural",
      { ...FULL, done: { count: 1, atLeast: true }, work: null },
      "4 things need you. 1+ things were finished since yesterday evening.",
    ],
    [
      "the window opens the same day",
      { ...FULL, sinceLabel: "this evening", work: null },
      "4 things need you. 9 things were finished since this evening.",
    ],
  ];

  it.each(cases)("%s", (_name, input, expected) => {
    const sentence = buildSentence(input);
    expect(sentence.text).toBe(expected);
    // The runs, joined, are exactly the sentence.
    expect(sentence.parts.map((part) => part.text).join("")).toBe(expected);
    if (expected === "") expect(sentence.parts).toEqual([]);
  });

  it("styles the lead by whether anything needs the reader, and brightens the finished count", () => {
    const busy = buildSentence(FULL).parts;
    expect(busy[0]).toEqual({ text: "4 things need you.", tone: "hot" });
    expect(busy.find((part) => part.text === "9 things")?.tone).toBe("strong");

    const quiet = buildSentence({ ...FULL, needs: { count: 0, atLeast: false } }).parts;
    expect(quiet[0]).toEqual({ text: "Nothing needs you.", tone: "clear" });
  });

  it("never prints a zero for an unknown, even when every read but one failed", () => {
    const view = viewOf({
      needsYou: failed(),
      inProgress: failed(),
      overnight: loadedOf(report({ merged: [line()] })),
    });
    expect(view.sentence.text).toBe("1 thing was finished since yesterday evening.");

    const none = viewOf({ needsYou: failed(), inProgress: failed(), overnight: failed() });
    expect(none.sentence.text).toBe("");
    expect(none.sentence.text).not.toMatch(/\b0\b|nothing|no agents/i);
  });

  it("names the evening the window opened on, by the clock", () => {
    expect(viewOf().sinceLabel).toBe("yesterday evening");
    // After 18:00 the cutoff is 18:00 on the same day, not the day before.
    const evening = new Date(2026, 7, 19, 20, 30).getTime();
    const view = viewOf({ overnight: loadedOf(report({ merged: [line()] })) }, evening);
    expect(view.sinceLabel).toBe("this evening");
    expect(view.sentence.text).toContain("since this evening");
  });
});

describe("agents and projects in the sentence", () => {
  const live = (
    id: string,
    project: { id: string; title: string } | null,
    ...assignments: BoardAssignment[]
  ) => entry({ id, title: `Live ${id}`, project }, assignments);

  it("counts distinct running agents, and the distinct projects they work in", () => {
    const view = viewOf({
      inProgress: loadedOf(
        column([
          live("a", RECIPE, holder({ holderId: "agent-1" })),
          // The same agent on a second item in the same project: still one agent.
          live("b", RECIPE, holder({ holderId: "agent-1" })),
          live("c", GARDEN, holder({ holderId: "agent-2" })),
          // An item that arrived on a second page is one item, not two.
          live("c", GARDEN, holder({ holderId: "agent-2" })),
        ]),
      ),
      projects: loadedOf({ projects: [rollup(GARDEN.id)], childlessCount: 0 }),
    });
    expect(view.sentence.text).toContain("2 agents are working across 2 projects");
    expect(projectsOf(view).cards[0]!.liveItems).toHaveLength(1);
  });

  it("counts two holders on one item as two agents but one live item", () => {
    const view = viewOf({
      inProgress: loadedOf(
        column([
          live(
            "a",
            RECIPE,
            holder({ holderId: "agent-1" }),
            holder({ holderId: "agent-2", role: "reviewer" }),
          ),
        ]),
      ),
      projects: loadedOf({ projects: [rollup(RECIPE.id)], childlessCount: 0 }),
    });
    expect(view.sentence.text).toContain("2 agents are working across 1 project");
    expect(projectsOf(view).cards[0]!.liveItems).toEqual([{ id: "a", title: "Live a" }]);
  });

  it("does not count stopped, replaced or human holders as agents working", () => {
    const view = viewOf({
      inProgress: loadedOf(
        column([
          live("a", RECIPE, holder({ holderId: "agent-1", liveness: "stalled" })),
          live("b", RECIPE, holder({ holderId: "agent-2", liveness: "dead" })),
          live("c", RECIPE, holder({ holderId: "agent-3", liveness: "superseded" })),
          live("d", RECIPE, holder({ holderId: "user-a", holderType: "person" })),
        ]),
      ),
    });
    expect(view.sentence.text).toContain("No agents are working right now");
  });

  it("never counts a project row, and shows a floor when the column was capped", () => {
    const view = viewOf({
      inProgress: loadedOf(
        column(
          [
            entry({ id: "p", kind: "project" }, [holder({ holderId: "agent-9" })]),
            live("a", RECIPE, holder({ holderId: "agent-1" })),
          ],
          true,
        ),
      ),
    });
    expect(view.sentence.text).toContain("1+ agents are working across 1+ projects");
  });
});

// ── Needs you ───────────────────────────────────────────────────────────

describe("Needs you rows", () => {
  const verbCases: [NeedsYouItem["reason"], string, string][] = [
    ["blocked_on_you", "Answer", "Someone is waiting on an answer from you."],
    ["plan_review", "Review plan", "The plan is written. Approving it lets the work start."],
    ["needs_visual_review", "Take a look", "Have a look and say whether it looks right."],
    ["needs_approval", "Approve", "Finished and reviewed. It goes live once you approve it."],
  ];

  it.each(verbCases)("%s asks with the verb %s and a plain prompt", (reason, verb, ask) => {
    const row = needsOf(viewOf({ needsYou: loadedOf({ items: [needs({ reason })], total: 1 }) }))
      .rows[0]!;
    expect(row.verb).toBe(verb);
    expect(row.ask).toBe(ask);
    // Plain words: no state codes, no jargon the page promises not to show.
    expect(`${row.verb} ${row.ask}`).not.toMatch(/commit|plan_review|executing|blocked_on/i);
  });

  it("uses the item's own question when it is blocked on the reader, and a plain prompt when it gives none", () => {
    const row = (blockedReason: string | null) =>
      needsOf(
        viewOf({
          needsYou: loadedOf({
            items: [needs({ reason: "blocked_on_you", state: "blocked", blockedReason })],
            total: 1,
          }),
        }),
      ).rows[0]!;
    expect(row("Which file format first: the spreadsheet or the PDF?").ask).toBe(
      "Which file format first: the spreadsheet or the PDF?",
    );
    expect(row("   ").ask).toBe("Someone is waiting on an answer from you.");
    expect(row(null).ask).toBe("Someone is waiting on an answer from you.");
  });

  it("ignores a stale blockedReason on a row that needs a different act", () => {
    const row = needsOf(
      viewOf({
        needsYou: loadedOf({
          items: [needs({ reason: "plan_review", blockedReason: "old question" })],
          total: 1,
        }),
      }),
    ).rows[0]!;
    expect(row.ask).toBe("The plan is written. Approving it lets the work start.");
  });

  it("falls back to a neutral verb for a reason it has no wording for", () => {
    const row = needsOf(
      viewOf({
        needsYou: loadedOf({
          items: [needs({ reason: "something_new" as NeedsYouItem["reason"] })],
          total: 1,
        }),
      }),
    ).rows[0]!;
    expect(row.verb).toBe("Open");
    expect(row.ask).toBe("This needs a decision from you.");
  });

  const waitCases: [string, string | null, string | null, boolean][] = [
    ["40 minutes", ago(40 * MIN), "waiting 40m", false],
    ["5 hours", ago(5 * H), "waiting 5h", false],
    ["a minute short of a day", ago(DAY - MIN), "waiting 23h", false],
    ["exactly a day", ago(DAY), "waiting 1 day", true],
    ["three days", ago(3 * DAY), "waiting 3 days", true],
    ["just now", ago(10_000), "waiting under a minute", false],
    ["an unreadable time", "not a date", null, false],
  ];

  it.each(waitCases)("%s of waiting reads %s, amber %s", (_name, updatedAt, label, long) => {
    const row = needsOf(
      viewOf({ needsYou: loadedOf({ items: [needs({ updatedAt: updatedAt! })], total: 1 }) }),
    ).rows[0]!;
    expect(row.waiting).toBe(label);
    expect(row.waitingLong).toBe(long);
  });

  it("links to the reviews when the wait is answered there, and to the item when it is an answer", () => {
    const rows = needsOf(
      viewOf({
        needsYou: loadedOf({
          items: [
            needs({ id: "q/1", reason: "blocked_on_you" }),
            needs({ id: "p-2", reason: "plan_review" }),
          ],
          total: 2,
        }),
      }),
    ).rows;
    expect(rows.find((r) => r.id === "q/1")!.href).toBe("/items/q%2F1");
    expect(rows.find((r) => r.id === "p-2")!.href).toBe("/items/p-2#reviews");
  });

  it("is one row per item, oldest wait first, with the project carried", () => {
    const view = viewOf({
      needsYou: loadedOf({
        items: [
          needs({ id: "new", updatedAt: ago(H) }),
          needs({ id: "old", updatedAt: ago(3 * H), project: RECIPE }),
          needs({ id: "old", updatedAt: ago(3 * H), project: RECIPE }),
        ],
        total: 3,
      }),
    });
    const { rows } = needsOf(view);
    expect(rows.map((row) => row.id)).toEqual(["old", "new"]);
    expect(rows[0]!.project).toEqual(RECIPE);
  });

  it("draws the five oldest waits, but counts and badges every one", () => {
    const seven = Array.from({ length: 7 }, (_, i) =>
      needs({ id: `n${i}`, updatedAt: ago((i + 1) * H), project: RECIPE }),
    );
    const view = viewOf({
      needsYou: loadedOf({ items: seven, total: 7 }),
      projects: loadedOf({ projects: [rollup(RECIPE.id)], childlessCount: 0 }),
    });
    const { rows, total, hasMore } = needsOf(view);
    // Killed by dropping the cap, by capping before sorting, or by counting
    // the rows drawn instead of the items that need the reader.
    expect(rows.map((row) => row.id)).toEqual(["n6", "n5", "n4", "n3", "n2"]);
    expect(rows).toHaveLength(MAX_NEEDS_YOU_ROWS);
    expect(total).toBe(7);
    expect(hasMore).toBe(true);
    expect(view.sentence.text).toMatch(/^7 things need you\./);
    expect(projectsOf(view).cards[0]!.needsYouBadge).toBe("7 need you");
  });

  it("is quiet at zero, and says when the server holds more than the rows shown", () => {
    const quiet = needsOf(viewOf());
    expect(quiet).toMatchObject({ quiet: true, total: 0, hasMore: false, rows: [] });

    const more = needsOf(viewOf({ needsYou: loadedOf({ items: [needs()], total: 9 }) }));
    expect(more).toMatchObject({ quiet: false, total: 9, hasMore: true });
    expect(more.total).toBe(9);
    expect(viewOf({ needsYou: loadedOf({ items: [needs()], total: 9 }) }).sentence.text).toMatch(
      /^9 things need you\./,
    );
  });

  it("is an error section when the read failed, and the lead of the sentence is dropped", () => {
    const view = viewOf({ needsYou: failed("Could not load what needs you.") });
    expect(view.needsYou).toEqual({ status: "error", message: "Could not load what needs you." });
    expect(view.sentence.text).not.toMatch(/need/);
  });
});

// ── Stuck ───────────────────────────────────────────────────────────────

describe("Stuck", () => {
  const blocked = (overrides: Partial<BoardItem> = {}) => entry({ state: "blocked", ...overrides });
  const wait = (...entries: BoardEntry[]) => ({ waiting: loadedOf(column(entries)) });
  const progress = (...entries: BoardEntry[]) => ({ inProgress: loadedOf(column(entries)) });
  const ids = (view: StandupView) => stuckOf(view).rows.map((row) => row.id);

  it("lists an item blocked on something outside, with the reason, project and age, once", () => {
    const outside = blocked({
      id: "ext",
      title: "Open the frame from the hub",
      blockedOnType: "external_process",
      blockedReason: "Waiting for the upstream maintainers to review the change.",
      project: GARDEN,
      updatedAt: ago(4 * DAY),
    });
    // The same item arriving on two pages is listed once.
    const view = viewOf(wait(outside, outside));
    expect(stuckOf(view).rows).toEqual([
      {
        id: "ext",
        title: "Open the frame from the hub",
        href: "/items/ext",
        project: GARDEN,
        why: "Waiting for the upstream maintainers to review the change.",
        age: "4 days",
        kind: "blocked",
      },
    ]);
    expect(stuckOf(view).count).toEqual({ count: 1, atLeast: false });
  });

  it("lists a timed block and a block on someone else, but never one on the reader", () => {
    const view = viewOf(
      wait(
        blocked({ id: "timed", blockedOnType: "time", blockedReason: "Until the shop opens." }),
        blocked({ id: "other", blockedOnType: "person", blockedOnPersonId: "user-b" }),
        blocked({ id: "mine", blockedOnType: "person", blockedOnPersonId: VIEWER }),
      ),
    );
    expect(ids(view).sort()).toEqual(["other", "timed"]);
  });

  it("explains a block that gave no reason in plain words", () => {
    const rows = stuckOf(
      viewOf(
        wait(
          blocked({ id: "x", blockedOnType: "external_process" }),
          blocked({ id: "t", blockedOnType: "time" }),
          blocked({ id: "p", blockedOnType: "person", blockedOnPersonId: "user-b" }),
        ),
      ),
    ).rows;
    const why = Object.fromEntries(rows.map((row) => [row.id, row.why]));
    expect(why).toEqual({
      x: "Waiting on something outside.",
      t: "Waiting for a set time.",
      p: "Waiting on someone else.",
    });
  });

  it("does not guess an age the board did not send", () => {
    const row = stuckOf(viewOf(wait(blocked({ id: "x", blockedOnType: "time" })))).rows[0]!;
    expect(row.age).toBeNull();
  });

  it("never lists a paused item: a pause is a choice", () => {
    const view = viewOf(
      wait(entry({ id: "paused", state: "paused", pauseReason: "Until the new tablet arrives." })),
    );
    expect(ids(view)).toEqual([]);
  });

  it("never lists a project row from the waiting column", () => {
    const view = viewOf(wait(blocked({ id: "proj", kind: "project", blockedOnType: "time" })));
    expect(ids(view)).toEqual([]);
  });

  it("lists in-progress work whose only holders have stopped, aged by the latest report", () => {
    const view = viewOf(
      progress(
        entry({ id: "quiet", title: "Read statements from email", project: RECIPE }, [
          holder({ holderId: "agent-1", liveness: "stalled", lastActive: ago(5 * H) }),
          holder({ holderId: "agent-2", liveness: "dead", lastActive: ago(3 * H) }),
        ]),
      ),
    );
    // Two stopped holders are one row, aged by the more recent of them.
    expect(stuckOf(view).rows).toEqual([
      {
        id: "quiet",
        title: "Read statements from email",
        href: "/items/quiet",
        project: RECIPE,
        why: "Its agent stopped responding.",
        age: "quiet for 3h",
        kind: "stopped",
      },
    ]);
  });

  it("does not list work that still has a running holder, however many have stopped", () => {
    const view = viewOf(
      progress(
        entry({ id: "mixed" }, [
          holder({ holderId: "agent-1", liveness: "dead" }),
          holder({ holderId: "agent-2", liveness: "running" }),
        ]),
      ),
    );
    expect(ids(view)).toEqual([]);
  });

  it("ignores a handover's superseded leftover, and does not list work nobody holds", () => {
    const view = viewOf(
      progress(
        entry({ id: "handover" }, [
          holder({ holderId: "agent-1", liveness: "superseded" }),
          holder({ holderId: "agent-2", liveness: "stalled" }),
        ]),
        entry({ id: "replaced-only" }, [holder({ liveness: "superseded" })]),
        entry({ id: "unclaimed" }, []),
      ),
    );
    expect(ids(view)).toEqual(["handover"]);
  });

  it("repeats nothing that Needs you already lists", () => {
    const view = viewOf({
      ...progress(entry({ id: "both" }, [holder({ liveness: "stalled" })])),
      needsYou: loadedOf({ items: [needs({ id: "both" })], total: 1 }),
    });
    expect(ids(view)).toEqual([]);
  });

  it("puts the longest-stuck first and an unknown age last", () => {
    const view = viewOf({
      ...wait(
        blocked({ id: "unknown", blockedOnType: "time" }),
        blocked({ id: "week", blockedOnType: "time", updatedAt: ago(7 * DAY) }),
      ),
      ...progress(entry({ id: "hours" }, [holder({ liveness: "dead", lastActive: ago(3 * H) })])),
    });
    expect(ids(view)).toEqual(["week", "hours", "unknown"]);
  });

  it("draws five rows, longest-stuck first, but counts and badges every stuck item", () => {
    const seven = Array.from({ length: 7 }, (_, i) =>
      blocked({
        id: `s${i}`,
        blockedOnType: "time",
        project: RECIPE,
        updatedAt: ago((i + 1) * DAY),
      }),
    );
    const view = viewOf({
      ...wait(...seven),
      projects: loadedOf({ projects: [rollup(RECIPE.id)], childlessCount: 0 }),
    });
    const stuck = stuckOf(view);
    // Killed by dropping the cap (seven rows), by capping before sorting
    // (not the longest five), or by counting the capped rows.
    expect(stuck.rows).toHaveLength(MAX_STUCK_ROWS);
    expect(stuck.rows.map((row) => row.id)).toEqual(["s6", "s5", "s4", "s3", "s2"]);
    expect(stuck.count).toEqual({ count: 7, atLeast: false });
    expect(stuck.more).toBe(2);
    expect(projectsOf(view).cards[0]!.stuckBadge).toBe("7 stuck");
  });

  it("is an empty list, not an error, when both reads loaded and nothing is stuck", () => {
    expect(stuckOf(viewOf()).rows).toEqual([]);
    expect(stuckOf(viewOf()).count).toEqual({ count: 0, atLeast: false });
  });

  it("shows what the other read found as a floor when one read failed, and errors when it found nothing", () => {
    const partial = viewOf({
      waiting: failed("Could not load the board."),
      ...progress(entry({ id: "quiet" }, [holder({ liveness: "dead" })])),
    });
    expect(ids(partial)).toEqual(["quiet"]);
    expect(stuckOf(partial).count).toEqual({ count: 1, atLeast: true });

    // "Nothing stuck" would be a claim about data that was never read.
    const blind = viewOf({ waiting: failed("Could not load the board.") });
    expect(blind.stuck).toEqual({ status: "error", message: "Could not load the board." });
    expect(viewOf({ inProgress: failed("nope") }).stuck.status).toBe("error");
  });

  it("marks the count as a floor when a column was capped", () => {
    const view = viewOf({
      waiting: loadedOf(column([blocked({ id: "x", blockedOnType: "time" })], true)),
    });
    expect(stuckOf(view).count).toEqual({ count: 1, atLeast: true });
  });
});

// ── The progress bar ────────────────────────────────────────────────────

describe("a project's bar", () => {
  const cases: [string, Partial<typeof ZERO_COUNTS>, [number, number, number, number], string][] = [
    [
      "merged and research both count as done",
      { merged: 18, research_done: 2, executing: 4, blocked: 2, on_deck: 5 },
      [20, 4, 2, 5],
      "20 of 31 done, 4 in progress, 2 stuck or paused",
    ],
    [
      "a cancelled or won't-do child is not done and not in the total",
      { merged: 2, cancelled: 5, wont_do: 1, on_deck: 3 },
      [2, 0, 0, 3],
      "2 of 5 done",
    ],
    [
      "every in-progress state counts as in progress",
      { planning: 1, plan_review: 1, executing: 1, in_review: 1 },
      [0, 4, 0, 0],
      "0 of 4 done, 4 in progress",
    ],
    [
      "paused and blocked are the stuck-or-paused part",
      { paused: 1, blocked: 2, merged: 1 },
      [1, 0, 3, 0],
      "1 of 4 done, 3 stuck or paused",
    ],
    ["someday is to do", { someday: 2, on_deck: 1 }, [0, 0, 0, 3], "0 of 3 done"],
  ];

  it.each(cases)("%s", (_name, counts, [done, inProgress, stuck, todo], aria) => {
    const bar = barOf({ ...ZERO_COUNTS, ...counts })!;
    expect([bar.done, bar.inProgress, bar.stuckOrPaused, bar.todo]).toEqual([
      done,
      inProgress,
      stuck,
      todo,
    ]);
    expect(bar.total).toBe(done + inProgress + stuck + todo);
    expect(bar.caption).toBe(`${done} of ${bar.total} done`);
    expect(bar.ariaLabel).toBe(aria);
  });

  it("draws widths as shares of the counted total", () => {
    const bar = barOf({ ...ZERO_COUNTS, merged: 2, executing: 1, blocked: 1, cancelled: 100 })!;
    expect(bar.doneWidth).toBeCloseTo(50);
    expect(bar.inProgressWidth).toBeCloseTo(25);
    expect(bar.stuckWidth).toBeCloseTo(25);
  });

  it("has no bar when there is nothing countable, rather than 0 of 0", () => {
    expect(barOf({ ...ZERO_COUNTS, cancelled: 4, wont_do: 2 })).toBeNull();
    expect(barOf(ZERO_COUNTS)).toBeNull();
    expect(barOf(null)).toBeNull();
    expect(barOf(undefined)).toBeNull();
  });

  it("reads a missing, negative or non-numeric count as nothing rather than as progress", () => {
    const bar = barOf({ merged: 3, executing: -2, blocked: Number.NaN, on_deck: 1 })!;
    expect([bar.done, bar.inProgress, bar.stuckOrPaused, bar.todo]).toEqual([3, 0, 0, 1]);
  });
});

// ── Project cards and lists ─────────────────────────────────────────────

describe("which projects get a card", () => {
  const recent = ago(2 * H);
  const old = ago(8 * DAY);
  const projectsData = (...projects: ProjectRollup[]): Partial<StandupData> => ({
    projects: loadedOf({ projects, childlessCount: 0 }),
  });
  const sections = (view: StandupView) => {
    const p = projectsOf(view);
    return {
      cards: p.cards.map((c) => c.id),
      quiet: p.quiet.map((c) => c.id),
      notStarted: p.notStarted.map((c) => c.id),
      also: p.alsoActive.map((c) => c.id),
    };
  };
  const liveIn = (project: { id: string; title: string }) =>
    entry({ id: `live-${project.id}`, project }, [holder()]);

  it("gives open work with recent activity a card, and open work gone quiet a name", () => {
    const view = viewOf(
      projectsData(
        rollup("fresh", { executing: 1 }, { lastActivity: recent }),
        rollup("stale", { executing: 1 }, { lastActivity: old }),
      ),
    );
    expect(sections(view)).toMatchObject({ cards: ["fresh"], quiet: ["stale"] });

    // A project the read returned twice is listed once.
    const a = rollup("a", { executing: 1 }, { lastActivity: recent });
    expect(sections(viewOf(projectsData(a, a))).cards).toEqual(["a"]);
  });

  it("treats exactly seven days as recent and a moment past it as quiet", () => {
    const view = viewOf(
      projectsData(
        rollup("edge", { on_deck: 1 }, { lastActivity: ago(7 * DAY) }),
        rollup("past", { on_deck: 1 }, { lastActivity: ago(7 * DAY + 1) }),
      ),
    );
    expect(sections(view)).toMatchObject({ cards: ["edge"], quiet: ["past"] });
  });

  it("keeps a quiet project on the page as a card when it has live work, something for the reader, or a stuck item", () => {
    const quiet = (id: string) => rollup(id, { executing: 1 }, { lastActivity: old });
    const view = viewOf({
      ...projectsData(quiet("live"), quiet("needy"), quiet("stuck"), quiet("idle")),
      inProgress: loadedOf(column([liveIn({ id: "live", title: "Live" })])),
      needsYou: loadedOf({
        items: [needs({ project: { id: "needy", title: "Needy" } })],
        total: 1,
      }),
      waiting: loadedOf(
        column([
          entry({
            id: "s",
            state: "blocked",
            blockedOnType: "time",
            project: { id: "stuck", title: "Stuck" },
          }),
        ]),
      ),
    });
    expect(sections(view).cards.sort()).toEqual(["live", "needy", "stuck"]);
    expect(sections(view).quiet).toEqual(["idle"]);
  });

  it("lists a project with no children by name under Not started", () => {
    const view = viewOf(projectsData(rollup("empty", {}, { lastActivity: recent })));
    expect(sections(view)).toMatchObject({ cards: [], notStarted: ["empty"] });
  });

  it("hides a project whose every child is done or abandoned", () => {
    const view = viewOf(
      projectsData(rollup("finished", { merged: 4, cancelled: 2 }, { lastActivity: recent })),
    );
    expect(sections(view)).toEqual({ cards: [], quiet: [], notStarted: [], also: [] });
    expect(projectsOf(view).empty).toBe(true);
  });

  it("says there are no projects only when there is nothing to list anywhere", () => {
    expect(projectsOf(viewOf()).empty).toBe(true);
    expect(projectsOf(viewOf(projectsData(rollup("a", {}, {})))).empty).toBe(false);
  });

  it("orders cards by needs-you, then stuck, then live work, then recent activity", () => {
    const mk = (id: string, hoursAgo: number) =>
      rollup(id, { executing: 1 }, { lastActivity: ago(hoursAgo * H) });
    const ref = (id: string) => ({ id, title: id });
    const stuckItem = (project: string) =>
      entry({ id: `s-${project}`, state: "blocked", blockedOnType: "time", project: ref(project) });
    const view = viewOf({
      ...projectsData(
        mk("plain-old", 20),
        mk("plain-new", 1),
        mk("live", 10),
        mk("stuck", 10),
        mk("need1", 10),
        mk("need2", 10),
      ),
      inProgress: loadedOf(column([liveIn(ref("live"))])),
      waiting: loadedOf(column([stuckItem("stuck")])),
      needsYou: loadedOf({
        items: [
          needs({ id: "n1", project: ref("need1") }),
          needs({ id: "n2", project: ref("need2") }),
          needs({ id: "n3", project: ref("need2") }),
        ],
        total: 3,
      }),
    });
    expect(sections(view).cards).toEqual([
      "need2",
      "need1",
      "stuck",
      "live",
      "plain-new",
      "plain-old",
    ]);
  });

  it("shows at most twelve cards and lists the rest by name, in card order", () => {
    const many = Array.from({ length: MAX_PROJECT_CARDS + 2 }, (_, n) =>
      rollup(
        `p${String(n).padStart(2, "0")}`,
        { executing: 1 },
        { lastActivity: ago((n + 1) * H) },
      ),
    );
    const view = viewOf(projectsData(...many));
    const s = sections(view);
    expect(s.cards).toHaveLength(MAX_PROJECT_CARDS);
    expect(s.also).toEqual(["p12", "p13"]);
    expect(projectsOf(view).activeCount).toEqual({ count: 14, atLeast: false });
    expect(projectsOf(view).activeText).toBe("14 active");
  });

  it("shows the active count as a floor when the projects list was capped", () => {
    const view = viewOf({
      projects: loadedOf({
        projects: [rollup("a", { executing: 1 }, { lastActivity: recent })],
        childlessCount: 0,
        nextCursor: "a",
      }),
    });
    expect(projectsOf(view).activeText).toBe("1+ active");
  });

  it("is an error section when the projects read failed", () => {
    expect(viewOf({ projects: failed("Could not load projects.") }).projects).toEqual({
      status: "error",
      message: "Could not load projects.",
    });
  });
});

describe("a project card", () => {
  const ref = RECIPE;
  const project = (overrides: Partial<ProjectRollup> = {}) =>
    rollup(ref.id, { merged: 18, executing: 4, blocked: 2, on_deck: 7 }, overrides);
  const live = (n: number) =>
    Array.from({ length: n }, (_, i) =>
      entry({ id: `live-${i}`, title: `Live ${i}`, project: ref }, [
        holder({ holderId: `agent-${i}`, lastActive: ago((i + 1) * MIN) }),
      ]),
    );
  const cardOf = (overrides: Partial<StandupData>, p: ProjectRollup = project()) =>
    projectsOf(viewOf({ projects: loadedOf({ projects: [p], childlessCount: 0 }), ...overrides }))
      .cards[0]!;

  it("carries the name, link, description, bar and last activity", () => {
    const card = cardOf({});
    expect(card).toMatchObject({
      id: ref.id,
      title: `Project ${ref.id}`,
      href: `/projects/${ref.id}`,
      headline: "A project for testing.",
      lastActive: "active 2h ago",
    });
    expect(card.bar).toMatchObject({ caption: "18 of 31 done" });

    // The description is trimmed, and a blank one reads as none.
    expect(cardOf({}, project({ headline: "  Spaced.  " })).headline).toBe("Spaced.");
    expect(cardOf({}, project({ headline: "   " })).headline).toBeNull();
    expect(cardOf({}, project({ headline: null })).headline).toBeNull();

    // An unreadable time leaves the last-activity line out. A card needs a
    // reason to exist, so give it live work.
    const unreadable = cardOf(
      { inProgress: loadedOf(column(live(1))) },
      project({ lastActivity: "?" }),
    );
    expect(unreadable.lastActive).toBeNull();
  });

  it.each([
    [10_000, "active just now"],
    [6 * MIN, "active 6m ago"],
    [3 * H, "active 3h ago"],
    [4 * DAY, "active 4 days ago"],
  ])("last activity %d ms ago reads %s", (ms, text) => {
    expect(cardOf({}, project({ lastActivity: ago(ms) })).lastActive).toBe(text);
  });

  it("lists at most two live titles, most recently active first, then how many more", () => {
    const card = cardOf({ inProgress: loadedOf(column(live(5))) });
    expect(card.liveItems).toEqual([
      { id: "live-0", title: "Live 0" },
      { id: "live-1", title: "Live 1" },
    ]);
    expect(card.moreLiveText).toBe("+3 more");
    expect(card.noOneWorking).toBe(false);
  });

  it("says no one is working only when the live read succeeded and found no one", () => {
    const idle = cardOf({});
    expect(idle).toMatchObject({ liveItems: [], moreLiveText: null, noOneWorking: true });

    // A failed read is an unknown: nothing to say, certainly not "no one".
    const unknown = cardOf({ inProgress: failed() });
    expect(unknown).toMatchObject({ liveItems: null, noOneWorking: false });
  });

  it("badges what needs the reader and what is stuck in words, singular and plural", () => {
    const withNeeds = (n: number) =>
      loadedOf({
        items: Array.from({ length: n }, (_, i) => needs({ id: `n${i}`, project: ref })),
        total: n,
      });
    const stuckEntries = (n: number) =>
      loadedOf(
        column(
          Array.from({ length: n }, (_, i) =>
            entry({ id: `s${i}`, state: "blocked", blockedOnType: "time", project: ref }),
          ),
        ),
      );
    const one = cardOf({ needsYou: withNeeds(1), waiting: stuckEntries(1) });
    expect(one).toMatchObject({
      needsYouBadge: "1 needs you",
      stuckBadge: "1 stuck",
      flagged: true,
    });
    const two = cardOf({ needsYou: withNeeds(2), waiting: stuckEntries(2) });
    expect(two).toMatchObject({ needsYouBadge: "2 need you", stuckBadge: "2 stuck" });
    const none = cardOf({});
    expect(none).toMatchObject({ needsYouBadge: null, stuckBadge: null, flagged: false });
  });

  it("shows no badge, rather than a zero, when what it counts could not be read", () => {
    const card = cardOf({ needsYou: failed(), waiting: failed(), inProgress: failed() });
    expect(card).toMatchObject({
      needsYouCount: null,
      stuckCount: null,
      needsYouBadge: null,
      stuckBadge: null,
      flagged: false,
    });
    // The card still shows: its bar and description do not depend on those reads.
    expect(card.bar).not.toBeNull();
  });

  it("does not count a paused or reader-blocked item as stuck on the card", () => {
    const card = cardOf({
      waiting: loadedOf(
        column([
          entry({ id: "p", state: "paused", project: ref }),
          entry({
            id: "m",
            state: "blocked",
            blockedOnType: "person",
            blockedOnPersonId: VIEWER,
            project: ref,
          }),
        ]),
      ),
    });
    expect(card.stuckCount).toBe(0);
    expect(card.stuckBadge).toBeNull();
  });
});

// ── Done since the cutoff, and spend ────────────────────────────────────

describe("Done since the cutoff", () => {
  const withMerges = (...merged: OvernightLine[]) =>
    viewOf({ overnight: loadedOf(report({ merged })) });

  it("lists the newest first with title, project and local time, and links to the item", () => {
    const ts = new Date(2026, 7, 19, 8, 12).toISOString();
    const done = doneOf(
      withMerges(
        line({
          itemId: "older",
          itemTitle: "Older",
          ts: new Date(2026, 7, 18, 23, 2).toISOString(),
        }),
        line({ itemId: "newer", itemTitle: "Newer", ts, project: RECIPE }),
      ),
    );
    expect(done.rows.map((row) => row.itemId)).toEqual(["newer", "older"]);
    expect(done.rows[0]).toEqual({
      itemId: "newer",
      title: "Newer",
      href: "/items/newer",
      project: RECIPE,
      time: "08:12",
    });
    expect(done.rows[1]!.time).toBe("23:02");
    expect(done.total).toEqual({ count: 2, atLeast: false });
  });

  it("counts an item merged twice as one thing finished", () => {
    const view = withMerges(line({ itemId: "x" }), line({ itemId: "x", ts: ago(H) }));
    expect(doneOf(view).total.count).toBe(1);
    expect(view.sentence.text).toContain("1 thing was finished");
  });

  it("does not collapse events that name no item, and titles them plainly", () => {
    const done = doneOf(
      withMerges(line({ itemId: null, itemTitle: null }), line({ itemId: null, itemTitle: null })),
    );
    expect(done.total.count).toBe(2);
    expect(done.rows[0]).toMatchObject({ title: "Untitled", href: null });
  });

  it("lists six and points to the rest in the activity log", () => {
    const merges = Array.from({ length: MAX_DONE_ROWS + 3 }, (_, n) =>
      line({ itemId: `d${n}`, ts: ago((n + 1) * MIN) }),
    );
    const done = doneOf(withMerges(...merges));
    expect(done.rows).toHaveLength(MAX_DONE_ROWS);
    expect(done.footerText).toBe("3 more in the activity log");
    expect(done.empty).toBe(false);
  });

  it("shows the count and the 'more' as floors when the read was capped", () => {
    const merges = Array.from({ length: MAX_DONE_ROWS + 3 }, (_, n) =>
      line({ itemId: `d${n}`, ts: ago((n + 1) * MIN) }),
    );
    const view = viewOf({ overnight: loadedOf(report({ merged: merges, eventsTruncated: true })) });
    expect(doneOf(view).total).toEqual({ count: 9, atLeast: true });
    expect(doneOf(view).footerText).toBe("3+ more in the activity log");
    expect(view.sentence.text).toContain("9+ things were finished");
  });

  it("is empty only when the read was complete and found nothing", () => {
    const none = doneOf(withMerges());
    expect(none).toMatchObject({ empty: true, rows: [], footerText: "Activity log" });
    expect(withMerges().sentence.text).toContain("nothing was finished since yesterday evening");

    // A truncated read that found nothing has not shown there is nothing.
    const unsure = doneOf(viewOf({ overnight: loadedOf(report({ eventsTruncated: true })) }));
    expect(unsure.empty).toBe(false);
    expect(unsure.footerText).toBe("More in the activity log");
  });

  it("is an error section when the events read failed, and the sentence drops its clause", () => {
    const view = viewOf({ overnight: failed("Could not load what's new.") });
    expect(view.done).toEqual({ status: "error", message: "Could not load what's new." });
    expect(view.sentence.text).not.toMatch(/finished/);
  });
});

describe("spend", () => {
  const spendOf = (overrides: Partial<OvernightReport>, now = NOW) =>
    viewOf({ overnight: loadedOf(report(overrides)) }, now).spend;

  it("is a small line when it is known", () => {
    expect(spendOf({ cost: 18.4 })).toBe("Spent since 18:00 yesterday: ~$18.40");
    expect(spendOf({ cost: 0.5 })).toBe("Spent since 18:00 yesterday: ~$0.50");
  });

  it("names this evening once the window opened on the same day", () => {
    const evening = new Date(2026, 7, 19, 20, 30).getTime();
    expect(spendOf({ cost: 6.1 }, evening)).toBe("Spent since 18:00 this evening: ~$6.10");
  });

  it("is absent, with no explanation, when it is unknown", () => {
    expect(spendOf({ cost: null })).toBeNull();
    expect(spendOf({ cost: null, costUnavailable: true })).toBeNull();
    expect(spendOf({ cost: 3, costUnavailable: true })).toBeNull();
    expect(viewOf({ overnight: failed() }).spend).toBeNull();
  });
});

describe("the page as a whole", () => {
  it("carries the date line and every section for a quiet, empty board", () => {
    const view = viewOf();
    expect(view.dateLine).toBe("Wednesday 19 August");
    expect(view.sentence.text).toBe(
      "Nothing needs you. No agents are working right now, and nothing was finished since yesterday evening.",
    );
    expect(view.needsYou.status).toBe("loaded");
    expect(view.stuck.status).toBe("loaded");
    expect(view.projects.status).toBe("loaded");
    expect(view.done.status).toBe("loaded");
  });

  it("fails each section on its own, leaving the others whole", () => {
    const view = viewOf({
      needsYou: failed("a"),
      projects: failed("b"),
      overnight: failed("c"),
      waiting: failed("d"),
      inProgress: failed("e"),
    });
    expect(view.needsYou.status).toBe("error");
    expect(view.projects.status).toBe("error");
    expect(view.done.status).toBe("error");
    expect(view.stuck.status).toBe("error");

    const onlyProjects = viewOf({ projects: failed("b") });
    expect(onlyProjects.needsYou.status).toBe("loaded");
    expect(onlyProjects.stuck.status).toBe("loaded");
    expect(onlyProjects.done.status).toBe("loaded");
  });

  it("treats the page as failed only when every section failed", () => {
    const all = standup({
      needsYou: failed("needs"),
      projects: failed("projects"),
      overnight: failed("overnight"),
      waiting: failed("waiting"),
      inProgress: failed("in progress"),
    });
    expect(everySectionFailed(all)).toBe(true);
    expect(pageErrorMessage(all)).toBe("needs");
    expect(pageErrorMessage({ ...all, needsYou: loadedOf({ items: [], total: 0 }) })).toBe(
      "overnight",
    );

    // Four of five failing is still a page of sections, one of which works.
    const fourOfFive = { ...all, projects: loadedOf({ projects: [], childlessCount: 0 }) };
    expect(everySectionFailed(fourOfFive)).toBe(false);
    expect(everySectionFailed(standup())).toBe(false);
  });

  it("does not mutate the data it is given", () => {
    const data = standup({
      needsYou: loadedOf({
        items: [needs({ id: "b", updatedAt: ago(H) }), needs({ id: "a", updatedAt: ago(5 * H) })],
        total: 2,
      }),
      overnight: loadedOf(
        report({
          merged: [line({ itemId: "x", ts: ago(H) }), line({ itemId: "y", ts: ago(2 * H) })],
        }),
      ),
    });
    const before = JSON.stringify(data);
    buildStandupView(data, NOW);
    expect(JSON.stringify(data)).toBe(before);
  });
});
