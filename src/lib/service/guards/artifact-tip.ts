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
 * The row shape for queries that need the insertion-order tiebreak —
 * `currentTipCommitSha` and the supersession walk in `tipCommitLineage`.
 * Kept separate from `ArtifactRow` rather than adding `seq` to it broadly:
 * nothing else in this module orders by `seq`, and a field every caller
 * carries but only two ever read invites exactly the kind of drift this
 * fix exists to close (see `seq`'s own doc on the Prisma model).
 */
interface OrderedArtifactRow {
  commitSha: string | null;
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
        ORDER BY "createdAt" DESC, "seq" DESC
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
 * artifact for the item. Ordered `"createdAt" DESC, "seq" DESC` — `seq` is
 * the tiebreak, not `createdAt`: two artifacts can share a timestamp at
 * millisecond precision under concurrent writes (`Artifact.createdAt` is
 * `@db.Timestamptz(3)`), and this used to break that tie with `id DESC`.
 * `id` is `@default(uuid())` — a random v4 with no relationship to
 * insertion order — so a same-millisecond tie was a coin flip on which
 * commit counted as the tip, decided once and then fixed forever. `seq` is
 * a Postgres-assigned `bigserial` (see its own doc on the Prisma model),
 * handed out in true insertion order, so the tiebreak now actually answers
 * "which one was recorded later" instead of "which uuid sorts higher".
 *
 * Returns `null` when the item has no `commit` artifact at all — nothing has
 * been committed yet, so there is no tip for anything to be stale against.
 */
export async function currentTipCommitSha(
  db: TransactionHandle,
  itemId: string,
): Promise<string | null> {
  const rows = await db.$queryRawUnsafe<OrderedArtifactRow[]>(
    `SELECT "commitSha"
       FROM "Artifact"
      WHERE "itemId" = $1 AND "kind" = 'commit'
      ORDER BY "createdAt" DESC, "seq" DESC
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
 *
 * Ordered `"createdAt" DESC, "seq" DESC`, same reason as `currentTipCommitSha`:
 * `seq` is the true insertion-order tiebreak on a same-millisecond tie,
 * `id` is a random uuid and is not. Every caller here reads the returned
 * list as a membership/existence test (`hasApproval`'s count, or a walk
 * for the first row that qualifies at the tip) rather than trusting
 * `rows[0]` alone, so a tie was never a correctness bug the way the tip
 * query's was — but a query in this file still tie-breaking on `id` taught
 * the next reader the wrong rule, which is reason enough on its own.
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
      ORDER BY "createdAt" DESC, "seq" DESC`,
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
 * The shortest prefix `shaMatches` will accept as an abbreviation, and the
 * longest string it will accept as a sha at all: 7–40 lowercase hex
 * characters.
 *
 * **Why 7, not git's own practical floor of 4.** `commitSha` is stored with
 * no format validation (`record-artifact.ts` accepts any non-empty
 * trimmed string), so a short value is not guaranteed to have come from
 * git — it is caller-supplied, and prefix matching turns a short value into
 * a match against a whole family of commits. At 4 hex characters that
 * family has 65,536 members, cheap to search by writing artifacts in a
 * loop; at 7 it has 268,435,456, the exact margin git itself stakes
 * `--short` abbreviation on and the width the report that motivated this
 * module used throughout. Nothing in this codebase writes a 4- or
 * 6-character sha, so 7 cannot refuse a real caller.
 *
 * 40 is a full sha-1. Sha-256 repos use 64, which this does not accept —
 * this codebase writes only sha-1 commit ids, and widening the ceiling is a
 * one-line change with no callers to revisit if that ever changes.
 *
 * **Both bounds are pinned by a dedicated test**, not left to this comment
 * alone — `{7,40}` narrowed silently to `{1,40}` or `{7,}` still lets every
 * existing test pass, because the fixtures those tests use never happen to
 * probe the boundary. A mutation that widens either number changes what
 * this module will accept as evidence for a merge, and the margin above
 * only holds at the numbers actually enforced, not at the numbers this
 * comment claims.
 */
const HEX_SHA_MIN_LENGTH = 7;
const HEX_SHA_MAX_LENGTH = 40;
const HEX_SHA = new RegExp(`^[0-9a-f]{${HEX_SHA_MIN_LENGTH},${HEX_SHA_MAX_LENGTH}}$`);

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
export function shaMatches(candidate: string, reference: string): boolean {
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
 * Whether `candidate` matches the tip itself or anything in its
 * supersession lineage, allowing abbreviation on either side of each
 * comparison (`shaMatches` above).
 *
 * **Every site in this codebase that asks "is this sha at the tip" needs
 * this exact question answered, not a narrower one.** Before this row, three
 * of the four call sites tested `candidate === tip || lineage.has(candidate)`
 * directly — correct for two full-length shas, but `Set.has` is exact-value
 * membership, so a lineage built from full shas is blind to an abbreviated
 * `candidate` even though `shaMatches` alone would have accepted it. Row
 * `e09aa150` proved this empirically: `latestApprovalAtTip` (routed through
 * `shaMatches` first) matched a 7-character approval against a 40-character
 * tip, while `approvingArtifactAtCurrentRoundAndTip` and
 * `personHasApprovedMerge` — still doing the comparison directly — refused
 * the identical row. Centralising the question here, once, is what makes
 * "every site agrees on what counts as the same commit" true by
 * construction rather than by four call sites happening to stay in sync.
 *
 * `tip === null` (no commit artifact exists yet) is handled the same way
 * every caller of this question already needed it handled: nothing exists
 * for `candidate` to be stale against, so a `null` `candidate` matches and
 * anything else does not — see `latestApprovalAtTip`'s own doc for why that
 * asymmetry is correct rather than an oversight.
 */
export function shaMatchesTipOrLineage(
  candidate: string | null,
  tip: string | null,
  lineage: ReadonlySet<string>,
): boolean {
  if (tip === null) {
    return candidate === null;
  }
  if (candidate === null) {
    return false;
  }
  if (shaMatches(candidate, tip)) {
    return true;
  }
  for (const lineageSha of lineage) {
    if (shaMatches(candidate, lineageSha)) {
      return true;
    }
  }
  return false;
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
  //
  // Delegated to `shaMatchesTipOrLineage` rather than repeating the
  // tip/lineage/null-handling logic inline — this is one of four sites in
  // the codebase that ask exactly this question, and having each answer it
  // separately is what let three of the four drift out of agreement (row
  // `e09aa150`).
  for (const row of rows) {
    if (shaMatchesTipOrLineage(row.commitSha, tip, lineage)) {
      return row;
    }
  }
  return null;
}
