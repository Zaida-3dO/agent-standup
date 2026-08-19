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
// The reference is a **link to the open pull request** where one has been
// recorded, falling back to the branch and then to the item id. That
// fallback chain is the whole reason a link can be trusted: the report never
// composes a PR URL, so a row shows a link only when someone recorded a real
// one and it is still open. `@/lib/pull-requests` carries the argument for
// why composing from `repo` + `branch` was rejected.
//
// "Sparingly" is enforced twice, because a schema cannot enforce an adverb
// and an optional emphasis field left unbounded is on every row within a
// month. Each row takes at most `MAX_FLAGS_PER_ROW`, and the *report* takes
// at most `MAX_FLAGS_PER_REPORT` — the second cap is the one that matters,
// because a per-row cap alone still lets ten rows carry two flags each and
// leaves nothing standing out. Both are stated in `describe_tool`, and
// whatever either of them withholds is COUNTED at the foot of the report
// rather than dropped silently: a reader trusts this report without
// auditing it, so a flag that vanishes without trace is the one failure
// worse than a flag too many.
//
// The bullets are the part that carries judgement, and they are deliberately
// derived rather than authored: an open loop is *already* the note a session
// wrote when it hit something worth flagging, which is exactly the
// "controversial, went with option A, option B still viable" line the format
// exists to surface. Re-asking a session to write that prose at report time
// is asking it to remember what it already recorded.

/** How a row identifies its work to a reader: an open PR, a branch, or nothing yet. */
export interface ProgressReference {
  /**
   * The URL of the open pull request, when one has been recorded.
   *
   * Never composed — see `@/lib/pull-requests` for the argument. It is the
   * `ref` of the newest `pull_request` artifact on the item, and it is null
   * unless that artifact exists, says `open`, and carries an http(s) URL. A
   * row with a null `prUrl` is a row that falls back to its branch, which is
   * exactly what an item with no PR should read as.
   */
  readonly prUrl: string | null;
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
 * How many sub-bullets the whole report may carry.
 *
 * This is "use sparingly" made structural, and it is a **report**-level
 * budget on purpose. A per-row cap alone does not deliver sparingness: eight
 * rows carrying two flags each is sixteen flags, every row looks urgent, and
 * the one row that genuinely needs a person to look reads exactly like the
 * seven that do not. That is the failure the sub-bullet exists to prevent, so
 * bounding the report is the cap that actually prevents it.
 *
 * Three, because the flag's job is to survive a skim. A reader scanning a
 * report can hold about that many "look at this" marks before they stop
 * being marks and become the body text.
 *
 * When more flags exist than fit, they are not silently dropped — see
 * `applyFlagBudget`, which says how many it withheld and where they are.
 */
export const MAX_FLAGS_PER_REPORT = 3;

/**
 * Spends the report's flag budget across its rows, and says what it withheld.
 *
 * Rows are served in order, which is claim order — so the flags that survive
 * belong to the work this session picked up first, and the budget is spent
 * predictably rather than by a ranking the server is in no position to make.
 * Judging which of two loose ends is more urgent is exactly the authored
 * judgement the report's fixed shape exists to remove; taking them in a
 * stated order is a rule a reader can learn.
 *
 * Truncation is **announced, never silent**. A report that quietly dropped a
 * flag would be the one failure worse than showing too many: a reader trusts
 * this report precisely because they do not have to audit it, and a flag is
 * the highest-stakes thing in it. So the return carries the count withheld,
 * and the renderer states it — with `open_loops` named as where the rest are,
 * because that read is the flags' actual source and shows all of them.
 */
export function applyFlagBudget(rows: readonly ProgressRow[]): {
  readonly rows: readonly ProgressRow[];
  readonly withheld: number;
} {
  let remaining = MAX_FLAGS_PER_REPORT;
  let withheld = 0;
  const budgeted = rows.map((row) => {
    // `remaining` is decremented by what this row actually takes, so a row
    // with no flags costs nothing and does not consume another row's budget.
    const kept = row.flags.slice(0, remaining);
    withheld += row.flags.length - kept.length;
    remaining -= kept.length;
    return kept.length === row.flags.length ? row : { ...row, flags: kept };
  });
  return { rows: budgeted, withheld };
}

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

/**
 * The reference as it appears at the head of a row.
 *
 * A precedence, not a choice: the open PR is the thing a reader wants to act
 * on, the branch is what to act on when there is no PR, and the item id is
 * what is always available. Each falls through to the next, so the reference
 * is never blank.
 *
 * The PR renders as a markdown link with the branch (or the id) as its text,
 * which is what makes it *actionable* rather than merely present — "in
 * review, branch `feat/whatever`" still leaves a reader to go and find the
 * PR. The link text is the branch rather than the URL because the branch is
 * what a reader recognises; the URL is what they click.
 *
 * The honesty guarantee lives upstream, not here: `prUrl` is null unless a
 * `pull_request` artifact was recorded, is the newest one, says `open`, and
 * carries an http(s) URL. This function links whatever it is handed, and is
 * handed nothing when any of that fails.
 */
function renderReference(reference: ProgressReference): string {
  const label = reference.branch ?? reference.itemId;
  if (reference.prUrl === null) {
    return `\`${label}\``;
  }
  return `[\`${label}\`](${reference.prUrl})`;
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
export function renderProgressReport(
  rows: readonly ProgressRow[],
  summary: string,
  withheldFlags = 0,
): string {
  const lines: string[] = [summary];

  for (const row of rows) {
    lines.push("");
    const blocked = row.blockedOn === null ? "" : ` - Blocked on ${row.blockedOn}`;
    lines.push(`${row.n}. ${renderReference(row.reference)} ${row.title} - ${row.state}${blocked}`);
    for (const bullet of row.bullets) {
      lines.push(`- ${bullet}`);
    }
    for (const flag of row.flags) {
      lines.push(`  - ${flag}`);
    }
  }

  // Said once at the foot rather than per row, because it is a fact about
  // the report's budget and not about any one row — and because a reader who
  // needs the rest needs one pointer, not one per truncated row.
  if (withheldFlags > 0) {
    const noun = withheldFlags === 1 ? "flag" : "flags";
    lines.push("");
    lines.push(
      `_${withheldFlags} further ${noun} withheld to keep this report scannable — ` +
        "`open_loops` lists them all._",
    );
  }

  return lines.join("\n");
}
