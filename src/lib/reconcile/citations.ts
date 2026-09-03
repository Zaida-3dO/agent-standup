// Finds rows whose work may already have landed under a DIFFERENT row, by
// reading evidence this product already stores rather than asking an
// external forge.
//
// ── The failure this exists to catch ────────────────────────────────────
//
// A row goes stale in exactly the case where the work went WELL: somebody
// fixed the thing efficiently as part of adjacent work and never came back
// to the row that described it. Nothing connects that landing to the row,
// because every mechanism that could — recording a commit artifact,
// transitioning the item — is manual and after the fact, and is performed
// against the row the person was working on, not the row they incidentally
// satisfied.
//
// The measured cost is not hypothetical. In one triage pass, twenty-two of
// twenty-seven rows in a single cluster were already fixed; six of those
// were top priority and were minutes from having crews dispatched onto
// them. The bad outcome is not a wasted dispatch — it is a rebuild that is
// worse than the working code it replaced.
//
// ── The signal, and why this one ────────────────────────────────────────
//
// A row's id, verbatim, inside the text of an artifact recorded against a
// DIFFERENT row. Commit messages, pull-request bodies and review notes in
// this workflow routinely cite the row that motivated the work; the
// sharpest recorded instance is a change whose own doc comment names the
// row that proved the defect, while that row sat open for days knowing
// nothing about it.
//
// Reading artifacts rather than a forge's pull requests is what makes this
// answerable during an ordinary read. `Artifact` rows are written through
// `record_artifact` by the same sessions doing the work, and carry the
// commit sha, the pull-request url and the reviewer's prose. So this needs
// no clone, no forge credentials, no network path off the server, and no
// separate tool a person has to remember to run — which is the property the
// sibling matcher in `shipped-rows.ts` lacks, and the reason a correct
// matcher can still fail to prevent a single wasted dispatch.
//
// ── What this is NOT ────────────────────────────────────────────────────
//
// Not a closer, and not a verdict. It reports EVIDENCE and ranks nothing as
// resolved. Three failure shapes hide under the word "stale" and this
// signal can only ever see the first:
//
//   1. Fixed elsewhere — the case here. Detectable.
//   2. Premise false from the start — the row described something that was
//      never true. No citation exists to find, because no work was done.
//   3. Premise evaporated — a later change deleted the thing the row was
//      about, so its acceptance criterion is now unrunnable rather than
//      met. This is the dangerous shape: it closes cleanly if nobody is
//      paying attention, and takes a genuine gap with it.
//
// A citation is also not proof the citing work SATISFIED the cited row.
// Partial shipping is real and recorded: rows have been found where one
// finding closed and another stayed open under the same id. An automatic
// close would have hidden the open half. So the output of this module is
// input to a judgement, never a substitute for one.
import { uuidsMentionedIn } from "./shipped-rows";
import type {
  CitationCandidate,
  CitationEvidence,
  CitedArtifact,
  CitationInput,
  CitableItem,
} from "./types";

/**
 * Artifact kinds whose text is worth reading for a citation.
 *
 * Deliberately a set rather than "every kind": a `screenshot` or a
 * `test_run` carries no argument about which row it settles, and reading
 * them adds noise without adding a case. The kinds here are the ones that
 * carry prose ABOUT the work — what landed, what it fixed, what a reviewer
 * found.
 *
 * `historical_verification` is included on purpose. It records work
 * verified by inspection against already-merged code, which is precisely
 * the act that discovers "this was fixed elsewhere" — so an agent that
 * performed that inspection under one row has very often named the other.
 */
export const CITING_ARTIFACT_KINDS: readonly string[] = Object.freeze([
  "commit",
  "pull_request",
  "code_review",
  "plan",
  "plan_review",
  "historical_verification",
  "merge_override",
  // Included for the same reason `merge_override` is: its body is a written
  // judgement about what changed since a review, which is exactly the kind
  // of prose that names another row while explaining itself.
  //
  // Deliberately NOT added to `confidenceFor`'s landed set below. A
  // `merge_override` names a real sha and accompanies a merge, so it is
  // evidence something shipped; this kind says only that existing review
  // evidence still stands, which can be true of work that has not landed and
  // may never. Treating it as `high` would promote a currency judgement into
  // a claim about reality that it does not make.
  "review_evidence_override",
  "other",
]);

/**
 * The text of an artifact that could carry a citation.
 *
 * `body` and `ref` are both read. `ref` holds a pull-request URL on a
 * `pull_request` artifact, and a URL is a place a row id genuinely appears
 * — a branch named for the row it came from is a real convention here.
 * `commitSha` is deliberately NOT scanned: it is hex, and a 40-character
 * hex string cannot contain a hyphenated UUID, so scanning it could only
 * ever cost time.
 */
export function citationTextOf(artifact: CitedArtifact): string {
  return [artifact.body ?? "", artifact.ref ?? ""].join("\n");
}

/**
 * Every row id an artifact's text names, EXCLUDING the row it was recorded
 * against.
 *
 * Self-exclusion is the whole point rather than a tidy-up. An artifact
 * naming its own row is the ordinary, healthy case — a commit message that
 * cites the row it is delivering — and reporting it would bury the one
 * interesting case (a row named by work filed elsewhere) under the many
 * uninteresting ones. The signal is specifically CROSS-row.
 */
export function crossRowCitations(artifact: CitedArtifact): Set<string> {
  const cited = uuidsMentionedIn(citationTextOf(artifact));
  cited.delete(artifact.itemId.toLowerCase());
  return cited;
}

/**
 * Builds the candidate list: one entry per non-terminal row cited by at
 * least one artifact belonging to a different row.
 *
 * A row with no citing artifact produces NO candidate — this function only
 * ever reports evidence *for* a row having been addressed elsewhere, and
 * never a verdict that a row is still open. Absence here means "not found
 * by this signal", which is a much weaker claim than "still outstanding",
 * and the report says so.
 *
 * Deterministic order: candidates follow the order the rows were given, and
 * each row's evidence is sorted newest-artifact-first so the most recent —
 * and usually most relevant — citation reads first. Ties on `createdAt`
 * fall back to the artifact id, so two artifacts written in the same
 * millisecond do not swap places between runs.
 */
export function findCitedRows(input: CitationInput): CitationCandidate[] {
  const wanted = new Map<string, CitableItem>();
  for (const item of input.items) {
    wanted.set(item.id.toLowerCase(), item);
  }

  // rowId -> its evidence, accumulated across every citing artifact.
  const evidenceByRow = new Map<string, CitationEvidence[]>();

  for (const artifact of input.artifacts) {
    if (!CITING_ARTIFACT_KINDS.includes(artifact.kind)) continue;

    for (const citedId of crossRowCitations(artifact)) {
      // Only rows the caller asked about. An artifact citing a row that is
      // already terminal — or one that does not exist at all, which happens
      // when a body quotes an id from another installation or a typo —
      // produces nothing rather than a candidate for a row nobody can open.
      if (!wanted.has(citedId)) continue;

      const list = evidenceByRow.get(citedId) ?? [];
      list.push({
        artifactId: artifact.id,
        citedBy: artifact.itemId,
        citedByTitle: artifact.itemTitle ?? null,
        citedByState: artifact.itemState ?? null,
        kind: artifact.kind,
        commitSha: artifact.commitSha ?? null,
        ref: artifact.ref ?? null,
        createdAt: artifact.createdAt ?? null,
      });
      evidenceByRow.set(citedId, list);
    }
  }

  const candidates: CitationCandidate[] = [];
  for (const item of input.items) {
    const evidence = evidenceByRow.get(item.id.toLowerCase());
    if (!evidence || evidence.length === 0) continue;

    evidence.sort((a, b) => {
      const aTime = a.createdAt ? Date.parse(a.createdAt) : 0;
      const bTime = b.createdAt ? Date.parse(b.createdAt) : 0;
      if (bTime !== aTime) return bTime - aTime;
      return a.artifactId < b.artifactId ? -1 : a.artifactId > b.artifactId ? 1 : 0;
    });

    candidates.push({
      item,
      confidence: confidenceFor(evidence),
      reason: "cited-by-another-rows-artifact",
      evidence,
    });
  }
  return candidates;
}

/**
 * How much weight the evidence carries — reported, never acted on.
 *
 * `high` when at least one citing artifact records work that actually
 * LANDED (a commit, or a merge override, both of which name a real sha).
 * `medium` otherwise: a plan or a review naming a row is evidence somebody
 * was thinking about it, which is weaker than evidence something shipped.
 *
 * Two levels rather than a score, because the only decision this feeds is
 * "is this worth a human reading before I dispatch", and a number would
 * imply a precision the signal does not have.
 */
function confidenceFor(evidence: readonly CitationEvidence[]): "high" | "medium" {
  const landed = evidence.some((e) => e.kind === "commit" || e.kind === "merge_override");
  return landed ? "high" : "medium";
}
