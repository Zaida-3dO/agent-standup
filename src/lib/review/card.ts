// The review card on "since your last visit" — MILESTONES.md #68, and the
// flagged-run question #69 asks through it.
//
// Plain functions over plain data, so this repo's DOM-free harness
// (`vitest.config.ts`: `environment: "node"`) exercises them directly
// rather than only through a rendered component — the same split
// `@/lib/since/view.ts` and `@/lib/board/view.ts` follow. The components
// under `src/components/review/` are the thin presentational layer over
// these.
//
// ── What this module consumes rather than restates ─────────────────────
//
// The scale, the facet vocabulary, the distribution and the freeze rule all
// belong to `@/lib/scoring/run-scores.ts` (#66) and are imported, never
// re-declared. A second copy of a 1-5 scale is how two surfaces come to
// mean different things by a 3.
//
// ── The three constraints this milestone row states ────────────────────
//
// All three are load-bearing and each is enforced by a function here:
//
//   1. **Only the facets in play.** An item declares its facets sparsely
//      (SCHEMA.md §1.1a: "omit facets not in play rather than zeroing
//      them"), so the card asks about those and no others. Asking how the
//      `visual` facet went on work that had no visual dimension invites a
//      number that means nothing, and that number is indistinguishable
//      downstream from a real one.
//   2. **Never blocks Seen.** Marking something seen is always available,
//      whatever the sliders are doing. Scoring is genuinely optional —
//      `null` is a first-class outcome that SCHEMA.md §12 needs to stay
//      distinguishable from a low score.
//   3. **A flagged run asks a specific question.** Not "please score this"
//      but "we tried a cheaper model here; is this up to standard?" — see
//      `@/lib/review/flagged.ts`.
import type { Facet, RunFacetScore } from "@/lib/scoring/run-scores";
import { FACETS, isFacet, isValidRunScore } from "@/lib/scoring/run-scores";

/**
 * An item's declared difficulty — `Item.difficulty`, the sparse facet map
 * of SCHEMA.md §39.
 *
 * Sparse is the whole point: a key's ABSENCE is the statement that the
 * facet was not in play, which is why this is a partial record rather than
 * one with six required keys.
 */
export type DifficultyMap = Partial<Record<Facet, number>>;

/**
 * The facets an item actually declared, in the fixed order `FACETS` gives.
 *
 * **Order comes from `FACETS`, not from the object's own keys.** Two items
 * with the same facets would otherwise present their sliders in whatever
 * order each map happened to be built in, and a control that moves between
 * two cards is one a person mis-clicks.
 *
 * Unknown keys are dropped rather than rendered: `difficulty` is `jsonb`
 * and nothing in the database constrains its keys to the union, so a typo
 * or a facet from a future build would otherwise become a slider writing a
 * score against a facet no aggregate reads.
 *
 * A value outside 1-5 does **not** drop the facet. The difficulty rating is
 * a separate judgement from how the run went, and a malformed one is no
 * reason to stop asking a question about work that did happen.
 */
export function facetsInPlay(difficulty: DifficultyMap | null | undefined): Facet[] {
  if (difficulty === null || difficulty === undefined) return [];
  const declared = difficulty as Record<string, unknown>;
  return FACETS.filter((facet) => {
    const value = declared[facet];
    return value !== undefined && value !== null;
  });
}

/**
 * Whether there is anything to ask about at all.
 *
 * An item with no declared facets gets no sliders — and, per constraint 2,
 * that is not an error state and must not suppress the Seen action. The
 * card simply has no scoring section.
 */
export function hasAnythingToScore(difficulty: DifficultyMap | null | undefined): boolean {
  return facetsInPlay(difficulty).length > 0;
}

/**
 * One row of the review card: a facet, what the agent said, and what the
 * person has said so far.
 *
 * `userScore` is `null` until a person moves the slider. That null is the
 * value SCHEMA.md §12 needs preserved — "nobody looked" — so it is carried
 * here rather than defaulted to the agent's score for display convenience.
 * Defaulting it would make an untouched slider indistinguishable from a
 * deliberate agreement the moment anything read the rendered value back.
 */
export interface ReviewRow {
  readonly facet: Facet;
  /** The difficulty the item declared for this facet, 1-5, or null if malformed. */
  readonly difficulty: number | null;
  /** The agent's frozen self-assessment, or null if it has not graded itself. */
  readonly agentScore: number | null;
  /** What this person has scored, or null when they have not. */
  readonly userScore: number | null;
}

/**
 * Builds the card's rows from what the item declared and what is already
 * scored.
 *
 * **Driven by the declared facets, not by the score rows.** A score row for
 * a facet the item never declared is ignored, and a declared facet with no
 * score row still gets a slider (with both scores null) — because the
 * question the card asks is "how did this run go on the facets this work
 * involved", and that set is a property of the work, not of what has been
 * graded so far.
 */
export function reviewRows(
  difficulty: DifficultyMap | null | undefined,
  scores: readonly RunFacetScore[],
): ReviewRow[] {
  const byFacet = new Map<Facet, RunFacetScore>();
  for (const score of scores) {
    if (!isFacet(score.facet)) continue;
    byFacet.set(score.facet, score);
  }

  const declared = (difficulty ?? {}) as Record<string, unknown>;
  return facetsInPlay(difficulty).map((facet) => {
    const value = declared[facet];
    const existing = byFacet.get(facet);
    return {
      facet,
      difficulty: isValidRunScore(value) ? value : null,
      agentScore: existing?.agentScore ?? null,
      userScore: existing?.userScore ?? null,
    };
  });
}

/**
 * Whether marking this card seen is available.
 *
 * **Always true when a profile is chosen** — the sliders are not consulted,
 * and that is the entire point of this function existing rather than the
 * component deciding inline. The row states "never blocks Seen", so the
 * only thing Seen depends on is having somebody to attribute the read to
 * (`POST /events/{id}/seen` requires a `personId`). A future edit that made
 * this depend on a score would have to change this function, which is the
 * one thing `tests/review-card.test.ts` asserts hardest.
 */
export function canMarkSeen(personId: string | null): boolean {
  return personId !== null;
}

/** A facet and the score a person gave it — what the card sends. */
export interface SubmittedScore {
  readonly facet: Facet;
  readonly userScore: number;
}

/**
 * The scores worth sending when a card is marked seen.
 *
 * Only facets a person actually moved. An untouched slider sends nothing —
 * writing `user_score = agent_score` for it would record a deliberate
 * agreement nobody expressed, which is the strongest form of the bias
 * SCHEMA.md §12 exists to prevent. Accepting is an explicit act (see
 * `acceptedScores`), not the absence of one.
 */
export function scoresToSubmit(rows: readonly ReviewRow[]): SubmittedScore[] {
  const submitted: SubmittedScore[] = [];
  for (const row of rows) {
    if (!isValidRunScore(row.userScore)) continue;
    submitted.push({ facet: row.facet, userScore: row.userScore });
  }
  return submitted;
}

/**
 * The scores an explicit "these look right" produces — SCHEMA.md §12's
 * "on accept, write `user_score = agent_score`".
 *
 * Only facets the agent actually scored: accepting a null is not an
 * endorsement of anything, and there is no number to copy.
 *
 * §12 notes the accepted loss — a passive accept is indistinguishable from
 * dragging a slider to the same number. That is deliberate and treated as
 * equal, but it only applies to an accept somebody **pressed**; an
 * untouched card still sends nothing at all (`scoresToSubmit`).
 */
export function acceptedScores(rows: readonly ReviewRow[]): SubmittedScore[] {
  const accepted: SubmittedScore[] = [];
  for (const row of rows) {
    if (!isValidRunScore(row.agentScore)) continue;
    accepted.push({ facet: row.facet, userScore: row.agentScore });
  }
  return accepted;
}
