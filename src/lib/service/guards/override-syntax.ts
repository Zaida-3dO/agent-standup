// The literal call that takes a service-level override, printed into the
// refusal that offers it.
//
// ── Why a refusal has to carry the syntax, not just the offer ───────────
//
// Both service-level overrides — `merge_override` and
// `review_evidence_override` — were already *named* in the refusals that
// offer them, and both refusals already said what the override costs. What
// neither said was **how to send one**. The reader was told to "record a
// `review_evidence_override` artifact naming this commit, with a body of at
// least 20 characters", and then had to work out on their own which tool
// records an artifact, what its fields are called, and which of them this
// particular override needs.
//
// That gap has a measured cost in this repository, twice over. A catalogue
// note from 2026-09-10 records a refusal that advertised an override whose
// syntax was not discoverable: four attempts, four byte-identical refusals,
// and then the session gave up — leaving a safe, justified merge unpushed
// on one machine. The hook side learned the same lesson independently and
// wrote it into `../../hook/override.ts`: a caller there "spent seven
// attempts inventing override syntaxes that could not have worked". **An
// override nobody can invoke is worse than no override at all, because it
// reads as coverage and provides none.**
//
// The standard being applied is this repository's own, set by the
// `list_repos` decision: the valid repo ids now arrive *in* the "No such
// repo" refusal rather than in a document somebody has to find. A
// bypassable refusal states, in the refusal text, the literal form that
// bypasses it — not a doc reference, not "see the contract".
//
// ── Why this is a shared builder and not prose in two places ────────────
//
// `merge.ts`'s `OVERRIDE_REMEDY` and `review-evidence-override.ts`'s
// `reviewEvidenceOverrideRemedy` describe the same mechanism (record an
// artifact of a given kind, with a reason, scoped to a commit) for two
// different kinds. Written out twice they would drift into describing the
// escape hatch differently, which is the exact reason `merge.ts` already
// gives for keeping its own two refusals on one constant. Built here once,
// a change to the accepted shape updates both refusals or neither.
//
// ── Why it is pinned to the parser rather than paraphrased ──────────────
//
// Every field below is the field `record-artifact.ts`'s own `inputSchema`
// reads, checked against it rather than remembered: `itemId`, `kind`,
// `commitSha` and `body` are its parameters, and `createdByType` /
// `createdById` are optional there **only** when the caller holds a live
// assignment to infer them from (`record-artifact.ts`'s own refusal: "An
// artifact must record who produced it — pass createdByType and
// createdById"). They are shown explicitly because a caller reading this
// sentence has just been refused and may well not hold one — an example
// that works only for the luckier half of its readers is the same defect at
// one remove.
//
// This is deliberately NOT a reuse of `../../hook/override.ts`'s
// `overrideRemedy`. That function serves a different channel: the hook's
// PreToolUse layer, whose override is a top-level `standup_override` field
// on the stdin payload, and which is offered only to an `orchestrator`
// audience because an agent cannot compose that payload. Its literal syntax
// is not the syntax these callers need, and printing it here would hand a
// service caller an instruction that cannot work. The two share a *rule* —
// state the accepted form literally, pinned to the parser — and correctly
// share no code.

import { MERGE_OVERRIDE_KIND, MIN_REASON_LENGTH } from "./merge-override";

/**
 * The literal `record_artifact` call that files an override of `kind`.
 *
 * `commitSha` is included when the override must name a commit and omitted
 * when the item has none to name — which is not cosmetic. The two overrides
 * are scoped by commit, and an override carrying the wrong shape is refused:
 * on an item with no tip, only an override with no `commitSha` applies
 * (`reviewEvidenceOverrideSatisfies`), so printing a `commitSha` field to
 * that caller would be printing the one form guaranteed not to work.
 *
 * `<sha>` and `<...>` are left as placeholders rather than filled with the
 * real values. The sha the caller must name is already stated in the
 * sentence this is appended to, and a fabricated reason in an example is
 * the thing a hurried caller copies verbatim — which would put a meaningless
 * string into a permanent, counted record whose entire value is that a
 * person can read it afterwards.
 */
export function overrideCallSyntax(kind: string, withCommitSha: boolean): string {
  const fields = [
    `"itemId": "<this item>"`,
    // `artifactKind`, which is what the operation names this field. The
    // printed call is parsed by `record_artifact`'s own schema in a test,
    // precisely so this sentence cannot advertise a field the schema does
    // not accept — a bypass documented in terms the parser rejects is an
    // undiscoverable one.
    `"artifactKind": "${kind}"`,
    ...(withCommitSha ? [`"commitSha": "<sha>"`] : []),
    `"body": "<why, in your own words>"`,
    `"createdByType": "agent"`,
    `"createdById": "<you>"`,
  ];
  return `record_artifact { ${fields.join(", ")} }`;
}

/**
 * The full override sentence: what to send, what it costs, and the literal
 * call that sends it.
 *
 * `guardId` is named because an override is scoped to the clause it excuses,
 * and because a reader counting overrides later needs to know which guard's
 * default was judged wrong — the signal the intervention scoring work
 * consumes. A count that cannot be attributed to a guard says overriding
 * happened without saying what should change.
 *
 * The closing clause states that the reason is kept but not checked. That is
 * the honest description of a block-and-record control (MILESTONES.md #128):
 * an agent asked to justify itself will always produce a justification, so
 * the value is the attributed, readable row, not the friction. Saying so
 * plainly is better than implying an adjudication that does not happen.
 */
export function overrideRemedySentence(options: {
  readonly kind: string;
  readonly guardId: string;
  readonly minReasonLength: number;
  readonly withCommitSha: boolean;
  /** The clause naming what the override is anchored to, or the lack of it. */
  readonly anchor: string;
}): string {
  const { kind, guardId, minReasonLength, withCommitSha, anchor } = options;
  return (
    `If the existing review genuinely still applies and you are judging that nothing material ` +
    `changed, record a ${kind} artifact ${anchor}, with a body of at least ` +
    `${minReasonLength} characters saying why. Send exactly: ` +
    `${overrideCallSyntax(kind, withCommitSha)}. It is recorded permanently against ` +
    `"${guardId}" as an override rather than as a review, and overrides are counted — the ` +
    `reason is kept as a record, not checked for correctness.`
  );
}

/**
 * The guard whose refusals carry `MERGE_OVERRIDE_REMEDY`.
 *
 * Exported so `merge.ts` can assert its own guard's `id` equals it rather
 * than the two agreeing by coincidence. The remedy names the guard it
 * excuses, and an override is scoped to that name — so a guard id that
 * drifted from the one printed in its own refusal would tell a caller to
 * file an override attributed to a clause that did not refuse them.
 */
export const MERGE_OVERRIDE_GUARD_ID = "merge.requires_approving_code_review";

/**
 * The sentence every code-review merge refusal ends with.
 *
 * Lives here rather than in `merge.ts` so that both service-level overrides
 * are built by one function — see this module's header on drift. A
 * `merge_override` always names a commit: `merge.requires_commit`
 * independently guarantees a tip exists before this clause is reached, so
 * there is no no-tip form of it to offer.
 */
export const MERGE_OVERRIDE_REMEDY = overrideRemedySentence({
  kind: MERGE_OVERRIDE_KIND,
  guardId: MERGE_OVERRIDE_GUARD_ID,
  minReasonLength: MIN_REASON_LENGTH,
  withCommitSha: true,
  anchor: "naming this commit",
});
