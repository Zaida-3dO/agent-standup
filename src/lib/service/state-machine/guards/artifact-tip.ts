// The shared "what is the tip commit, and is this artifact at it" primitive.
// See docs/plans/MILESTONES.md #17, SCHEMA.md §6 (`artifacts.commit_sha` —
// "What it applies to — the 'at tip' check") and §16.
//
// Exported standalone, not folded into one guard's `check`, because #18's
// merge guard needs exactly this same comparison ("an approving `code-review`
// artifact at the current `max(artifacts.review_round)`" is the review-round
// shape of the same question this module answers for commits) and MILESTONES
// #17's own row says to "keep the artifact-checking surface reusable."
import type { TransactionHandle } from "../../context";

/** The one row shape every function here reads out of `"Artifact"`. */
interface ArtifactRow {
  id: string;
  kind: string;
  verdict: string | null;
  commitSha: string | null;
  createdAt: Date;
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

/** Every approved artifact of `kind` for `itemId`, newest first. */
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
    // both.
    `SELECT "id", "kind", "verdict", "commitSha", "createdAt"
       FROM "Artifact"
      WHERE "itemId" = $1 AND "kind" = $2::"ArtifactKind" AND "verdict" = 'approved'
      ORDER BY "createdAt" DESC, "id" DESC`,
    itemId,
    kind,
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
 * Finds the newest artifact of `kind` for `itemId` that is **both** an
 * approval and **at the item's current tip commit**, or `null` if none
 * qualifies.
 *
 * "At the tip" is deliberately the narrow reading: an artifact whose
 * `commitSha` does not exactly equal `currentTipCommitSha` is refused, full
 * stop — there is no fuzzy notion of "close enough" or "the tip's ancestor."
 * A review approving sha X says nothing about sha Y, however the two shas are
 * related; only an exact match counts as evidence for the transition in
 * front of the guard.
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
 */
export async function latestApprovalAtTip(
  db: TransactionHandle,
  itemId: string,
  kind: string,
): Promise<ArtifactRow | null> {
  const tip = await currentTipCommitSha(db, itemId);
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
    if (row.commitSha === tip) {
      return row;
    }
  }
  return null;
}
