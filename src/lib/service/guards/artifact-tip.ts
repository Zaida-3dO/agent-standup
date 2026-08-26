// The shared "what is the tip commit, and is this artifact at it" primitive.
// See docs/plans/MILESTONES.md #17, SCHEMA.md §6 (`artifacts.commit_sha` —
// "What it applies to — the 'at tip' check") and §16.
//
// Exported standalone, not folded into one guard's `check`, because #18's
// merge guard needs exactly this same comparison ("an approving `code-review`
// artifact at the current `max(artifacts.review_round)`" is the review-round
// shape of the same question this module answers for commits) and MILESTONES
// #17's own row says to "keep the artifact-checking surface reusable."
import type { TransactionHandle } from "../context";
import { APPROVING_VERDICTS } from "../../verdicts";

/** The one row shape every function here reads out of `"Artifact"`. */
interface ArtifactRow {
  id: string;
  kind: string;
  verdict: string | null;
  commitSha: string | null;
  createdAt: Date;
}

/**
 * How many supersession hops the walk below will follow before giving up.
 *
 * A bound rather than an unbounded loop, because the chain is built from
 * caller-supplied `supersedesSha` values and nothing stops a caller — or a
 * bug — from recording a cycle (`b` supersedes `a`, `a` supersedes `b`). An
 * unbounded walk over a cycle does not return, and this code runs inside the
 * transaction that decides a merge.
 *
 * The visited-set below already breaks a true cycle; this bounds the other
 * shape, a long non-cyclic chain, and costs one query per hop on the merge
 * path. Ten is far above real use — a squash, a rebase and an amend of the
 * same work is three — and far below anything that would matter.
 */
const MAX_SUPERSESSION_HOPS = 10;

/**
 * Every sha that the item's tip commit stands in for: the tip itself, then
 * whatever each link in the supersession chain replaced, oldest-ward.
 *
 * ── What this is answering ──────────────────────────────────────────────
 *
 * "Is this approval at the tip?" is the right question, and comparing shas
 * is the wrong way to ask it whenever the repository rewrites commits.
 * A squash merge produces a sha nobody has reviewed or could have reviewed —
 * it does not exist until the merge happens — for a tree that may be
 * byte-identical to the reviewed one. Comparing the review's sha against it
 * refuses every honest caller and detects no actual staleness.
 *
 * So the comparison widens from one sha to the **set of shas the tip is
 * known to stand in for**, built by following `supersedesSha` links that the
 * merging caller recorded. An approval qualifies if it names any sha in that
 * set.
 *
 * ── Why this does not weaken the check ──────────────────────────────────
 *
 * The set only ever contains shas that some `commit` artifact explicitly
 * declared its own sha to be a rewrite of. A commit recording new work sets
 * nothing, contributes nothing to the set, and continues to invalidate every
 * earlier approval exactly as before — which is the case the guard exists
 * for. Genuine staleness (someone pushed a real change after review) is
 * unaffected, because the new commit does not claim to supersede anything.
 *
 * Returned oldest-last in a `Set`, and membership is all any caller asks.
 */
export async function tipCommitLineage(
  db: TransactionHandle,
  itemId: string,
): Promise<ReadonlySet<string>> {
  const tip = await currentTipCommitSha(db, itemId);
  const lineage = new Set<string>();
  if (tip === null) {
    return lineage;
  }
  lineage.add(tip);

  let cursor: string = tip;
  for (let hop = 0; hop < MAX_SUPERSESSION_HOPS; hop += 1) {
    const rows = await db.$queryRawUnsafe<{ supersedesSha: string | null }[]>(
      // Scoped to `kind = 'commit'`: only a commit artifact can assert that
      // one sha replaced another. A review or a screenshot carrying the
      // column would otherwise be able to extend the lineage, which is a
      // claim those kinds have no standing to make.
      `SELECT "supersedesSha"
         FROM "Artifact"
        WHERE "itemId" = $1 AND "kind" = 'commit' AND "commitSha" = $2
          AND "supersedesSha" IS NOT NULL
        ORDER BY "createdAt" DESC, "id" DESC
        LIMIT 1`,
      itemId,
      cursor,
    );
    const next = rows[0]?.supersedesSha;
    // No link recorded for this sha — the chain ends here, which is the
    // ordinary case for work that was never rewritten.
    if (next == null) {
      return lineage;
    }
    // A sha already in the set closes a cycle. Stopping rather than throwing:
    // the lineage collected so far is still true, and a merge decision should
    // not fail because someone recorded a confused link.
    if (lineage.has(next)) {
      return lineage;
    }
    lineage.add(next);
    cursor = next;
  }
  return lineage;
}

/**
 * The item's current tip commit, derived from its own artifact history —
 * never stored, per DECISIONS.md §13a ("store facts, derive volatiles").
 *
 * Defined as the `commitSha` of the most recently created `commit`-kind
 * artifact for the item. `createdAt DESC, id DESC` breaks a same-instant tie
 * deterministically rather than leaving it to whatever order Postgres
 * happens to return rows in — two artifacts can share a timestamp at
 * millisecond precision under concurrent writes, and an unordered "the last
 * one" would be a coin flip.
 *
 * Returns `null` when the item has no `commit` artifact at all — nothing has
 * been committed yet, so there is no tip for anything to be stale against.
 */
export async function currentTipCommitSha(
  db: TransactionHandle,
  itemId: string,
): Promise<string | null> {
  const rows = await db.$queryRawUnsafe<ArtifactRow[]>(
    `SELECT "id", "kind", "verdict", "commitSha", "createdAt"
       FROM "Artifact"
      WHERE "itemId" = $1 AND "kind" = 'commit'
      ORDER BY "createdAt" DESC, "id" DESC
      LIMIT 1`,
    itemId,
  );
  return rows[0]?.commitSha ?? null;
}

/**
 * Every approving artifact of `kind` for `itemId`, newest first.
 *
 * "Approving" is the SET in `../../verdicts.ts`, not the single literal
 * `'approved'` this used to compare against. Review is tiered (SCHEMA.md
 * §6a): `lgtm`, `lgtm_with_nits` and `lgtm_with_followups` all say the change
 * is sound and differ only in what else must be true before it lands. Reading
 * only `'approved'` would treat every tiered review as no review at all.
 *
 * The set is bound as a parameter and cast to `"Verdict"[]` rather than
 * interpolated into the SQL — the values come from a module constant, not
 * from a caller, but building a query string out of an array is a habit that
 * stops being safe the first time the array's source changes.
 */
async function approvedArtifacts(
  db: TransactionHandle,
  itemId: string,
  kind: string,
): Promise<ArtifactRow[]> {
  return db.$queryRawUnsafe<ArtifactRow[]>(
    // `$2::"ArtifactKind"` — same reason transition.ts casts `$1::"ItemState"`:
    // Postgres infers an enum type for a *literal* ('commit') but refuses to
    // infer it for a bind parameter, so an uncast `"kind" = $2` fails with
    // "operator does not exist: ArtifactKind = text" rather than silently
    // comparing as text. Caught by this module's own DB-backed test run,
    // not by typecheck or lint — a raw-SQL enum comparison is invisible to
    // both. `$3::"Verdict"[]` is the same rule for the array form.
    `SELECT "id", "kind", "verdict", "commitSha", "createdAt"
       FROM "Artifact"
      WHERE "itemId" = $1 AND "kind" = $2::"ArtifactKind"
        AND "verdict" = ANY($3::"Verdict"[])
      ORDER BY "createdAt" DESC, "id" DESC`,
    itemId,
    kind,
    APPROVING_VERDICTS,
  );
}

/**
 * Whether **any** approved artifact of `kind` exists for `itemId` — no
 * staleness check, just existence. Deliberately separate from
 * `latestApprovalAtTip` below: this answers "was it ever approved", which a
 * required-field guard (SCHEMA.md §16's "a `plan-review` artifact with
 * `verdict = approved`") can ask on its own, kept apart from the tip check
 * so the two guards that compose them can fail independently and name
 * distinct rejections — "never approved" reads differently from "approved,
 * but not for the plan that's here now."
 */
export async function hasApproval(
  db: TransactionHandle,
  itemId: string,
  kind: string,
): Promise<boolean> {
  const rows = await approvedArtifacts(db, itemId, kind);
  return rows.length > 0;
}

/**
 * A full or abbreviated git object id: 4–40 lowercase hex characters.
 *
 * 4 is git's own practical floor for `--short` output (`core.abbrev`
 * defaults to "auto", which never goes below 4); 40 is a full sha-1. Sha-256
 * repos use 64, which this does not (yet) accept — nothing in this codebase
 * writes them today, and widening the ceiling later is a one-line change
 * with no callers to revisit.
 */
const HEX_SHA = /^[0-9a-f]{4,40}$/;

/**
 * Whether `candidate` refers to the same commit as `reference`, allowing
 * either side to be a git-style abbreviation of the other.
 *
 * ── Why prefix matching, and only in this direction ─────────────────────
 *
 * `git log --oneline`, `git rev-parse --short` and most tooling output
 * abbreviate to 7 characters by default — an artifact recorded from ordinary
 * git output carries a short sha, not a mistake. Comparing those against a
 * 40-character sha for the same commit with `===` refuses every one of them,
 * which is what row `73ff36bd` reported: three approvals pinned to
 * `86f3af0` could not match a commit artifact pinned to
 * `86f3af00253f4b0737fdcec00ca1fe7d3aa91f4a` — the same commit, written at
 * different lengths.
 *
 * Prefix matching is the direction git itself resolves abbreviations in: a
 * short sha identifies a commit exactly when it is an unambiguous prefix of
 * that commit's full id within the repo's object store. A 7-hex-character
 * collision between two *different* real commits in one repository is
 * astronomically unlikely (that is the entire premise `--short` relies on),
 * so treating "one is a prefix of the other" as "same commit" does not
 * meaningfully widen what this guard accepts as evidence — it only stops
 * refusing the same commit for having been spelled two different lengths.
 *
 * ── Why gated on `HEX_SHA` rather than a bare prefix check ──────────────
 *
 * `commitSha` is a free-form trimmed string at the schema level (nothing
 * validates it looks like git output when it's written), and this codebase's
 * own tests use short synthetic values like `"commit-a"` / `"commit-ab"` to
 * stand in for shas. A bare `a.startsWith(b) || b.startsWith(a)` would treat
 * `"commit-a"` as matching `"commit-ab"` — an unrelated fixture value, not
 * an abbreviation of anything. Requiring both sides to look like actual hex
 * git ids before applying prefix logic keeps the widening scoped to the real
 * case (abbreviated git shas) and leaves equality as the only route for
 * anything else, synthetic or otherwise.
 */
function shaMatches(candidate: string, reference: string): boolean {
  if (candidate === reference) {
    return true;
  }
  if (!HEX_SHA.test(candidate) || !HEX_SHA.test(reference)) {
    return false;
  }
  return candidate.length < reference.length
    ? reference.startsWith(candidate)
    : candidate.startsWith(reference);
}

/**
 * Finds the newest artifact of `kind` for `itemId` that is **both** an
 * approval and **at the item's current tip commit**, or `null` if none
 * qualifies.
 *
 * "At the tip" means the tip **or any sha the tip has been declared a
 * rewrite of** (`tipCommitLineage`). It is still the narrow reading in the
 * way that matters: a review approving sha X says nothing about an unrelated
 * sha Y, and nothing here infers a relationship. The only shas that join the
 * comparison set are ones a `commit` artifact explicitly recorded its own
 * sha as superseding — a squash, a rebase, an amend — where the reviewed
 * code and the landed code are the same work under two names. A commit
 * carrying new work declares no supersession, so it invalidates earlier
 * approvals exactly as it always did.
 *
 * Two artifacts can carry a null `commitSha` and still be compared correctly
 * here: with no `commit` artifact for the item (tip is `null`), an approval
 * with `commitSha: null` is treated as **matching** — there is nothing for
 * it to be stale against, so a plan approved before any commit exists is not
 * penalised for a tip that doesn't exist. With a real `commit` artifact
 * present, an approval carrying a `null` `commitSha` matches nothing
 * (`null !== '<real sha>'`) and is correctly refused as unverifiable against
 * the tip — the artifact never recorded which commit it was reviewed
 * against, so it cannot be trusted to be current.
 *
 * Matching against both the tip and the lineage now allows either side of
 * the comparison to be an abbreviated git sha (`shaMatches` above) — an
 * approval pinned to a 7-character sha is treated as current when it
 * prefix-matches the full sha of the tip or of anything in its lineage.
 */
export async function latestApprovalAtTip(
  db: TransactionHandle,
  itemId: string,
  kind: string,
): Promise<ArtifactRow | null> {
  const tip = await currentTipCommitSha(db, itemId);
  const lineage = await tipCommitLineage(db, itemId);
  const rows = await approvedArtifacts(db, itemId, kind);

  // Walk newest-first and return the first one that is actually at the tip,
  // rather than only ever looking at the single newest approval. An older
  // approval can still be at the tip when the newest approval of the same
  // kind was itself superseded by a later commit that reset it to
  // needs-review — but more directly, this is what makes the function
  // correct rather than merely convenient: "the latest approval" and "the
  // latest approval that is at the tip" are different questions, and
  // collapsing them to "the latest one, checked" would silently answer the
  // wrong one whenever they diverge.
  for (const row of rows) {
    // `row.commitSha === tip` (inside shaMatches) still carries the
    // `null`-tip case: with no commit artifact for the item, `lineage` is
    // empty and an approval with `commitSha: null` must still match, which
    // set membership alone would not give (`lineage.has(null)` is not a
    // question the set can answer). `shaMatches` short-circuits on exact
    // equality first, so `null === null` still passes before either side is
    // tested against `HEX_SHA`.
    if (row.commitSha === tip) {
      return row;
    }
    if (tip !== null && row.commitSha !== null && shaMatches(row.commitSha, tip)) {
      return row;
    }
    if (row.commitSha !== null) {
      for (const lineageSha of lineage) {
        if (shaMatches(row.commitSha, lineageSha)) {
          return row;
        }
      }
    }
  }
  return null;
}
