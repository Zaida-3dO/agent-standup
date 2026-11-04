// The Standup home's view-model: everything the page renders, derived from the
// loaded data as plain values. One function, `buildStandupView`, is the whole
// seam between the data (`./state.ts`) and the components: the components draw
// what is in here and decide nothing.
//
// Pure: no fetch, no clock (`now` is an argument), no DOM. The rules it
// enforces are the page's honesty rules, and each has a test that fails if it
// regresses:
//
//   - **An unknown is never shown as a zero.** A section whose read failed has
//     no number, and the sentence drops the clause that would have used it. A
//     capped read gives a floor, shown as "9+".
//   - **One row per item.** Two holders on one item are one row; the same item
//     on two pages of a read is one row.
//   - **Stuck is not paused.** A pause is a choice and an item blocked on the
//     reader belongs in Needs you, so neither is Stuck.
//   - **A cancelled or abandoned child is not progress.** The bars count real
//     work: cancelled and won't-do work is left out of the total altogether.
import type { BoardAssignment, BoardEntry, BoardItem } from "@/lib/board/types";
import type { NeedsYouItem, NeedsYouReason } from "@/lib/needs-you/types";
import { linksToReviews, sortByWaiting } from "@/lib/needs-you/view";
import type { ProjectRollup } from "@/lib/projects/types";
import { defaultCutoff, type OvernightLine } from "./overnight";
import type { ColumnRead, NeedsYouRead, SectionState, StandupData } from "./state";

// ── Shared types ────────────────────────────────────────────────────────

/** A project as a row names it: enough to show a name and link to it. */
export interface ProjectRef {
  readonly id: string;
  readonly title: string;
}

/** A number that may be a floor: `atLeast` means "this many, and perhaps more" (shown "9+"). */
export interface Counted {
  readonly count: number;
  readonly atLeast: boolean;
}

/** A section whose read failed: its title stays, with `message` explaining. Render the "Try again" line. */
export interface SectionErrorView {
  readonly status: "error";
  readonly message: string;
}

// ── Time ────────────────────────────────────────────────────────────────

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** Waiting longer than this turns amber. "More than a day" counts a full day. */
export const WAITING_LONG_MS = DAY;

/** A project with activity inside this window gets a card; one without is "quiet". */
export const ACTIVE_WINDOW_MS = 7 * DAY;

function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

/**
 * A length of time in the plain words the page uses: "under a minute", "40m",
 * "5h", "1 day", "3 days", "2 months", "1 year". Negative (clock skew) reads as zero.
 */
export function shortDuration(ms: number): string {
  const span = Math.max(0, ms);
  if (span < MINUTE) return "under a minute";
  if (span < HOUR) return `${Math.floor(span / MINUTE)}m`;
  if (span < DAY) return `${Math.floor(span / HOUR)}h`;
  const days = Math.floor(span / DAY);
  if (days < 30) return plural(days, "day");
  const months = Math.floor(days / 30);
  if (months < 12) return plural(months, "month");
  return plural(Math.floor(months / 12), "year");
}

/** Milliseconds from `iso` to `now`, or null when `iso` is not a date: an unknown age is not shown as zero. */
function ageMs(iso: string | null | undefined, now: number): number | null {
  if (iso === null || iso === undefined) return null;
  const then = Date.parse(iso);
  return Number.isNaN(then) ? null : Math.max(0, now - then);
}

function clock(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

/** "Wednesday 4 November", in the reader's local time. Written out so it does not depend on the runtime's locale. */
export function dateLine(now: number): string {
  const date = new Date(now);
  return `${WEEKDAYS[date.getDay()]} ${date.getDate()} ${MONTHS[date.getMonth()]}`;
}

// ── Links ───────────────────────────────────────────────────────────────

const itemHref = (id: string): string => `/items/${encodeURIComponent(id)}`;
const projectHref = (id: string): string => `/projects/${encodeURIComponent(id)}`;

// ── The sentence ────────────────────────────────────────────────────────

/**
 * How a run of the sentence is styled: `hot` is the "you are needed" accent,
 * `clear` the green all-clear, `strong` a bright number, `plain` the rest.
 * The words are always there, so no tone carries meaning on its own.
 */
export type SentenceTone = "hot" | "clear" | "strong" | "plain";

export interface SentencePart {
  readonly text: string;
  readonly tone: SentenceTone;
}

export interface SentenceView {
  /** The sentence in runs, whitespace included: joined, they are exactly `text`. Empty when every clause was dropped. */
  readonly parts: readonly SentencePart[];
  /** The whole sentence as plain text (an accessible name, or a test's handle). */
  readonly text: string;
}

export interface SentenceInput {
  /** The needs-you count, or null when that read failed (the clause is dropped). */
  readonly needs: Counted | null;
  /** Agents working and the projects they are in, or null when the in-progress read failed. */
  readonly work: { readonly agents: Counted; readonly projects: Counted } | null;
  /** Things finished since the cutoff, or null when the events read failed. */
  readonly done: Counted | null;
  /** "yesterday evening" or "this evening". */
  readonly sinceLabel: string;
}

function countText(c: Counted): string {
  return `${c.count}${c.atLeast ? "+" : ""}`;
}

/** True when a count reads as exactly one ("1", not "1+"). */
function isOne(c: Counted): boolean {
  return c.count === 1 && !c.atLeast;
}

function capitalise(parts: SentencePart[]): SentencePart[] {
  const [first, ...rest] = parts;
  if (first === undefined) return parts;
  return [{ ...first, text: first.text.charAt(0).toUpperCase() + first.text.slice(1) }, ...rest];
}

/**
 * The page in one sentence, built from whichever clauses have data.
 *
 * "4 things need you. 6 agents are working across 5 projects, and 9 things
 * were finished since yesterday evening." A clause whose data is `null` is
 * **dropped, never replaced by a zero**; a floor reads "9+". With the
 * needs-you count at zero the lead is "Nothing needs you." in the all-clear
 * tone.
 */
export function buildSentence(input: SentenceInput): SentenceView {
  const parts: SentencePart[] = [];

  if (input.needs !== null) {
    parts.push(
      input.needs.count === 0 && !input.needs.atLeast
        ? { text: "Nothing needs you.", tone: "clear" }
        : {
            text: `${countText(input.needs)} ${isOne(input.needs) ? "thing needs" : "things need"} you.`,
            tone: "hot",
          },
    );
  }

  let work: SentencePart[] | null = null;
  if (input.work !== null) {
    const { agents, projects } = input.work;
    if (agents.count === 0 && !agents.atLeast) {
      work = [{ text: "no agents are working right now", tone: "plain" }];
    } else {
      const across =
        projects.count > 0
          ? ` across ${countText(projects)} ${isOne(projects) ? "project" : "projects"}`
          : "";
      work = [
        {
          text: `${countText(agents)} ${isOne(agents) ? "agent is" : "agents are"} working${across}`,
          tone: "plain",
        },
      ];
    }
  }

  let done: SentencePart[] | null = null;
  if (input.done !== null) {
    const since = ` finished since ${input.sinceLabel}`;
    done =
      input.done.count === 0 && !input.done.atLeast
        ? [{ text: `nothing was${since}`, tone: "plain" }]
        : [
            {
              text: `${countText(input.done)} ${isOne(input.done) ? "thing" : "things"}`,
              tone: "strong",
            },
            { text: `${isOne(input.done) ? " was" : " were"}${since}`, tone: "plain" },
          ];
  }

  // The clauses after the lead sentence start a sentence of their own, so the
  // first of them is capitalised; the second joins it with ", and".
  const rest: SentencePart[] = [];
  if (work !== null && done !== null) {
    rest.push(...capitalise(work), { text: ", and ", tone: "plain" }, ...done);
  } else if (work !== null) {
    rest.push(...capitalise(work));
  } else if (done !== null) {
    rest.push(...capitalise(done));
  }
  if (rest.length > 0) {
    if (parts.length > 0) parts.push({ text: " ", tone: "plain" });
    parts.push(...rest, { text: ".", tone: "plain" });
  }

  return { parts, text: parts.map((part) => part.text).join("") };
}

// ── Needs you ───────────────────────────────────────────────────────────

/** The button's verb for each reason. The button opens the item; nothing acts inline. */
export const NEEDS_YOU_VERBS: Readonly<Record<NeedsYouReason, string>> = {
  blocked_on_you: "Answer",
  plan_review: "Review plan",
  needs_visual_review: "Take a look",
  needs_approval: "Approve",
};

/** What is being asked, in plain words, when the item gives no reason of its own. */
export const NEEDS_YOU_ASKS: Readonly<Record<NeedsYouReason, string>> = {
  blocked_on_you: "Someone is waiting on an answer from you.",
  plan_review: "The plan is written. Approving it lets the work start.",
  needs_visual_review: "Have a look and say whether it looks right.",
  needs_approval: "Finished and reviewed. It goes live once you approve it.",
};

const UNKNOWN_VERB = "Open";
const UNKNOWN_ASK = "This needs a decision from you.";

export interface NeedsYouRowView {
  readonly id: string;
  readonly title: string;
  /** Where the title and the button go: the item, at its reviews when the wait is answered there. */
  readonly href: string;
  readonly project: ProjectRef | null;
  /** The one line saying what is being asked. */
  readonly ask: string;
  /** The button's text: Answer, Review plan, Take a look or Approve. */
  readonly verb: string;
  /** "waiting 5h", or null when the item's time is unreadable (never a made-up age). */
  readonly waiting: string | null;
  /** True once the wait is a day or more: the age renders amber. */
  readonly waitingLong: boolean;
}

export type NeedsYouView =
  | SectionErrorView
  | {
      readonly status: "loaded";
      /** The server's count of everything that needs the reader; at least `rows.length`. */
      readonly total: number;
      /** Oldest wait first, one row per item. */
      readonly rows: readonly NeedsYouRowView[];
      /** True when there are more than `rows` shows: link to the full list. */
      readonly hasMore: boolean;
      /** True when nothing needs the reader: render the single calm all-clear line. */
      readonly quiet: boolean;
    };

function needsYouRow(item: NeedsYouItem, now: number): NeedsYouRowView {
  const base = itemHref(item.id);
  const known = item.reason in NEEDS_YOU_VERBS;
  const own = item.reason === "blocked_on_you" ? item.blockedReason?.trim() : undefined;
  const age = ageMs(item.updatedAt, now);
  return {
    id: item.id,
    title: item.title,
    href: linksToReviews(item) ? `${base}#reviews` : base,
    project: item.project ?? null,
    ask: own ? own : known ? NEEDS_YOU_ASKS[item.reason] : UNKNOWN_ASK,
    verb: known ? NEEDS_YOU_VERBS[item.reason] : UNKNOWN_VERB,
    waiting: age === null ? null : `waiting ${shortDuration(age)}`,
    waitingLong: age !== null && age >= WAITING_LONG_MS,
  };
}

function buildNeedsYou(section: SectionState<NeedsYouRead>, now: number): NeedsYouView {
  if (section.status === "error") return { status: "error", message: section.message };
  const seen = new Set<string>();
  const rows: NeedsYouRowView[] = [];
  for (const item of sortByWaiting(section.data.items)) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    rows.push(needsYouRow(item, now));
  }
  const total = Math.max(section.data.total, rows.length);
  return { status: "loaded", total, rows, hasMore: total > rows.length, quiet: total === 0 };
}

// ── Board entries: live work and stuck work ─────────────────────────────

/** An entry once per item (a paged read can return one twice), and never a project row. */
function distinctWork(column: ColumnRead): BoardEntry[] {
  const seen = new Set<string>();
  const out: BoardEntry[] = [];
  for (const entry of column.entries) {
    if (entry.item.kind === "project" || seen.has(entry.item.id)) continue;
    seen.add(entry.item.id);
    out.push(entry);
  }
  return out;
}

/** Holders that still count: a superseded assignment is a handover's leftover, not a holder. */
function holders(entry: BoardEntry): BoardAssignment[] {
  return entry.assignments.filter((assignment) => assignment.liveness !== "superseded");
}

interface LiveWork {
  readonly id: string;
  readonly title: string;
  readonly project: ProjectRef | null;
  /** The most recent report from a running holder, for ordering. NaN when unreadable. */
  readonly lastActive: number;
  readonly runningAgents: readonly string[];
}

/** In-progress work with at least one running holder. */
function liveWork(column: ColumnRead): LiveWork[] {
  const out: LiveWork[] = [];
  for (const entry of distinctWork(column)) {
    const running = entry.assignments.filter((assignment) => assignment.liveness === "running");
    if (running.length === 0) continue;
    out.push({
      id: entry.item.id,
      title: entry.item.title,
      project: entry.item.project ?? null,
      lastActive: Math.max(...running.map((assignment) => Date.parse(assignment.lastActive))),
      runningAgents: running
        .filter((assignment) => assignment.holderType === "agent")
        .map((assignment) => assignment.holderId),
    });
  }
  return out;
}

function byRecentThenTitle(a: LiveWork, b: LiveWork): number {
  const left = Number.isNaN(a.lastActive) ? -Infinity : a.lastActive;
  const right = Number.isNaN(b.lastActive) ? -Infinity : b.lastActive;
  if (left !== right) return right - left;
  return a.title < b.title ? -1 : a.title > b.title ? 1 : a.id < b.id ? -1 : 1;
}

export interface StuckRowView {
  readonly id: string;
  readonly title: string;
  readonly href: string;
  readonly project: ProjectRef | null;
  /** Why it is stuck: the blocker's reason, or "Its agent stopped responding." */
  readonly why: string;
  /** "4 days" for a blocked item, "quiet for 3h" for a stopped agent; null when no time is known. */
  readonly age: string | null;
  readonly kind: "blocked" | "stopped";
}

export type StuckView =
  | SectionErrorView
  | {
      readonly status: "loaded";
      /** Longest-stuck first, one row per item. Render nothing at all when empty. */
      readonly rows: readonly StuckRowView[];
      /** The panel's count: `rows.length`, as a floor when part of the evidence could not be read. */
      readonly count: Counted;
    };

export const STOPPED_WHY = "Its agent stopped responding.";

function blockedOnViewer(item: BoardItem, viewerId: string | null): boolean {
  return (
    item.blockedOnType === "person" && viewerId !== null && item.blockedOnPersonId === viewerId
  );
}

function blockedWhy(item: BoardItem): string {
  const reason = item.blockedReason?.trim();
  if (reason) return reason;
  if (item.blockedOnType === "person") return "Waiting on someone else.";
  if (item.blockedOnType === "time") return "Waiting for a set time.";
  return "Waiting on something outside.";
}

/** A stuck row with the age it was measured by, for ordering. */
interface StuckCandidate {
  readonly row: StuckRowView;
  readonly ageMs: number | null;
}

/**
 * The Stuck list: blocked items whose blocker is not the reader, plus
 * in-progress work whose every holder has gone quiet.
 *
 * **Refusals, each pinned by a test.** A paused item is not stuck (a pause is
 * a choice). An item blocked on the reader is not stuck (it is theirs, and is
 * in Needs you). An item that Needs you lists is not repeated here. An
 * in-progress item with any running holder is not stuck, and one with no
 * holder at all is merely unclaimed.
 *
 * If one of the two reads failed, the rows from the other still show, as a
 * floor; if nothing was found and part of the evidence is missing, the
 * section is an error, because "nothing stuck" would be a claim about data
 * that was never read.
 */
function buildStuck(
  waiting: SectionState<ColumnRead>,
  inProgress: SectionState<ColumnRead>,
  needsYouIds: ReadonlySet<string> | null,
  viewerId: string | null,
  now: number,
): StuckView {
  const candidates: StuckCandidate[] = [];

  if (waiting.status === "loaded") {
    for (const entry of distinctWork(waiting.data)) {
      const item = entry.item;
      if (item.state !== "blocked" || blockedOnViewer(item, viewerId)) continue;
      const age = ageMs(item.updatedAt, now);
      candidates.push({
        ageMs: age,
        row: {
          id: item.id,
          title: item.title,
          href: itemHref(item.id),
          project: item.project ?? null,
          why: blockedWhy(item),
          age: age === null ? null : shortDuration(age),
          kind: "blocked",
        },
      });
    }
  }

  if (inProgress.status === "loaded") {
    for (const entry of distinctWork(inProgress.data)) {
      const held = holders(entry);
      if (held.length === 0) continue;
      if (!held.every((a) => a.liveness === "stalled" || a.liveness === "dead")) continue;
      // How long since the most recent holder reported.
      const reports = held
        .map((assignment) => ageMs(assignment.lastActive, now))
        .filter((age): age is number => age !== null);
      const age = reports.length === 0 ? null : Math.min(...reports);
      candidates.push({
        ageMs: age,
        row: {
          id: entry.item.id,
          title: entry.item.title,
          href: itemHref(entry.item.id),
          project: entry.item.project ?? null,
          why: STOPPED_WHY,
          age: age === null ? null : `quiet for ${shortDuration(age)}`,
          kind: "stopped",
        },
      });
    }
  }

  const failed = [waiting, inProgress].find((section) => section.status === "error");
  const kept = candidates.filter((c) => needsYouIds === null || !needsYouIds.has(c.row.id));
  if (failed !== undefined && failed.status === "error" && kept.length === 0) {
    return { status: "error", message: failed.message };
  }

  // Longest-stuck first; an unknown age sorts last rather than first.
  kept.sort((a, b) => {
    if (a.ageMs !== b.ageMs) {
      if (a.ageMs === null) return 1;
      if (b.ageMs === null) return -1;
      return b.ageMs - a.ageMs;
    }
    return a.row.title < b.row.title
      ? -1
      : a.row.title > b.row.title
        ? 1
        : a.row.id < b.row.id
          ? -1
          : 1;
  });
  const rows = kept.map((c) => c.row);

  const capped =
    (waiting.status === "loaded" && waiting.data.capped) ||
    (inProgress.status === "loaded" && inProgress.data.capped);
  return {
    status: "loaded",
    rows,
    count: { count: rows.length, atLeast: capped || failed !== undefined },
  };
}

// ── Projects ────────────────────────────────────────────────────────────

/** How many project cards show; further active projects are listed by name. */
export const MAX_PROJECT_CARDS = 12;
/** How many live items a card lists before "+N more". */
export const MAX_LIVE_ITEMS = 2;

/**
 * A project's bar, from its rollup counts. Four groups of states, and a total
 * that **leaves out cancelled and won't-do work**, so "18 of 31 done" means
 * real results out of real work:
 *
 *   - done: merged + research_done
 *   - in progress: planning + plan_review + executing + in_review
 *   - stuck or paused: blocked + paused
 *   - to do: on_deck + someday
 */
export interface ProjectBarView {
  readonly done: number;
  readonly inProgress: number;
  readonly stuckOrPaused: number;
  readonly todo: number;
  readonly total: number;
  /** Widths as percentages of `total` (0 to 100) for the three coloured parts; the rest is the empty track. */
  readonly doneWidth: number;
  readonly inProgressWidth: number;
  readonly stuckWidth: number;
  /** "18 of 31 done". */
  readonly caption: string;
  /** The bar's text alternative: "18 of 31 done, 4 in progress, 2 stuck or paused" (zero parts left out). */
  readonly ariaLabel: string;
}

type CountsLike = Readonly<Partial<Record<string, number>>> | null | undefined;

function stateCount(counts: Exclude<CountsLike, null | undefined>, state: string): number {
  const value = counts[state];
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * The bar for one project's counts, or null when there is no countable work
 * (no counts at all, or only cancelled and won't-do children): the card then
 * shows no bar and no "x of y done", rather than "0 of 0".
 */
export function barOf(counts: CountsLike): ProjectBarView | null {
  if (counts === null || counts === undefined) return null;
  const done = stateCount(counts, "merged") + stateCount(counts, "research_done");
  const inProgress =
    stateCount(counts, "planning") +
    stateCount(counts, "plan_review") +
    stateCount(counts, "executing") +
    stateCount(counts, "in_review");
  const stuckOrPaused = stateCount(counts, "blocked") + stateCount(counts, "paused");
  const todo = stateCount(counts, "on_deck") + stateCount(counts, "someday");
  const total = done + inProgress + stuckOrPaused + todo;
  if (total === 0) return null;

  const label = [`${done} of ${total} done`];
  if (inProgress > 0) label.push(`${inProgress} in progress`);
  if (stuckOrPaused > 0) label.push(`${stuckOrPaused} stuck or paused`);
  return {
    done,
    inProgress,
    stuckOrPaused,
    todo,
    total,
    doneWidth: (done / total) * 100,
    inProgressWidth: (inProgress / total) * 100,
    stuckWidth: (stuckOrPaused / total) * 100,
    caption: `${done} of ${total} done`,
    ariaLabel: label.join(", "),
  };
}

export interface ProjectCardView {
  readonly id: string;
  readonly title: string;
  readonly href: string;
  /** The one-line description, or null when none is written. */
  readonly headline: string | null;
  /** Needs-you items in this project; null when that read failed (render no badge). */
  readonly needsYouCount: number | null;
  /** Stuck items in this project; null when the stuck evidence failed entirely. */
  readonly stuckCount: number | null;
  /** "1 needs you" / "2 need you"; null when there are none or the count is unknown. */
  readonly needsYouBadge: string | null;
  /** "1 stuck" / "2 stuck"; null likewise. */
  readonly stuckBadge: string | null;
  /** True when something here needs the reader: the card gets the accent border. */
  readonly flagged: boolean;
  /**
   * Up to two live titles, most recently active first; **null when the live
   * read failed**, in which case render nothing (not "No one is working on
   * it"). An empty array means nobody is.
   */
  readonly liveItems: readonly { readonly id: string; readonly title: string }[] | null;
  /** "+3 more" for live items beyond those listed; null when there are none. */
  readonly moreLiveText: string | null;
  /** True when the live read succeeded and found nothing: show "No one is working on it right now." */
  readonly noOneWorking: boolean;
  /** Null when there is no countable work. */
  readonly bar: ProjectBarView | null;
  /** "active 6m ago" / "active just now"; null when the activity time is unreadable. */
  readonly lastActive: string | null;
}

export interface ProjectNameView {
  readonly id: string;
  readonly title: string;
  readonly href: string;
}

export type ProjectsView =
  | SectionErrorView
  | {
      readonly status: "loaded";
      /** True when there is nothing to show in any of the lists below: render "No projects yet…" with a link to /projects. */
      readonly empty: boolean;
      /** Projects that get a card or sit under "Also active": the "N active" in the heading. */
      readonly activeCount: Counted;
      /** "7 active" / "200+ active". */
      readonly activeText: string;
      /** At most `MAX_PROJECT_CARDS`, most-needing-you first. */
      readonly cards: readonly ProjectCardView[];
      /** Active projects beyond the cards, by name, in card order. Empty when all fit. */
      readonly alsoActive: readonly ProjectNameView[];
      /** Open work but no activity this week, no live work, nothing for the reader. By name. */
      readonly quiet: readonly ProjectNameView[];
      /** No children at all. By name. */
      readonly notStarted: readonly ProjectNameView[];
    };

function badge(count: number | null, one: string, many: string): string | null {
  if (count === null || count === 0) return null;
  return count === 1 ? `1 ${one}` : `${count} ${many}`;
}

function activeAgo(iso: string, now: number): string | null {
  const age = ageMs(iso, now);
  if (age === null) return null;
  return age < MINUTE ? "active just now" : `active ${shortDuration(age)} ago`;
}

function nameOf(project: ProjectRollup): ProjectNameView {
  return { id: project.id, title: project.title, href: projectHref(project.id) };
}

function byTitle(a: ProjectNameView, b: ProjectNameView): number {
  const left = a.title.toLowerCase();
  const right = b.title.toLowerCase();
  return left < right ? -1 : left > right ? 1 : a.id < b.id ? -1 : 1;
}

/** Work a project still has to do: everything that is neither done nor abandoned. */
function openWork(bar: ProjectBarView | null): number {
  return bar === null ? 0 : bar.inProgress + bar.stuckOrPaused + bar.todo;
}

interface ProjectDecoration {
  readonly needsYou: number | null;
  readonly stuck: number | null;
  readonly live: readonly LiveWork[] | null;
}

function buildProjects(
  section: SectionState<{
    readonly projects: readonly ProjectRollup[];
    readonly nextCursor?: string;
  }>,
  decorate: (projectId: string) => ProjectDecoration,
  now: number,
): ProjectsView {
  if (section.status === "error") return { status: "error", message: section.message };

  const seen = new Set<string>();
  const projects = section.data.projects.filter((project) => {
    if (seen.has(project.id)) return false;
    seen.add(project.id);
    return true;
  });

  interface Ranked {
    readonly project: ProjectRollup;
    readonly bar: ProjectBarView | null;
    readonly decoration: ProjectDecoration;
    readonly active: number;
  }
  const cardWorthy: Ranked[] = [];
  const quiet: ProjectNameView[] = [];
  const notStarted: ProjectNameView[] = [];

  for (const project of projects) {
    const bar = barOf(project.counts);
    const decoration = decorate(project.id);
    const attention =
      (decoration.needsYou ?? 0) > 0 ||
      (decoration.stuck ?? 0) > 0 ||
      (decoration.live ?? []).length > 0;
    const activity = Date.parse(project.lastActivity);
    const ranked: Ranked = {
      project,
      bar,
      decoration,
      active: Number.isNaN(activity) ? -Infinity : activity,
    };

    if (attention) {
      cardWorthy.push(ranked);
    } else if (project.childless || project.total <= 0) {
      notStarted.push(nameOf(project));
    } else if (openWork(bar) === 0) {
      // Every child is done or abandoned: a finished project, which the page hides.
    } else if (now - ranked.active <= ACTIVE_WINDOW_MS) {
      cardWorthy.push(ranked);
    } else {
      quiet.push(nameOf(project));
    }
  }

  cardWorthy.sort((a, b) => {
    const need = (b.decoration.needsYou ?? 0) - (a.decoration.needsYou ?? 0);
    if (need !== 0) return need;
    const stuck = (b.decoration.stuck ?? 0) - (a.decoration.stuck ?? 0);
    if (stuck !== 0) return stuck;
    const live = (b.decoration.live ?? []).length - (a.decoration.live ?? []).length;
    if (live !== 0) return live;
    if (a.active !== b.active) return a.active > b.active ? -1 : 1;
    return byTitle(nameOf(a.project), nameOf(b.project));
  });

  const cards: ProjectCardView[] = cardWorthy.slice(0, MAX_PROJECT_CARDS).map((ranked) => {
    const { project, bar, decoration } = ranked;
    const live = decoration.live === null ? null : [...decoration.live].sort(byRecentThenTitle);
    const needsYou = decoration.needsYou;
    return {
      id: project.id,
      title: project.title,
      href: projectHref(project.id),
      headline: project.headline?.trim() || null,
      needsYouCount: needsYou,
      stuckCount: decoration.stuck,
      needsYouBadge: badge(needsYou, "needs you", "need you"),
      stuckBadge: badge(decoration.stuck, "stuck", "stuck"),
      flagged: (needsYou ?? 0) > 0,
      liveItems:
        live === null
          ? null
          : live.slice(0, MAX_LIVE_ITEMS).map((item) => ({ id: item.id, title: item.title })),
      moreLiveText:
        live !== null && live.length > MAX_LIVE_ITEMS
          ? `+${live.length - MAX_LIVE_ITEMS} more`
          : null,
      noOneWorking: live !== null && live.length === 0,
      bar,
      lastActive: activeAgo(project.lastActivity, now),
    };
  });
  const alsoActive = cardWorthy.slice(MAX_PROJECT_CARDS).map((ranked) => nameOf(ranked.project));

  const activeCount: Counted = {
    count: cardWorthy.length,
    atLeast: section.data.nextCursor !== undefined,
  };
  return {
    status: "loaded",
    empty:
      cards.length === 0 &&
      alsoActive.length === 0 &&
      quiet.length === 0 &&
      notStarted.length === 0,
    activeCount,
    activeText: `${countText(activeCount)} active`,
    cards,
    alsoActive,
    quiet: quiet.sort(byTitle),
    notStarted: notStarted.sort(byTitle),
  };
}

// ── Done since the cutoff, and spend ────────────────────────────────────

/** How many finished titles the Done panel lists before the "more" link. */
export const MAX_DONE_ROWS = 6;

export interface DoneRowView {
  readonly itemId: string | null;
  readonly title: string;
  /** The item page, or null when the event named no item. */
  readonly href: string | null;
  readonly project: ProjectRef | null;
  /** "08:12", local time. */
  readonly time: string;
}

export type DoneView =
  | SectionErrorView
  | {
      readonly status: "loaded";
      /** Distinct items finished in the window; a floor when the read was capped. */
      readonly total: Counted;
      /** Newest first, at most `MAX_DONE_ROWS`. */
      readonly rows: readonly DoneRowView[];
      /** True when nothing finished: render "Nothing finished since yesterday evening." */
      readonly empty: boolean;
      /** The footer link's text, e.g. "3 more in the activity log" or just "Activity log". Always links to /activity. */
      readonly footerText: string;
    };

function buildDone(
  section: SectionState<{ readonly merged: readonly OvernightLine[]; eventsTruncated: boolean }>,
): DoneView {
  if (section.status === "error") return { status: "error", message: section.message };
  const seen = new Set<string>();
  const lines: OvernightLine[] = [];
  const newestFirst = [...section.data.merged].sort((a, b) =>
    a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0,
  );
  for (const line of newestFirst) {
    // The same item merged twice in the window is one thing finished.
    if (line.itemId !== null) {
      if (seen.has(line.itemId)) continue;
      seen.add(line.itemId);
    }
    lines.push(line);
  }
  const rows: DoneRowView[] = lines.slice(0, MAX_DONE_ROWS).map((line) => ({
    itemId: line.itemId,
    title: line.itemTitle?.trim() || "Untitled",
    href: line.itemId === null ? null : itemHref(line.itemId),
    project: line.project ?? null,
    time: clock(line.ts),
  }));
  const total: Counted = { count: lines.length, atLeast: section.data.eventsTruncated };
  const more = total.count - rows.length;
  return {
    status: "loaded",
    total,
    rows,
    empty: total.count === 0 && !total.atLeast,
    footerText:
      more > 0
        ? `${more}${total.atLeast ? "+" : ""} more in the activity log`
        : total.atLeast
          ? "More in the activity log"
          : "Activity log",
  };
}

// ── The whole page ──────────────────────────────────────────────────────

export interface StandupView {
  /** "Wednesday 4 November": the small line above the sentence. */
  readonly dateLine: string;
  readonly sentence: SentenceView;
  /** "yesterday evening", or "this evening" once the window opens on the same day. For the Done panel's title. */
  readonly sinceLabel: string;
  /** "Spent since 18:00 yesterday: ~$18.40", or null when spend is not known (render nothing). */
  readonly spend: string | null;
  readonly needsYou: NeedsYouView;
  readonly stuck: StuckView;
  readonly projects: ProjectsView;
  readonly done: DoneView;
}

/**
 * Everything the Standup home renders, from the loaded data.
 *
 * `now` is epoch milliseconds, sampled once per load by the container, so
 * every age on the page agrees. The data carries its own failures: a section
 * that failed comes back as `{status: "error"}` and the rest are unaffected.
 */
export function buildStandupView(data: StandupData, now: number): StandupView {
  const cutoff = new Date(defaultCutoff(new Date(now)));
  const sameDay = cutoff.toDateString() === new Date(now).toDateString();
  const sinceLabel = sameDay ? "this evening" : "yesterday evening";

  const needsYou = buildNeedsYou(data.needsYou, now);
  const needsYouIds =
    data.needsYou.status === "loaded"
      ? new Set(data.needsYou.data.items.map((item) => item.id))
      : null;
  const stuck = buildStuck(data.waiting, data.inProgress, needsYouIds, data.viewerId, now);
  const done = buildDone(data.overnight);

  // Agents and projects, from the in-progress column.
  const live = data.inProgress.status === "loaded" ? liveWork(data.inProgress.data) : null;
  const capped = data.inProgress.status === "loaded" && data.inProgress.data.capped;
  const work =
    live === null
      ? null
      : {
          agents: {
            count: new Set(live.flatMap((entry) => entry.runningAgents)).size,
            atLeast: capped,
          },
          projects: {
            count: new Set(
              live.flatMap((entry) =>
                entry.runningAgents.length > 0 && entry.project !== null ? [entry.project.id] : [],
              ),
            ).size,
            atLeast: capped,
          },
        };

  const sentence = buildSentence({
    needs: needsYou.status === "loaded" ? { count: needsYou.total, atLeast: false } : null,
    work,
    done: done.status === "loaded" ? done.total : null,
    sinceLabel,
  });

  // Per-project decoration, grouped by the root project each row carries.
  const needsByProject = new Map<string, number>();
  if (data.needsYou.status === "loaded") {
    const counted = new Set<string>();
    for (const item of data.needsYou.data.items) {
      if (!item.project || counted.has(item.id)) continue;
      counted.add(item.id);
      needsByProject.set(item.project.id, (needsByProject.get(item.project.id) ?? 0) + 1);
    }
  }
  const stuckByProject = new Map<string, number>();
  if (stuck.status === "loaded") {
    for (const row of stuck.rows) {
      if (row.project === null) continue;
      stuckByProject.set(row.project.id, (stuckByProject.get(row.project.id) ?? 0) + 1);
    }
  }
  const liveByProject = new Map<string, LiveWork[]>();
  for (const entry of live ?? []) {
    if (entry.project === null) continue;
    const list = liveByProject.get(entry.project.id) ?? [];
    list.push(entry);
    liveByProject.set(entry.project.id, list);
  }

  const projects = buildProjects(
    data.projects,
    (projectId) => ({
      needsYou: data.needsYou.status === "loaded" ? (needsByProject.get(projectId) ?? 0) : null,
      stuck: stuck.status === "loaded" ? (stuckByProject.get(projectId) ?? 0) : null,
      live: live === null ? null : (liveByProject.get(projectId) ?? []),
    }),
    now,
  );

  const report = data.overnight.status === "loaded" ? data.overnight.data : null;
  const spend =
    report !== null && !report.costUnavailable && report.cost !== null
      ? `Spent since 18:00 ${sameDay ? "today" : "yesterday"}: ~$${report.cost.toFixed(2)}`
      : null;

  return {
    dateLine: dateLine(now),
    sentence,
    sinceLabel,
    spend,
    needsYou,
    stuck,
    projects,
    done,
  };
}
