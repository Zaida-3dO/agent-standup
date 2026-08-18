// How a search result is ranked, and the excerpt that justifies its place —
// MILESTONES.md #105.
//
// Kept separate from the operation for one reason: ranking is the part of
// search with an opinion in it, and an opinion is worth testing directly
// rather than through a database. Everything here is pure, so a test can
// state "a title match outranks a body match" as an assertion about a
// function instead of seeding two rows and inferring the rule from which
// came back first.
//
// **Why a hand-written rank rather than Postgres full-text.** `to_tsvector`
// ranking is better at what it does, and it is the wrong tool for the
// question this row asks. A caller searching here knows roughly what it is
// looking for — an id fragment, a repo name, half a title it saw an hour
// ago — and wants substring behaviour: `tsquery` stems and tokenises, so
// `auth` does not match `authorisation` the way a caller typing it expects,
// and a hyphenated identifier is split into pieces that match too much. The
// match itself is therefore `ILIKE`, and what remains is ordering the rows
// it returns, which is what this module does.

/** Where in an item the query was found. The order of this list is the order of preference. */
export const MATCH_FIELDS = ["title", "headline", "body"] as const;
export type MatchField = (typeof MATCH_FIELDS)[number];

/**
 * What a field match is worth, before any bonus.
 *
 * A title is what a person names the work, so a query found there is far
 * more likely to be *the* item than the same query found in a paragraph of
 * a brief — a body mentioning "the search row" in passing is a weaker
 * answer to "find the search row" than a title that says it. Headline sits
 * between the two: written deliberately as the one-line BLUF, so a match is
 * meaningful, but it is a summary rather than the item's name.
 *
 * The gaps are wide rather than adjacent (100/40/10 rather than 3/2/1) so
 * that no accumulation of weaker signals can overtake a stronger one: an
 * item matching in body and headline should still rank below an item
 * matching in its title, because the title match is the better answer and a
 * scoring scheme where enough small evidence outvotes it would be ranking
 * by quantity of mentions rather than by quality of match.
 */
const FIELD_WEIGHT: Readonly<Record<MatchField, number>> = Object.freeze({
  title: 100,
  headline: 40,
  body: 10,
});

/**
 * The bonus for matching the whole field rather than part of it, and for
 * matching at a word boundary.
 *
 * `exact` is the case where the caller typed the item's title and means
 * that item; nothing else should come above it. `wordStart` separates
 * "search" in `search over items` from "search" inside `researcher` — the
 * substring match that makes this useful for identifier fragments also
 * makes it match inside words, and a match that begins a word is much more
 * often the one intended.
 */
const EXACT_BONUS = 150;
const WORD_START_BONUS = 25;

/** One field of one item, as the ranker receives it. */
export interface SearchableFields {
  readonly title: string;
  readonly headline: string | null;
  readonly body: string;
}

/** Why a row is in the result, and how strongly. */
export interface MatchRanking {
  readonly score: number;
  /** The strongest field this query was found in — what an interface shows as the reason. */
  readonly matchedIn: MatchField;
}

function fieldValue(fields: SearchableFields, field: MatchField): string {
  if (field === "title") return fields.title;
  if (field === "headline") return fields.headline ?? "";
  return fields.body;
}

/** Whether the character before a match is anything other than a letter or a digit. */
function isWordStart(haystack: string, at: number): boolean {
  if (at === 0) return true;
  return !/[\p{L}\p{N}]/u.test(haystack.charAt(at - 1));
}

/**
 * Scores one field's match, or 0 when the query is not in it.
 *
 * Case-insensitive, to agree with the `ILIKE` that selected the row: a
 * ranker that disagreed with the matcher about what counts as a match could
 * score a returned row zero and sort it below rows it should outrank.
 */
function scoreField(haystack: string, query: string, weight: number): number {
  if (haystack === "" || query === "") return 0;
  const lowerHaystack = haystack.toLowerCase();
  const lowerQuery = query.toLowerCase();
  const at = lowerHaystack.indexOf(lowerQuery);
  if (at === -1) return 0;

  let score = weight;
  if (lowerHaystack === lowerQuery) score += EXACT_BONUS;
  else if (isWordStart(lowerHaystack, at)) score += WORD_START_BONUS;
  return score;
}

/**
 * Ranks one row against one query.
 *
 * Returns `null` when the query appears in none of the three fields. That
 * is not expected for a row the SQL matched — the `ILIKE` and this function
 * look at the same text — but it is the honest return for "this row does
 * not match", and the operation uses it to keep an unmatched row out of the
 * results rather than emitting one with a meaningless score.
 *
 * **The score is a sum across fields, and the reported field is the
 * strongest single one.** An item whose title *and* body both mention the
 * query is a better answer than one where only the title does, so the
 * evidence accumulates; but the reason shown to a caller is the best place
 * it was found, because "matched in title" is a useful thing to be told and
 * "matched in title, headline and body" is noise on a one-line result.
 */
export function rankMatch(fields: SearchableFields, query: string): MatchRanking | null {
  let total = 0;
  let best: MatchField | null = null;
  let bestScore = 0;

  for (const field of MATCH_FIELDS) {
    const score = scoreField(fieldValue(fields, field), query, FIELD_WEIGHT[field]);
    if (score === 0) continue;
    total += score;
    if (score > bestScore) {
      bestScore = score;
      best = field;
    }
  }

  if (best === null) return null;
  return { score: total, matchedIn: best };
}

/** How much of the surrounding text an excerpt carries on each side of the match. */
const EXCERPT_CONTEXT = 60;

/**
 * The snippet of `body` around the match — the line that shows a caller
 * *why* a row came back.
 *
 * **This is the one place search is allowed to truncate**, and it is worth
 * being explicit about why that does not contradict the house rule that a
 * read refuses rather than trims. That rule protects a caller from
 * receiving a *value* silently altered from the one stored. An excerpt is
 * not the body under another name — it is a distinct, derived field that
 * exists to be short, and the whole body remains available from `get_item`.
 * Returning bodies in full is what would make search unusable: a hundred
 * matches at kilobytes each is the payload the bounded reads exist to stop.
 *
 * Returns `null` when the query is not in the body, rather than an
 * arbitrary opening slice — a leading excerpt that does not contain the
 * match looks like evidence and is not.
 */
export function buildExcerpt(body: string, query: string): string | null {
  if (body === "" || query === "") return null;
  const at = body.toLowerCase().indexOf(query.toLowerCase());
  if (at === -1) return null;

  const start = Math.max(0, at - EXCERPT_CONTEXT);
  const end = Math.min(body.length, at + query.length + EXCERPT_CONTEXT);
  // Ellipses only where text was actually removed, so the excerpt does not
  // claim a truncation that did not happen.
  return `${start > 0 ? "…" : ""}${body.slice(start, end)}${end < body.length ? "…" : ""}`;
}
