// The progress report's shape — MILESTONES.md #136.
//
// The complaint this answers is **inconsistency, not missing data**. Every
// fact below was already readable; what varied was the report, because each
// session composed one from scratch and its quality tracked that session's
// judgement — on the one artefact whose entire value is being comparable to
// the last one. Two reports a week apart could not be read side by side to
// see what moved, which is the only question a progress report is ever asked.
//
// So the shape is fixed here, in one pure function, and the operation feeds
// it. Rendering in the service rather than leaving it to the caller is the
// whole feature: a caller that formats its own report is a caller free to
// format it differently tomorrow.
//
// ── What the report answers ─────────────────────────────────────────────
//
// One question: **"where is everything I am working on, and what needs me?"**
// That is what fixes every inclusion decision below. A row earns its place by
// being work in flight; a bullet earns its place by moving something or
// blocking it. Anything that would be equally true next week is history, and
// history belongs in a different read.
//
// ── The shape, and why each part of it ──────────────────────────────────
//
// A numbered list, each row one line — a reference, a human title, a state,
// and what it is blocked on — with two or three bullets beneath saying what
// is done and what is left. Sub-bullets are reserved for the genuinely
// important and used sparingly, because a format that flags everything flags
// nothing. The number is local to the report so a row can be referred to in
// conversation ("what's the story on 3?") without anyone reading an id aloud.
//
// The bullets are the part that carries judgement, and they are deliberately
// derived rather than authored: an open loop is *already* the note a session
// wrote when it hit something worth flagging, which is exactly the
// "controversial, went with option A, option B still viable" line the format
// exists to surface. Re-asking a session to write that prose at report time
// is asking it to remember what it already recorded.

/** How a row identifies its work to a reader: a branch, or nothing yet. */
export interface ProgressReference {
  /** The branch the work is on, when there is one. */
  readonly branch: string | null;
  /** The item id, always — the fallback a reader can act on when there is no branch. */
  readonly itemId: string;
}

/** One numbered row: one piece of work, one line. */
export interface ProgressRow {
  /** 1..n, local to this report — see the module header. */
  readonly n: number;
  readonly itemId: string;
  /** The human title, per #131's convention. */
  readonly title: string;
  /** The state, spelled as the state machine spells it. */
  readonly state: string;
  readonly reference: ProgressReference;
  /**
   * What is stopping this, in a reader's words, or null when nothing is.
   *
   * Assembled from the item's own blocked/paused columns rather than from a
   * dependency graph, because the graph does not exist — an item records
   * what it is blocked on, and that is the honest answer available.
   */
  readonly blockedOn: string | null;
  /** Two or three lines on what is done and what is left. */
  readonly bullets: readonly string[];
  /**
   * The few things worth flagging under a bullet — a decision taken to
   * unblock that someone may want to revisit. Empty far more often than not,
   * which is the intent.
   */
  readonly flags: readonly string[];
}

/** The whole report, as the operation returns it. */
export interface ProgressReport {
  readonly sessionId: string;
  readonly rows: readonly ProgressRow[];
  /** The BLUF above the list: what this session is carrying, in one line. */
  readonly summary: string;
  /** The same report as text, in the fixed shape — see `renderProgressReport`. */
  readonly report: string;
}

/**
 * The states that mean "this is finished", for counting purposes.
 *
 * Mirrors the completed board column rather than re-deciding it: a report that
 * disagreed with the board about what "done" means would be worse than no
 * report, because both are read by the same person in the same sitting.
 */
export const DONE_STATES: ReadonlySet<string> = new Set([
  "merged",
  "research_done",
  "wont_do",
  "cancelled",
]);

/** The states that mean work is stopped and waiting on something. */
export const WAITING_STATES: ReadonlySet<string> = new Set(["blocked", "paused"]);

/**
 * The one-line BLUF above the list.
 *
 * Counts rather than prose, because a count is the thing that is comparable
 * between two reports — "4 in flight, 1 waiting" read a week apart says
 * something; two differently-worded paragraphs do not.
 */
export function summarise(rows: readonly ProgressRow[]): string {
  if (rows.length === 0) {
    return "Nothing claimed by this session.";
  }

  const done = rows.filter((row) => DONE_STATES.has(row.state)).length;
  const waiting = rows.filter((row) => WAITING_STATES.has(row.state)).length;
  const active = rows.length - done - waiting;

  const parts: string[] = [];
  if (active > 0) parts.push(`${active} in flight`);
  if (waiting > 0) parts.push(`${waiting} waiting`);
  if (done > 0) parts.push(`${done} done`);

  const noun = rows.length === 1 ? "item" : "items";
  return `${rows.length} ${noun}: ${parts.join(", ")}.`;
}

/** The reference as it appears at the head of a row. */
function renderReference(reference: ProgressReference): string {
  return reference.branch ?? reference.itemId;
}

/**
 * The report as text, in the shape every report shares.
 *
 * Markdown, because the surfaces that display this render it — and because
 * the reference is the one element a reader wants to act on, which a link or
 * a code span makes clickable or copyable rather than something to retype.
 *
 * A single function so the shape has exactly one definition. The structured
 * rows travel beside this string rather than instead of it: a caller that
 * wants to build its own view has the data, and a caller that just wants the
 * report does not have to.
 */
export function renderProgressReport(rows: readonly ProgressRow[], summary: string): string {
  const lines: string[] = [summary];

  for (const row of rows) {
    lines.push("");
    const blocked = row.blockedOn === null ? "" : ` - Blocked on ${row.blockedOn}`;
    lines.push(
      `${row.n}. \`${renderReference(row.reference)}\` ${row.title} - ${row.state}${blocked}`,
    );
    for (const bullet of row.bullets) {
      lines.push(`- ${bullet}`);
    }
    for (const flag of row.flags) {
      lines.push(`  - ${flag}`);
    }
  }

  return lines.join("\n");
}
