// The built-in interventions — the implemented part of the catalogue in
// `docs/plans/INTERVENTIONS.md`, which is the document of record for what
// is worth detecting and grows independently of this file.
//
// **Not every catalogued entry is here, and the gaps are deliberate.** The
// catalogue's own rule for writing an entry is the rule applied to
// implementing one: *"state the situation in terms the server can actually
// evaluate … if it needs something the server cannot see, say so and stop;
// that is a finding about the schema, not an intervention."* An entry whose
// signal this build genuinely cannot observe is therefore left unbuilt with
// its reason recorded, rather than shipped as a predicate that quietly
// never fires. A registry entry that cannot trigger is worse than an absent
// one: it reads as coverage on the settings page and provides none.
//
// What is here, and why each earns its place:
//
//   - **I10** and **I12** are the two blocking correctness entries — the
//     conditional rules a pattern list structurally cannot express, which
//     is the whole case for this mechanism existing.
//   - **I11** is `pre`, blocks, and turns on context rather than on the
//     command text.
//   - **I15** is the entry that turns on *no* command shape at all — it
//     reads only who else holds the checkout, which is why it is the one
//     whose context the assembler gathers for any write-shaped call.
//   - **I1** and **I7** are `post` nudges that ride the digest, and could
//     not block even if someone configured them to.
//
// Every one obeys the contract the eventual custom entries will need: they
// read only the context handed to them, they return a verdict, and they
// emit nothing.

import { isBroadProcessKill, isMergeAttempt } from "./commands";
import type { Intervention, InterventionContext, InterventionVerdict } from "./types";

/**
 * Whether a command stages the whole working tree rather than named paths.
 *
 * Deliberately narrow. This recognises the documented broad forms and
 * nothing else: a command it does not recognise produces no finding, which
 * is the right direction for a check whose false positive is a blocked
 * commit. Note this is **recognition, not judgement** — whether a broad add
 * is a problem depends on the checkout, which is `predicate`'s job below.
 */
export function isBroadGitAdd(command: string): boolean {
  const trimmed = command.trim();
  if (!/(^|[;&|]\s*)git\s+add\b/.test(trimmed)) return false;
  // The broad forms, each anchored so `git add -Answer.txt` is not one and
  // `git add ./src` is not `git add .`.
  return /\bgit\s+add\s+(?:[^;&|]*\s)?(-A\b|--all\b|-u\b|\.(?:\s|$)|:\/(?:\s|$))/.test(trimmed);
}

/**
 * **I11** — a broad `git add` on a shared checkout.
 *
 * The rule is not "never run `git add -A`". It is "not where the index is
 * shared", and that condition lives in context the command text cannot
 * carry: a linked worktree has its own index, so the same command there
 * stages only the caller's own work and is inert.
 */
const broadGitAddOnSharedCheckout: Intervention = {
  id: "broad-git-add-on-shared-checkout",
  source: "builtin",
  summary: "A broad `git add` in a checkout whose index is shared with other sessions.",
  phase: "pre",
  audience: "agent",
  defaultLevel: "block-overridable",
  defaultTiming: "immediate",
  messages: {
    plain:
      "This stages every modified file in a checkout other sessions are also working in, so it " +
      "would commit their work under your name. Stage your own files by path instead.",
    prominent:
      "⚠️ Do not proceed until you have read this. This `git add` stages every modified file in a " +
      "checkout that other sessions are working in right now — their uncommitted work would be " +
      "committed under your name and attributed to your change. Stage your own files explicitly " +
      "by path.",
  },
  predicate(context: InterventionContext): InterventionVerdict {
    if (context.command === undefined) return { triggered: false };
    if (!isBroadGitAdd(context.command)) return { triggered: false };
    // A linked worktree has its own index — the command is inert there.
    // `undefined` is not `false`: when the server does not know whether this
    // is a linked worktree it does not know whether the index is shared, and
    // the honest answer to that is no finding rather than a block on a guess.
    if (context.isLinkedWorktree !== false) return { triggered: false };
    return { triggered: true, data: { command: context.command } };
  },
};

/**
 * **I7** — a PR with no checks that is also unmergeable.
 *
 * `post` by nature: the PR already exists by the time there is anything to
 * notice, so this informs rather than stops. It is here mainly as the
 * subject of the "a post entry cannot block" invariant — configure it to
 * `hard-block` and the registry clamps it to a nudge.
 *
 * The context fields it would really read (`mergeable`, `mergeStateStatus`)
 * are not on `InterventionContext` yet, because nothing assembles them yet.
 * It therefore triggers on the one thing this row can honestly evaluate —
 * an item state naming a review with no approval at tip — and the wiring
 * row that adds the PR fields tightens it.
 */
const reviewWithoutApprovalAtTip: Intervention = {
  id: "review-without-approval-at-tip",
  source: "builtin",
  summary: "An item sitting in review with no approving artifact at the current tip.",
  phase: "post",
  audience: "orchestrator",
  defaultLevel: "nudge",
  defaultTiming: "digest",
  messages: {
    plain: "This item is in review and has no approving artifact at tip — spawn a reviewer for it.",
    prominent:
      "⚠️ This item is in review and nothing has approved it at the current tip. Nothing will move " +
      "it on its own: spawn a reviewer, or say plainly that it is waiting on something.",
  },
  predicate(context: InterventionContext): InterventionVerdict {
    if (context.itemState !== "in_review") return { triggered: false };
    if (context.hasApprovalAtTip !== false) return { triggered: false };
    return {
      triggered: true,
      ...(context.itemId === undefined ? {} : { data: { itemId: context.itemId } }),
    };
  },
};

/**
 * **I10** — a merge with no approving review at the current tip.
 *
 * The catalogue calls this file's thesis stated before the file existed:
 * the rule is *not* "never run `git merge`" — it is "not without an
 * approval", and no command matcher can express that because the approval
 * is not in the command. `./commands.ts` recognises that a merge is being
 * attempted and this decides whether it may proceed, which is the split
 * exactly.
 *
 * ── Three ways this declines to fire, all of them the point ────────────
 *
 * The condition is `hasApprovalAtTip === false` — **strictly false, never
 * merely falsy** — and the two absent cases are distinct situations that
 * would both be wrong to block:
 *
 *   1. **No claim, so no item.** A session merging in a repository it holds
 *      no work on is not a session dodging review; it is very often the
 *      operator. There is nothing here to approve.
 *   2. **A claim, but no commit artifact at all.** Nothing has been
 *      committed, so there is no tip for an approval to be at, and
 *      `assembleContext` leaves the field absent rather than answering
 *      `false` to a question with no subject.
 *
 * Only the third case — an item with a real tip and no approval standing at
 * it — is the situation this exists for, and it is the one where blocking
 * costs a session thirty seconds and saves an unreviewed merge.
 *
 * **`block-overridable`, not `hard-block`**, per the catalogue: the value
 * is the recorded reason on a reviewable event, not the friction. A merge
 * that genuinely should proceed without an approval at tip — resolving a
 * conflict, landing a revert — proceeds, and says why.
 */
const mergeWithoutApprovalAtTip: Intervention = {
  id: "merge-without-approval-at-tip",
  source: "builtin",
  summary: "A merge attempted while no approving review stands at the item's current tip commit.",
  phase: "pre",
  audience: "agent",
  defaultLevel: "block-overridable",
  defaultTiming: "immediate",
  messages: {
    plain:
      "This merges work that has no approving review at its current tip commit. Request a review " +
      "and land it against this commit, or proceed with a written reason saying why it should go " +
      "without one.",
    prominent:
      "⚠️ Do not proceed until you have read this. This would merge a change that nothing has " +
      "approved at the commit being merged — either it was never reviewed, or it was reviewed and " +
      "then changed. Request a review against the current tip. If it genuinely should land " +
      "anyway, say so in writing: the reason is recorded and read.",
  },
  predicate(context: InterventionContext): InterventionVerdict {
    if (context.command === undefined) return { triggered: false };
    if (!isMergeAttempt(context.command)) return { triggered: false };
    // Strictly `false`. `undefined` means the server could not answer the
    // question — no claim, or no commit to be at the tip of — and blocking
    // a merge on an unanswered question is how a guard becomes an obstacle.
    if (context.hasApprovalAtTip !== false) return { triggered: false };
    return {
      triggered: true,
      data: {
        command: context.command,
        ...(context.itemId === undefined ? {} : { itemId: context.itemId }),
      },
    };
  },
};

/**
 * **I12** — a process kill that names no specific process.
 *
 * **Settled as a prompt to think, not an ownership check** (the catalogue
 * records the decision and the date). The ownership route needs a live
 * process registry, correct PID attribution and an accurate crew root, and
 * its failure mode is *silently wrong in both directions* — refusing a kill
 * that was fine, or waving through the exact one it exists to stop. A
 * prompt costs none of that and catches the same mistake, because the
 * honest answer to "would a narrower kill do?" is almost always yes.
 *
 * Note this entry needs **no state at all** — it is the one blocking entry
 * that turns purely on the shape of the command, which is why
 * `./context.ts` deliberately has no branch for it. That is not an
 * inconsistency with the argument for putting judgement server-side: the
 * breadth of a kill genuinely is readable from the command, and the entry
 * is server-side because that is where the response ladder, the override
 * and the recorded reason live, not because the detection needed it.
 */
const broadProcessKill: Intervention = {
  id: "broad-process-kill",
  source: "builtin",
  summary: "A kill that ends processes by image name rather than naming which processes to end.",
  phase: "pre",
  audience: "agent",
  defaultLevel: "block-overridable",
  defaultTiming: "immediate",
  messages: {
    plain:
      "This ends every process matching a name, including ones other sessions are relying on. " +
      "Kill by process id instead, or proceed with a written reason if the broad kill is really " +
      "what you want.",
    prominent:
      "⚠️ Do not proceed until you have read this. This kill is not scoped to a specific process " +
      "— it ends everything matching the name, and other sessions on this machine are very " +
      "likely running something that matches. Find the process id and kill that. If you truly " +
      "need the broad form, say why: the reason is recorded.",
  },
  predicate(context: InterventionContext): InterventionVerdict {
    if (context.command === undefined) return { triggered: false };
    if (!isBroadProcessKill(context.command)) return { triggered: false };
    return { triggered: true, data: { command: context.command } };
  },
};

/**
 * **I1** — coding is finished and no reviewer exists.
 *
 * The catalogue's first flow entry, and the cheapest failure on the list:
 * the work is done, and it sits because the one call that would move it was
 * never made. Addressed to the `orchestrator`, because spawning a reviewer
 * is not something the builder can do for itself — telling the builder
 * would be asking it to act outside its remit, which the catalogue names as
 * a way of being ignored.
 *
 * Rides the digest. Nothing about it is urgent to the second, and the whole
 * argument for the digest is that a batch arriving at a natural juncture
 * gets acted on while a trickle gets skipped.
 *
 * **The signal is the item's own state, not a guess about activity.**
 * `in_review` is the state a builder moves to when it is finished and
 * waiting; combined with no approval standing at the tip, that is the
 * situation stated in terms the server can actually evaluate.
 */
const finishedWithNoReviewer: Intervention = {
  id: "finished-with-no-reviewer",
  source: "builtin",
  summary: "An item whose builder has finished, with no approving review at its tip.",
  phase: "post",
  audience: "orchestrator",
  defaultLevel: "nudge",
  defaultTiming: "digest",
  messages: {
    plain:
      "This item is finished and waiting on a review that nothing has started. Spawn a reviewer.",
    prominent:
      "⚠️ This item's builder has finished and nothing is reviewing it. It will not move on its " +
      "own: spawn a reviewer now, or record plainly what it is waiting on.",
  },
  predicate(context: InterventionContext): InterventionVerdict {
    if (context.itemState !== "in_review") return { triggered: false };
    if (context.hasApprovalAtTip !== false) return { triggered: false };
    return {
      triggered: true,
      ...(context.itemId === undefined ? {} : { data: { itemId: context.itemId } }),
    };
  },
};

/**
 * **I15** — another live crew already holds this checkout.
 *
 * The entry the catalogue calls closest to buildable, and it is the first
 * consumer of the careful root-session attribution `registered_processes`
 * established: **the comparison is between root sessions, never between
 * sessions.** A builder an orchestrator spawned is the same crew working
 * the same checkout on purpose, and a check keyed on `sessionId` would
 * refuse a crew its own parent's claim — blocking the ordinary case while
 * still permitting the one this exists to stop.
 *
 * ── Keyed on `(machine, repo)`, deliberately not on the worktree path ──
 *
 * `Assignment.worktree` is unnormalised free text, so `/path/to/repo`,
 * `/path/to/repo/` and a home-relative spelling of the same directory do
 * not compare equal. A predicate over it would pass silently on exactly the
 * collisions it exists to catch — the *silently wrong in both directions*
 * failure I12 retreated from, arrived at by a different route. The pair
 * that does compare reliably is the machine and the repository id, and both
 * are columns rather than paths.
 *
 * **`block-overridable`, not hard**: two crews in one checkout is sometimes
 * deliberate and the caller may know something the claim table does not.
 * The recorded reason is the value, per the catalogue.
 */
const checkoutHeldByAnotherCrew: Intervention = {
  id: "checkout-held-by-another-crew",
  source: "builtin",
  summary: "A write into a checkout on this machine that another live crew already holds.",
  phase: "pre",
  audience: "agent",
  defaultLevel: "block-overridable",
  defaultTiming: "immediate",
  messages: {
    plain:
      "Another crew is already working in this checkout on this machine. Working here too will " +
      "mix the two sets of changes. Take your own worktree, or proceed with a written reason.",
    prominent:
      "⚠️ Do not proceed until you have read this. Another live crew holds this checkout on this " +
      "machine right now, and writing here would interleave your changes with theirs in one " +
      "working tree — neither of you would be able to commit cleanly. Create your own worktree " +
      "and work there. If you genuinely need this checkout, say why: the reason is recorded.",
  },
  predicate(context: InterventionContext): InterventionVerdict {
    // A linked worktree is a *separate working tree* on the same machine and
    // the same repository, which is exactly what `(machine, repo)` cannot
    // distinguish. Two crews each in their own worktree are the healthy,
    // intended arrangement — the working practice this repository is built
    // around — so firing on them would refuse the normal case on every file
    // edit, which is the failure that teaches a session to distrust a guard.
    //
    // Strictly `true`: `undefined` means the claim recorded no worktree, and
    // an unknown working tree is not a known-separate one. That direction
    // keeps the entry cautious about *suppressing* itself while staying
    // cautious about firing, and it is the same reading of absence the rest
    // of this file uses.
    if (context.isLinkedWorktree === true) return { triggered: false };

    const holder = context.occupyingCrew;
    // Absent means nobody else holds it *or* the server could not tell, and
    // the two are read the same way. Blocking on an unanswered question is
    // how a guard becomes an obstacle, and this one would refuse the most
    // common case of all: an ordinary session on an unclaimed checkout.
    if (holder === undefined) return { triggered: false };
    return {
      triggered: true,
      // The message names the holder rather than only refusing. A caller
      // told *who* has it can go and ask; one told only "occupied" can do
      // nothing but override.
      message:
        `Another crew (root session ${holder.rootSessionId}) is already working in this checkout ` +
        `on item ${holder.itemId}` +
        (holder.branch === undefined ? "" : ` on branch ${holder.branch}`) +
        (holder.lastActiveSecondsAgo === undefined
          ? ""
          : `, last active ${holder.lastActiveSecondsAgo}s ago`) +
        ". Take your own worktree, or proceed with a written reason.",
      data: {
        rootSessionId: holder.rootSessionId,
        itemId: holder.itemId,
        ...(holder.branch === undefined ? {} : { branch: holder.branch }),
      },
    };
  },
};

/**
 * The built-in entries, in a fixed order.
 *
 * Fixed rather than incidental so that findings come back in the same order
 * for the same context — an evaluation whose output order depends on object
 * iteration is one whose digests are not diffable.
 *
 * Ordered by phase then by strength: the `pre` blocks first, because on a
 * `pre` event the strongest finding decides the call and reading the list
 * in the order it is evaluated is what makes a log of it legible.
 */
export const BUILTIN_INTERVENTIONS: readonly Intervention[] = [
  mergeWithoutApprovalAtTip,
  broadGitAddOnSharedCheckout,
  broadProcessKill,
  checkoutHeldByAnotherCrew,
  finishedWithNoReviewer,
  reviewWithoutApprovalAtTip,
];

/**
 * The catalogued entries this build does **not** implement, and why.
 *
 * Exported as a value rather than left as prose, because the reason an
 * entry is missing is exactly the kind of thing that decays into folklore:
 * six months from now "why is there no I2?" is answerable from here, and a
 * later row that adds the missing signal can delete its line as part of the
 * same change. The catalogue's own instruction is to *say so and stop* when
 * a situation needs something the server cannot see, and this is where that
 * saying-so lives.
 *
 * Each `missing` names the signal, not the feature — a schema finding is
 * more useful stated as the fact no part of this system can observe.
 */
export const UNIMPLEMENTED_CATALOGUE_ENTRIES: readonly {
  readonly id: string;
  readonly missing: string;
}[] = [
  {
    id: "I2",
    missing:
      "whether a row is unblocked. The dependency graph that decides it is prose in a milestone " +
      "document, not a relation between items, so 'the graph says this is available' is not a " +
      "question this schema can be asked.",
  },
  {
    id: "I3",
    missing:
      "whether a claim-holding session is working elsewhere. `lastActive` distinguishes a live " +
      "session from a dead one, which is the liveness sweep's question; this entry needs the " +
      "different fact that a live session is spending its calls on something other than the item " +
      "it holds, and nothing attributes a tool call to an item.",
  },
  {
    id: "I4",
    missing:
      "whether a subagent reported complete. A session's own completion is reported by its " +
      "release or its summary, but neither is attributable to a *parent* awaiting a handoff — " +
      "`Assignment.parentSessionId` names the parent, and nothing records that the parent was " +
      "told, so 'the orchestrator has not picked this up' cannot be told apart from 'the " +
      "orchestrator picked it up half a second ago'.",
  },
  {
    id: "I5",
    missing:
      "nothing — the signal exists (`Artifact.followUpItemId` is null on an `lgtm_with_followups` " +
      "review), and the merge gate already refuses that combination outright " +
      "(`merge.requires_linked_followup`). An intervention would fire only where the guard " +
      "already blocks, so it would be a second voice on a decision that is already made.",
  },
  {
    id: "I6",
    missing:
      "whether a worktree still exists on disk after a merge. The claim records a worktree path, " +
      "but only the machine can say whether that path is still there, and no call reports it.",
  },
  {
    id: "I8",
    missing: "a spend signal. It waits on what M7's telemetry exposes, which is not built yet.",
  },
  {
    id: "I13",
    missing:
      "nothing structural — a claim or artifact appearing for a session holding no item is " +
      "answerable from the assignment table. It is unbuilt because the near-match half of the " +
      "entry (an artifact recorded against a similarly-titled item) needs a similarity threshold " +
      "nobody has chosen, and a guess would refuse correct calls.",
  },
  {
    id: "I14",
    missing:
      "a cumulative view of a session's own tool calls. The rows exist, but reaching them from a " +
      "predicate means the context assembler carrying a windowed count on every call — which is " +
      "the per-call cost the assembly gate exists to avoid, and it needs a cheaper shape first.",
  },
  {
    id: "I16",
    missing:
      "the size of the directory a search is rooted at. The server cannot see the caller's " +
      "filesystem, so the hook would have to carry a scope and a size signal with the call, and " +
      "the hook reports no such field.",
  },
  {
    id: "I17",
    missing:
      "whether a commit is signed, and whose signature counts. A signature is a property of the " +
      "commit object rather than of any row here, and the trusted-key question the entry itself " +
      "flags as unsettled has to be answered before a rule could mean anything.",
  },
  {
    id: "I9",
    missing:
      "whether an unblocked row is sitting idle — the same absent dependency graph I2 needs. The " +
      "`sleep` half is readable from the command; the half that makes it worth saying is not.",
  },
];
