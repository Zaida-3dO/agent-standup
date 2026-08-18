// `search` — MILESTONES.md #105. Finding one item by what it is about.
//
// **The question this answers is not the one the list reads answer.** A
// board read answers "what is being worked on" and a list read answers
// "which items match these criteria" — both are questions about a *set*,
// and both are correctly bounded to a slice of it. Neither can answer
// "there is a task about the hook script somewhere", because the caller
// does not know the item's id, its state, its area or its repo; it knows a
// phrase. Without this operation the only way to answer that is to pull
// every item and read them, which is precisely the read that does not fit.
//
// **The default read routes here, so this has to exist for that route to
// be honest.** A bounded read states what it withheld and names the call
// that returns it, and for "one specific item" that call is this one. A
// route pointing at nothing is worse than no route: it reads as an answer.
//
// **Every state is in scope by default, and that is the deliberate
// difference from every other read here.** The list reads exclude finished
// work because a caller asking an open question is asking about open work.
// A caller who types a phrase is asking a *closed* question — they have one
// item in mind and want it — and the item is at least as likely to be
// merged as executing, since most items eventually are. Defaulting to open
// work would answer "there is no such task" for a task that exists, which
// is the failure mode a search is least able to tolerate: an empty result
// is indistinguishable from a filtered one. `state` narrows explicitly for
// the caller that wants it.
//
// **Title and body first, deliberately** (the row's own scoping).
// Checkpoints, events and artifacts are a substantially larger corpus and a
// substantially larger piece of work; they are worth attempting once this
// cheap index is shown to be insufficient. `headline` is included beside
// title and body because it is a one-line BLUF written to say what the item
// is — the single most searchable sentence on the row — and indexing it
// costs one more column in a `WHERE` that already reads two.
//
// **The results are slim, and for this read that is not merely a size
// decision.** A ranked list is a list of candidates a caller picks from,
// so what each row needs to carry is enough to be recognised — id, title,
// state, headline, and a short excerpt showing where the query hit. Whole
// records would defeat the purpose: a hundred matches carrying bodies is
// the payload that made "read everything and look" untenable in the first
// place, and search would inherit the problem it exists to solve. A caller
// that has found its item reads it with `get_item`.
import { z } from "zod";
import { defineOperation } from "../operation";
import type { ServiceContext } from "../context";
import { TERMINAL_STATES } from "../board/columns";
import { areaFilterCondition } from "../items/area-filter";
import { NOT_ARCHIVED_CONDITION } from "../items/row";
import { buildExcerpt, rankMatch, type MatchField } from "../items/search-rank";

/**
 * The shortest query this accepts.
 *
 * A one-character substring matches a large fraction of any corpus, so it
 * returns the size-bounded maximum in an arbitrary order — a response that
 * looks like a result set and is really a slice of the whole table. Two
 * characters is still short enough for a real query (`ci`, `db`, `ui`) and
 * long enough that the match means something.
 */
export const MIN_QUERY_CHARS = 2;

/**
 * The default and maximum page for a search.
 *
 * `MAX_SEARCH_LIMIT` matches the ceiling every other paginated read here
 * uses, so a caller who wants a big page gets the same number everywhere
 * rather than one per operation. The default is smaller than a list's
 * because a ranked result is read from the top: a caller looking for one
 * item finds it in the first few rows or refines the query, and twenty
 * candidates is already more than anyone reads before doing so.
 */
export const DEFAULT_SEARCH_LIMIT = 20;
export const MAX_SEARCH_LIMIT = 200;

/**
 * How many matching rows are ranked before the page is cut.
 *
 * Ranking happens in the application (see `search-rank.ts`), so the rows to
 * rank have to be fetched — and fetching every match on a broad query is
 * exactly the unbounded read this milestone exists to prevent. So the SQL
 * takes a hard ceiling: at most this many matches are considered, the best
 * `limit` of them are returned, and `truncated` says outright when the
 * ceiling was hit. That is a real limitation and it is reported rather than
 * hidden — a caller told its query was too broad can narrow it, where a
 * caller silently handed the "best" of an arbitrary subset cannot.
 *
 * The rows are read in a stable, meaningful order (newest first) so that a
 * truncated candidate set is the most recent matches rather than whatever
 * the scan happened to reach first.
 */
export const RANK_CANDIDATE_CEILING = 500;

const inputSchema = z
  .object({
    /** The text to find. Matched as a literal substring, case-insensitively, over title, headline and body. */
    query: z.string().trim().min(MIN_QUERY_CHARS),
    /**
     * Narrow to one state. Absent means **every** state, including finished
     * work — see the module header for why this read's default is the
     * opposite of the list reads'.
     */
    state: z
      .enum([
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
      ])
      .optional(),
    /** An area id. Matches an item carrying this area anywhere in its area set (SCHEMA.md §23.1). */
    area: z.string().min(1).optional(),
    repo: z.string().min(1).optional(),
    /**
     * Drop finished work from the results. Off by default — the inverse
     * default from the list reads, and spelled as its own opt-*out* rather
     * than as `includeTerminal` defaulting true, so that no caller reads
     * the same field name here and on `list_items` and assumes the same
     * behaviour.
     */
    openOnly: z.boolean().default(false),
    limit: z.number().int().min(1).max(MAX_SEARCH_LIMIT).default(DEFAULT_SEARCH_LIMIT),
  })
  .strict();

export type SearchInput = z.infer<typeof inputSchema>;

/** One ranked match — enough to recognise the item, never the whole record. */
export interface SearchMatch {
  readonly id: string;
  readonly title: string;
  readonly state: string;
  readonly headline: string | null;
  /** The strongest field the query was found in — the reason this row is here. */
  readonly matchedIn: MatchField;
  /** Relative to the other rows in this response only; not comparable across queries. */
  readonly score: number;
  /** The text around the match in `body`, or null when the match was not in the body. */
  readonly excerpt: string | null;
}

export interface SearchOutput {
  readonly matches: readonly SearchMatch[];
  /** How many rows were ranked — at most `RANK_CANDIDATE_CEILING`, never a count of the whole corpus. */
  readonly considered: number;
  /**
   * True when more rows matched than were ranked, so `matches` is the best
   * of a capped candidate set rather than of every match. A caller seeing
   * this should narrow the query rather than page onward.
   */
  readonly truncated: boolean;
  /** What to do next when the result is not what the caller wanted. Always present. */
  readonly notice: string;
}

/**
 * Escapes `%`, `_` and `\` so a query is matched literally by
 * `ILIKE ... ESCAPE` with a backslash.
 *
 * Exported for its own test. The application-side ranker independently
 * requires a literal substring match, so an unescaped pattern is filtered
 * out again before a caller sees it — which means a defect here is invisible
 * through the operation's results and can only be caught by testing this
 * function directly. Two mechanisms enforcing the same rule is the right
 * design; a test that can only see one of them is not.
 */
export function escapeLikePattern(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/**
 * The sentence every search response carries.
 *
 * Search is the one read whose *empty* result is genuinely ambiguous — "no
 * such item" and "your filters hid it" look identical — so the notice
 * states which of the two happened and names the way out. This is the same
 * self-routing principle the bounded reads apply to what they withheld,
 * reaching the case those reads do not have: a successful call that found
 * nothing.
 */
export function buildSearchNotice(
  shown: number,
  query: string,
  truncated: boolean,
  narrowed: boolean,
): string {
  if (shown === 0) {
    return narrowed
      ? `No item matches "${query}" under the filters given; searching without state, area, repo or openOnly covers every item.`
      : `No item matches "${query}" in any title, headline or body. Search matches literal text, so a shorter or differently-spelled query may find it.`;
  }
  const head = `Found ${shown} ${shown === 1 ? "item" : "items"} matching "${query}", best first; read one in full with get_item.`;
  return truncated
    ? `${head} More items matched than were ranked, so these are the best of the most recent matches — narrow the query to see the rest.`
    : head;
}

// Stryker disable all : this metadata is a module-level literal, read into
// the registry at import — before any test body runs and never re-evaluated
// — so a mutation here is unkillable by construction, NOT untested.
// `scripts/check-operation-metadata-mutants.mjs` requires this and carries
// the full reasoning.
export const search = defineOperation({
  name: "search",
  kind: "read",
  summary:
    "Finds items by text in their title, headline or body, best match first. Searches every state including finished work, unlike the list reads — pass openOnly to exclude it, or state, area and repo to narrow. Returns id, title, state, headline and an excerpt; read one in full with get_item.",
  // Stryker restore all
  input: inputSchema,
  async handler(ctx: ServiceContext, input: SearchInput): Promise<SearchOutput> {
    const conditions: string[] = [];
    const values: unknown[] = [];
    let paramIndex = 1;

    // The match itself. One parameter used three times rather than three
    // copies of the same string, so the pattern cannot drift between the
    // fields it is compared against.
    conditions.push(
      `("title" ILIKE $${paramIndex} ESCAPE '\\' OR "headline" ILIKE $${paramIndex} ESCAPE '\\' OR "body" ILIKE $${paramIndex} ESCAPE '\\')`,
    );
    values.push(`%${escapeLikePattern(input.query)}%`);
    paramIndex++;

    if (input.state !== undefined) {
      conditions.push(`"state" = $${paramIndex}::"ItemState"`);
      values.push(input.state);
      paramIndex++;
    } else if (input.openOnly) {
      // Only when the caller named no state of their own: asking for
      // `state: "merged"` and receiving nothing because `openOnly` was also
      // set would be a silently empty result, which is the hardest kind to
      // notice — the same reasoning `list_items` applies to its default.
      conditions.push(`"state" != ALL($${paramIndex}::"ItemState"[])`);
      values.push(TERMINAL_STATES);
      paramIndex++;
    }
    if (input.area !== undefined) {
      conditions.push(areaFilterCondition(paramIndex));
      values.push(input.area);
      paramIndex++;
    }
    if (input.repo !== undefined) {
      conditions.push(`"repo" = $${paramIndex}`);
      values.push(input.repo);
      paramIndex++;
    }

    // Archived rows never rank (MILESTONES.md #137). This read matters more
    // than most: it is the documented way to find a specific item, so an
    // archived duplicate surfacing here would come back in the exact tool a
    // caller uses to find the survivor it was archived in favour of.
    //
    // One extra row past the ceiling, so "more matched than we ranked" is a
    // fact this query establishes rather than an inference from the page
    // being full — a candidate set of exactly the ceiling is not evidence
    // of truncation on its own.
    values.push(RANK_CANDIDATE_CEILING + 1);
    const rows = await ctx.db.$queryRawUnsafe<
      { id: string; title: string; state: string; headline: string | null; body: string }[]
    >(
      `SELECT "id", "title", "state", "headline", "body" FROM "Item"
       WHERE ${NOT_ARCHIVED_CONDITION} AND ${conditions.join(" AND ")}
       ORDER BY "createdAt" DESC, "id" DESC
       LIMIT $${paramIndex}`,
      ...values,
    );

    const truncated = rows.length > RANK_CANDIDATE_CEILING;
    const candidates = truncated ? rows.slice(0, RANK_CANDIDATE_CEILING) : rows;

    const ranked: SearchMatch[] = [];
    for (const row of candidates) {
      const ranking = rankMatch(row, input.query);
      // A row the SQL matched always ranks, because both read the same
      // text. Skipping rather than emitting a zero-scored row is the honest
      // handling if that ever stops being true.
      if (ranking === null) continue;
      ranked.push({
        id: row.id,
        title: row.title,
        state: row.state,
        headline: row.headline,
        matchedIn: ranking.matchedIn,
        score: ranking.score,
        excerpt: buildExcerpt(row.body, input.query),
      });
    }

    // Ties broken by id so a repeated identical query returns an identical
    // ordering. Without it, two equally-scored rows could swap places
    // between calls on scan order alone, which reads as instability in the
    // result rather than as the tie it is.
    ranked.sort((a, b) => (b.score !== a.score ? b.score - a.score : a.id.localeCompare(b.id)));

    const matches = ranked.slice(0, input.limit);
    const narrowed =
      input.state !== undefined ||
      input.area !== undefined ||
      input.repo !== undefined ||
      input.openOnly;

    return {
      matches,
      considered: candidates.length,
      truncated,
      notice: buildSearchNotice(matches.length, input.query, truncated, narrowed),
    };
  },
});
