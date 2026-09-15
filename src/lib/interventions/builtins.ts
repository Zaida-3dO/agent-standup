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

import {
  isBroadProcessKill,
  isMergeAttempt,
  isMergedByRefComparison,
  isRebaseOrDivergenceCheck,
  isWorkRecordingCommand,
} from "./commands";
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
  // Row 4c423f0b-f1c8-4930-ad5b-e1d7aabe5c10, same fix as
  // `broad-process-kill` (row f53e667a-97da-4b10-bded-8a3c50836a85): "say
  // why: the reason is recorded" promised an exit that no caller could ever
  // take. Removed; the message still names the one remedy that actually
  // works — staging by path.
  //
  // Two halves of that, and both need saying, because the first half alone
  // reads as false. An override channel DOES exist in the wire
  // protocol (`src/lib/hook/override.ts`), it is honoured, and it is
  // tested. But it is read from the TOP LEVEL of the hook payload only, by
  // design, and an agent influences nothing there — its tool call arrives
  // in `tool_input`, where a claim is refused. This entry's audience is
  // `agent`. So the conclusion the original comment drew is still exactly
  // right for everyone this message is shown to, even though its premise
  // is not: the exit is real, and unreachable from here.
  messages: {
    plain:
      "This stages every modified file in a checkout other sessions are also working in, so it " +
      "would commit their work under your name. Stage your own files by path instead.",
    prominent:
      "⚠️ Do not proceed until you have read this. This `git add` stages every modified file in a " +
      "checkout that other sessions are working in right now — their uncommitted work would be " +
      "committed under your name and attributed to your change. Stage your own files explicitly " +
      "by path instead.",
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
  // Row 4c423f0b-f1c8-4930-ad5b-e1d7aabe5c10, same fix as
  // `broad-process-kill` (row f53e667a-97da-4b10-bded-8a3c50836a85): the
  // override channel exists in the wire protocol and `decide` honours it,
  // but it is read from the TOP LEVEL of the payload only, and an agent's
  // tool call reaches nothing but `tool_input`. So "proceed with a written
  // reason" promised an exit that this entry's audience — `agent`, above —
  // could never take. Removed; the message names the remedy that actually
  // works instead.
  //
  // That remedy has to name a CALL, not an outcome. The previous wording,
  // "request a review against this commit", is what the caller already
  // wants; it says nothing about how to get it, which is why the override
  // sentence was the only part of the refusal that looked executable. Two
  // sessions lost their merge phase here.
  //
  // The round half is named because it is the half that is missed. The
  // service-side guard (`merge.requires_approving_code_review`) does the
  // per-limb diagnosis once a merge is actually attempted — it knows the
  // round number, the tip, and which artifact kinds moved the round, and
  // says so. This message runs earlier, on the command, with none of those
  // facts resolved, so it deliberately does NOT restate that analysis. It
  // names the call and warns which conjunct usually failed; the service
  // refusal supplies the numbers if the caller still gets it wrong.
  //
  // **Backticks here mean "this is a call", and nothing else.** Only
  // `record_artifact` is backticked below; the artifact kinds and verdicts
  // are written as bare prose on purpose. `tests/interventions-message-
  // remedies.test.ts` sweeps every message for backticked snake_case and
  // requires each token to be a real operation, because a message naming a
  // call that does not exist sends the reader hunting for a tool it will
  // never find. Backticking `code_review` or `check_run` — which are
  // artifact kinds, not operations — trips that sweep, and it is right to:
  // the reader cannot tell the two apart from the formatting alone.
  // **This message deliberately carries no analysis of review ROUNDS.**
  // `hasAnyApproval === false` is required, so every firing of this entry
  // is an item nothing has *ever* approved — and an explanation of how an
  // existing approval gets demoted would be advice about a situation that
  // by construction did not occur. That explanation belongs on
  // `mergeWithStaleApproval`, which is the entry that finds it.
  messages: {
    plain:
      "This merges work that nothing has ever approved — there is no approving code review on " +
      "this item at any round. Call `record_artifact` with kind code_review and an approving " +
      "verdict, naming the commit being merged, and land that instead of merging now. If you " +
      "believe this merge is right anyway, the reason you give is what makes it reviewable.",
    prominent:
      "⚠️ Do not proceed until you have read this. This would merge a change that nothing has " +
      "ever approved: no approving code review exists on this item at any round, so it is not " +
      "that a review went stale — none was recorded. Call `record_artifact` with kind " +
      "code_review, an approving verdict, and the commit being merged as its sha; then merge. " +
      "Instead of merging now, land the approval first — and if you proceed regardless, the " +
      "reason you record is what makes the decision reviewable afterwards.",
  },
  predicate(context: InterventionContext): InterventionVerdict {
    if (context.command === undefined) return { triggered: false };
    if (!isMergeAttempt(context.command)) return { triggered: false };
    // Strictly `false`. `undefined` means the server could not answer the
    // question — no claim, or no commit to be at the tip of — and blocking
    // a merge on an unanswered question is how a guard becomes an obstacle.
    if (context.hasApprovalAtTip !== false) return { triggered: false };
    // **The narrowing that made this entry worth blocking again.** An item
    // that has been approved before is the stale-approval case, which
    // `mergeWithStaleApproval` below picks up as a nudge. Strictly `false`
    // for the same reason as above: `undefined` is an unasked question, and
    // an unasked question must not be read as "never reviewed".
    if (context.hasAnyApproval !== false) return { triggered: false };
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
 * **I10b** — merging work that *was* approved, where the approval does not
 * stand at the tip.
 *
 * ── Why this is its own entry, with numbers ────────────────────────────
 *
 * This situation and I10's share a command and a first condition, and they
 * deserve opposite answers — so they are two entries, because one entry's
 * `level` cannot soften one without softening the other. The recorded
 * evidence is lopsided: the **approval half has a confirmed true positive**
 * (a genuinely unapproved merge, correctly stopped), while this half
 * produced **fifteen firings and one true positive.** Fourteen sessions
 * were stopped from merging work that had been reviewed.
 *
 * The reason the false-positive rate is that high is not a detection bug,
 * and I10's own message says so in as many words: the item's
 * review round is the highest round across **every** artifact kind, so
 * recording a `check_run` or a commit artifact after an approval demotes
 * that approval *without anything about the code changing*. The dominant
 * cause of this entry firing is therefore bookkeeping, not risk — and
 * blocking a merge on bookkeeping is how a guard teaches people to route
 * around it.
 *
 * ── Why a nudge rather than a softer block ─────────────────────────────
 *
 * Because the remedy is cheap and the reader is the right person to judge
 * it. A session told *"this was approved, the approval does not stand at
 * the tip, here is why that usually happens"* can re-record it in seconds
 * if the change is real, or proceed knowing the demotion was an artifact.
 * Neither needs a refusal. What the fourteen needed was the explanation,
 * which they now get without losing their merge phase.
 *
 * **It cannot double-fire with I10.** The two predicates are mutually
 * exclusive by construction: both require `hasApprovalAtTip === false`, and
 * they then split on `hasAnyApproval` being strictly `false` against
 * strictly `true`. A context that answers neither triggers nothing at all.
 */
const mergeWithStaleApproval: Intervention = {
  id: "merge-with-stale-approval",
  source: "builtin",
  summary:
    "A merge where an approving review exists but does not stand at the current round and tip.",
  phase: "pre",
  audience: "agent",
  defaultLevel: "nudge",
  // Immediate for the same reason I23 is: this is a fact needed to read the
  // call being made right now. Five minutes later the merge has happened or
  // been abandoned, and the explanation is worthless either way.
  defaultTiming: "immediate",
  messages: {
    plain:
      "This item has been approved before, but the approval does not stand at the current round " +
      "and tip. Most often nothing about the code changed: the review round is the highest " +
      "round across every artifact kind, so recording a check_run or a commit artifact after an " +
      "approval demotes it on its own. Check which of the two happened: if the code changed " +
      "since the review, re-record the approval at the current round before merging.",
    prominent:
      "⚠️ The approving review on this item does not stand at the commit being merged. Check " +
      "which of the two happened before you proceed: if the code changed after the review, it " +
      "needs reviewing again — call `record_artifact` with kind code_review and the commit " +
      "being merged. If nothing changed and a check_run or commit artifact was simply recorded " +
      "after the approval, the round moved on its own and the approval is stale only on paper; " +
      "re-record it at the current round to make the board agree with reality.",
  },
  predicate(context: InterventionContext): InterventionVerdict {
    if (context.command === undefined) return { triggered: false };
    if (!isMergeAttempt(context.command)) return { triggered: false };
    if (context.hasApprovalAtTip !== false) return { triggered: false };
    // The mirror of I10's clause. Strictly `true`: an unasked question is
    // not evidence that an approval exists.
    if (context.hasAnyApproval !== true) return { triggered: false };
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
  // This level is `block-overridable`, and the name is accurate about the
  // protocol: a caller CAN re-run the call naming this entry with a written
  // reason, and `decide` releases it and records that reason against the
  // finding (`src/lib/hook/override.ts`). That path is live and tested.
  //
  // **It is not reachable from this entry's audience, which is `agent`.**
  // The claim is read from the top level of the hook payload only; an
  // agent's tool call reaches `tool_input` and nothing else, and a claim
  // there is refused by design. The channel is therefore real for a caller
  // that composes its own stdin, and unavailable to every caller who will
  // ever read the messages below.
  //
  // **So the messages below deliberately do not mention the override, and
  // neither does anything else any more.** `overrideRemedy` used to append
  // a generic override offer to every `block-overridable` refusal; it now
  // returns `null` for exactly the reason this comment gives. What a
  // message owes the caller is the *narrow* exit — which pid form to use —
  // and that is now the whole of what a refusal here says.
  //
  // A message must only offer an exit the protocol can honour. An offer the
  // caller cannot act on costs several attempts before anyone concludes it
  // is not negotiable, which is the failure this whole entry is written
  // against: the pid advice below is worth giving precisely because the
  // parser reads every pid-scoped form it names.
  // ── Why the messages describe the finding rather than the command ──────
  //
  // `isBroadProcessKill` blocks on TWO different findings: a kill that names
  // an executable, and a kill this build cannot decompose at all
  // (`unparseable` — a `/FI` filter, a selector it cannot read). A message
  // asserting "this ends every process matching a name" is true of the
  // first and false of the second, so it cannot be stated flatly on both.
  //
  // A false sentence here is the expensive kind: specific, confident, and
  // about the caller's own command. A reader who can falsify the first
  // sentence has reason to discount the second, and the second sentence —
  // kill by process id — is the part worth keeping.
  //
  // So the wording states only what is known at the point of refusal: the
  // command ends processes and this build cannot tell which. That holds on
  // both branches, since an image name is itself an unread selector one
  // target wide. The pid advice is safe to give because the parser honours
  // every pid-scoped form it names — `-Force`, `/F`, a comma list, and a
  // shell wrapper all decompose to pid targets.
  messages: {
    plain:
      "This ends processes without naming which ones — it selects them by image name, or by a " +
      "selector this build cannot read, so it cannot tell what would be killed. Other sessions " +
      "on this machine are likely running something that matches. Kill by process id instead: " +
      "a command naming literal process ids is accepted however many it names, and a force flag " +
      "does not change that.",
    prominent:
      "⚠️ Do not proceed until you have read this. This kill is not scoped to specific " +
      "processes — it selects them by name, or by a selector this build cannot decompose, and " +
      "other sessions on this machine are very likely running something that matches. Find the " +
      "process ids and kill those instead; naming literal ids is what makes a kill narrow, not " +
      "the absence of a force flag.",
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
 * ── Keyed on the working tree, with `(machine, repo)` as the prefilter ──
 *
 * The pair alone was the original key, on the reasoning that
 * `Assignment.worktree` is unnormalised free text — `/path/to/repo`,
 * `/path/to/repo/` and a differently-cased spelling of one directory do not
 * compare equal as strings, and a predicate over raw equality would pass
 * silently on exactly the collisions it exists to catch.
 *
 * That reasoning is sound about *naive* comparison and it is why the
 * comparison now runs over a normal form (`./worktree.ts`) rather than over
 * the raw column. What the pair could never do is distinguish two crews
 * sharing one directory from two crews each in their own sibling worktree
 * of the same repository — identical `(machine, repo)`, opposite verdicts —
 * and the second is the arrangement every parallel dispatch here uses. Keyed
 * on the pair alone the entry fired on the healthy case on every file edit,
 * which three separate crews hit on 2026-08-31 and which is how a guard
 * teaches its users to route around it.
 *
 * So the machine and repository narrow the candidates to claims that could
 * possibly share a tree, and the normalised paths decide whether they do.
 *
 * **What is not caught, stated plainly:** two crews in one checkout where
 * either claim recorded no worktree at all. `worktree` is optional on
 * `claim`, so that is common rather than rare. The alternative — reading an
 * unrecorded path as "same tree" — blocks every crew that omitted an
 * optional field, which is the failure being fixed. `../interventions/context.ts`
 * carries the full argument.
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
  // Row 4c423f0b-f1c8-4930-ad5b-e1d7aabe5c10, same fix as
  // `broad-process-kill` (row f53e667a-97da-4b10-bded-8a3c50836a85):
  // "proceed with a written reason" / "say why: the reason is recorded"
  // promised an exit that no caller could ever take — in all three of this
  // entry's messages, including the dynamic one built in the predicate
  // below. Removed; each still names the one remedy that actually works —
  // taking your own worktree.
  //
  // Stated precisely, because the short version above is false on its face
  // now: an override channel DOES exist in the wire protocol and `decide`
  // honours it. It is read from the top level of the payload only, and an
  // agent — this entry's audience — can reach nothing but `tool_input`. So
  // the promise is keepable in principle and unkeepable by anyone who will
  // read these messages, which is why they carry no override offer and why
  // `overrideRemedy` returns `null` rather than adding one.
  //
  // Each message also names **the working tree it matched**, at the request
  // of the third crew to hit the false positive: *"the fix with the best
  // ratio is probably not either behaviour change — it is printing what the
  // guard keyed on."* All three refusals that day told a crew already in its
  // own worktree to take its own worktree, so the honest inference was that
  // the guard could see something the crew could not, and each crew spent
  // minutes re-verifying `git rev-parse` output to establish otherwise. A
  // refusal that shows the path it matched makes a wrong match visible in
  // one line instead of costing a re-verification.
  messages: {
    plain:
      "Another crew is already working in this same working tree. Working here too will mix the " +
      "two sets of changes. Take your own worktree instead.",
    prominent:
      "⚠️ Do not proceed until you have read this. Another live crew holds this working tree " +
      "right now, and writing here would interleave your changes with theirs in one checkout — " +
      "neither of you would be able to commit cleanly. Create your own worktree and work there " +
      "instead.",
  },
  predicate(context: InterventionContext): InterventionVerdict {
    // This predicate deliberately does **not** consult
    // `context.isLinkedWorktree`, and the reason is worth stating because the
    // field looks like it answers the question.
    //
    // It describes only the *caller* — whether this session's own claim
    // recorded a worktree path. It says nothing about where the holder is,
    // which is the entire question here. Keyed on it, the entry becomes a
    // blanket exemption hanging off an optional field: absent, and a crew
    // alone in its own worktree is refused; present, and two crews sharing
    // one checkout are both excused. One line, wrong in both directions.
    //
    // The comparison now happens where both sides are visible — the
    // assembler compares this claim's normalised worktree against each
    // candidate holder's (`../interventions/context.ts`) — so an
    // `occupyingCrew` here has already been established to be in *this*
    // working tree. A crew in its own sibling worktree produces no holder
    // and falls out below, which is where the exemption genuinely lives:
    // in a comparison that can see both paths.
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
        `Another crew (root session ${holder.rootSessionId}) is already working in this same ` +
        `working tree on item ${holder.itemId}` +
        (holder.branch === undefined ? "" : ` on branch ${holder.branch}`) +
        (holder.lastActiveSecondsAgo === undefined
          ? ""
          : `, last active ${holder.lastActiveSecondsAgo}s ago`) +
        // Naming the matched tree is what makes a wrong match checkable
        // against `git rev-parse --show-toplevel` in one step rather than
        // several. Absent only when this claim recorded no path, and the
        // entry cannot fire in that case at all.
        (context.claimedWorktree === undefined
          ? ""
          : `. Matched on working tree ${context.claimedWorktree}`) +
        ". Take your own worktree, or ask that crew.",
      data: {
        rootSessionId: holder.rootSessionId,
        itemId: holder.itemId,
        ...(holder.branch === undefined ? {} : { branch: holder.branch }),
      },
    };
  },
};

/**
 * **I13** — work is being recorded against no item at all.
 *
 * The entry with the most expensive incident behind it, in the owner's own
 * account of a five-crew night: *"PR2+3 was never minted as a task. I
 * dispatched that crew — the most valuable PR of the five — without a task
 * existing. Nobody caught it because the follow-up task had a similar
 * name."* Five parallel crews were being tracked in a person's head rather
 * than against the board, so the board drifted from reality **without
 * anything failing loudly** — which is the failure this whole product
 * exists to remove.
 *
 * ── Half the catalogue entry, deliberately ─────────────────────────────
 *
 * The catalogue asks for two signals. This builds one of them.
 *
 * The half **not** built is the near-match: an artifact recorded against an
 * item whose title merely resembles the one the caller meant. That needs a
 * similarity threshold nobody has chosen, and every available choice is
 * wrong in a way that matters — too loose refuses correct calls on a board
 * where "Build the X" and "Review the X" are ordinary neighbouring titles,
 * and too tight never fires. A guessed threshold on a `block` would refuse
 * real work, so it stays unbuilt with its reason recorded rather than
 * shipping as a number picked to look reasonable.
 *
 * The half built here needs no threshold at all: either the session holds a
 * claim or it does not, and that is a row rather than a judgement.
 *
 * ── Why a nudge and not a block ────────────────────────────────────────
 *
 * The catalogue asks for `nudge (prominent)`, and that is right for a
 * reason worth stating: **an unminted commit is not a wrong commit.** The
 * work is usually good — in the incident it was the most valuable PR of the
 * five — and refusing it would delete nothing but the record of it. What is
 * missing is the board row, and the remedy is to create one, which is a
 * thing the caller does *alongside* the commit rather than instead of it.
 * A block would also fire on every operator commit in every repository this
 * server watches, which is the "fires and annoys" failure that earns an
 * entry a 1.
 *
 * ── Why `holdsClaim === false` and never `itemId === undefined` ────────
 *
 * They look interchangeable and are not. `itemId` is absent both when the
 * session holds nothing *and* when the assembler never looked, because
 * assembly is gated on the call's shape. Keying on it would fire on every
 * call the gate declined to look up — most calls in the system. The
 * dedicated field is written only by a lookup that ran.
 */
const workRecordedAgainstNoItem: Intervention = {
  id: "work-recorded-against-no-item",
  source: "builtin",
  summary: "A commit or push from a session that holds no item, so the work is on no board row.",
  phase: "pre",
  audience: "orchestrator",
  defaultLevel: "nudge",
  defaultTiming: "immediate",
  messages: {
    plain:
      "You are recording work while holding no item, so nothing on the board knows this exists. " +
      "Create a task for it with `create_task` and claim that, or say plainly that this commit " +
      "is not task work.",
    prominent:
      "⚠️ This commit is being made by a session that holds no item — the board has no row for " +
      "this work, so it exists only in this session. That is how a valuable change goes missing: " +
      "nothing is tracking it and nothing will notice it stalled. Mint it now with `create_task` " +
      "and `claim` the result, or state plainly that this is not task work.",
  },
  predicate(context: InterventionContext): InterventionVerdict {
    if (context.command === undefined) return { triggered: false };
    if (!isWorkRecordingCommand(context.command)) return { triggered: false };
    // Strictly `false`. `undefined` means the lookup did not run, and
    // nudging a session about a claim nobody asked about would fire on
    // every call the assembly gate declined — the failure that teaches a
    // session to ignore the guard.
    if (context.holdsClaim !== false) return { triggered: false };
    return { triggered: true, data: { command: context.command } };
  },
};

/**
 * **I14** — an orchestrator that has quietly become the builder.
 *
 * Requested by the owner as *"you are doing work you should probably be
 * delegating to a subagent"*. The drift is the finding, not any single
 * call: an orchestrator reads and edits its way through a change the crew
 * it should have spawned never gets spawned for.
 *
 * ── It supersedes a pattern-matching hook, and that is the argument ────
 *
 * The catalogue records that this overlaps `fm-always-delegate-nudge` in
 * the installation it came from **and supersedes it**. That hook matches
 * write-shaped commands against a path allowlist — the approach #125
 * retired — and it fires on a single call, which is wrong in both
 * directions: one edit is often exactly the right call, and the research
 * reads before a dispatch are the job rather than a lapse. What a path
 * allowlist structurally cannot see is the thing that actually decides the
 * question: whether this session holds its item **as an orchestrator**.
 * That is a column, and it is why this entry belongs server-side.
 *
 * ── Cumulative, and why the threshold is not a guess ───────────────────
 *
 * The signal is a count of hands-on calls over a recent window, which is
 * `../telemetry/shape.ts`'s existing reading rather than a second one
 * invented here — the same `isWriteTool` classification, the same window,
 * the same `unknown` answer on too small a sample. Reusing it matters for a
 * reason beyond tidiness: a threshold this entry chose for itself would
 * drift from the one `get_session_shape` reports, and a session told it is
 * "elevated" by one reading and normal by another has been given noise.
 *
 * **`unknown` is not `elevated`.** A session a few calls old has not
 * established anything, and firing there would nudge every orchestrator on
 * its opening moves — the failure that teaches a reader to skip the digest.
 *
 * ── A digest nudge, addressed to the orchestrator ──────────────────────
 *
 * `digest` rather than `immediate` because nothing here is urgent to the
 * second and the drift is by definition already underway; the catalogue's
 * own argument is that a batch arriving at a natural juncture gets acted on
 * while a trickle gets skipped. `post`, because it describes what a session
 * has already been doing — there is no single call to refuse, and refusing
 * an edit that is legitimately the orchestrator's own would be exactly the
 * wrongness the superseded hook was retired for.
 */
const orchestratorDoingTheWork: Intervention = {
  id: "orchestrator-doing-the-work",
  source: "builtin",
  summary: "A session holding its item as orchestrator that is accumulating hands-on edits itself.",
  phase: "post",
  audience: "orchestrator",
  defaultLevel: "nudge",
  defaultTiming: "digest",
  messages: {
    plain:
      "You are holding this item as an orchestrator and have been editing files yourself for a " +
      "while. Spawn a crewmate for the rest of it, or release the item and claim it as a builder " +
      "so the board reflects who is doing the work.",
    prominent:
      "⚠️ You claimed this item as an orchestrator and have since been doing the building " +
      "yourself — the crew you would have dispatched has not been spawned, and the board still " +
      "reads as though one is working. Either spawn a crewmate for the remaining work, or " +
      "release and re-claim this item as a builder so what the board says is true.",
  },
  predicate(context: InterventionContext): InterventionVerdict {
    // The role is the whole point of the entry: an ordinary builder editing
    // files is doing its job, and only a session that took the item as an
    // orchestrator can be drifting away from having dispatched it.
    if (context.claimedRole !== "orchestrator") return { triggered: false };
    // `undefined` is "too little evidence to say" and `normal` is "looked,
    // and it is fine". Neither is a finding — treating unknown as elevated
    // would nudge every orchestrator on its first few calls.
    if (context.handsOnWork !== "elevated") return { triggered: false };
    return {
      triggered: true,
      ...(context.itemId === undefined ? {} : { data: { itemId: context.itemId } }),
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
/**
 * **I23** - checking whether a branch merged, by comparing commit refs.
 *
 * The detection is cheap and the failure it prevents is expensive, which is
 * an unusual combination in this catalogue and the reason this entry is
 * worth having despite being, in essence, a documentation lookup.
 *
 * This project squash-merges. A squash produces one new commit with a new
 * sha, and the branch's own commits are never ancestors of it - so every
 * ref-comparison reports "not merged" for work that merged perfectly well
 * an hour ago. The answer is *correct for the question asked* and wrong for
 * the question meant, which is precisely the shape a session cannot debug
 * by looking harder at the output. Sessions have concluded a merge failed,
 * re-run it, and re-opened settled work on the strength of it.
 *
 * A nudge, never a block: the command is a read, it harms nothing, and the
 * caller may well know exactly what it is doing. What is worth supplying is
 * the fact that makes the output interpretable.
 */
const squashMergeRefComparison: Intervention = {
  id: "merged-check-by-ref-comparison",
  source: "builtin",
  summary:
    "Checking whether a branch merged by comparing refs, in a repository that squash-merges.",
  phase: "pre",
  audience: "agent",
  defaultLevel: "nudge",
  // Immediate rather than digest, and it is the exception that proves the
  // rule: a fact needed to read the output of the call being made right now
  // is worthless five minutes after that output was misread.
  defaultTiming: "immediate",
  messages: {
    plain:
      "This project squash-merges, so a merged branch's commits never appear on the target " +
      "branch and a ref comparison will report it as unmerged. Check the pull request's own " +
      "state, or look for the squash commit by message, instead.",
    prominent:
      "This ref comparison will say the branch is NOT merged even if it merged cleanly. " +
      "A squash merge lands the whole branch as a single new commit, so none of its commits " +
      "are ancestors of the target branch. Check the pull request's own state instead, and do " +
      "not re-merge or re-open the work on the strength of this output.",
  },
  predicate(context: InterventionContext): InterventionVerdict {
    if (context.command === undefined) return { triggered: false };
    if (!isMergedByRefComparison(context.command)) return { triggered: false };
    return { triggered: true };
  },
};

/**
 * **I24** - rebasing, or checking whether a branch has diverged from main.
 *
 * The advice this carries is a working practice rather than a correctness
 * rule, which is why it is a nudge and why its message is phrased as a
 * default rather than an instruction: **bias to fixing forward.** A branch
 * being behind main is not a problem in itself, and the work of proving it
 * would merge cleanly is usually work that produces nothing - main moves
 * again immediately, so an early rebase means rebasing twice. What actually
 * warrants a rebase is a real conflict preventing the merge; a semantic
 * conflict is better fixed forward, on the branch, where it is visible.
 *
 * Recognising the *check* as well as the rebase is deliberate. By the time
 * `git rebase` is typed the decision has been made and the calls spent; the
 * divergence check is where it is still cheap to say "you may not need to".
 */
const rebaseRestraint: Intervention = {
  id: "rebase-before-checking-for-conflicts",
  source: "builtin",
  summary:
    "A rebase, or a divergence check that usually precedes one, where fixing forward is cheaper.",
  phase: "pre",
  audience: "agent",
  defaultLevel: "nudge",
  defaultTiming: "immediate",
  messages: {
    plain:
      "Rebasing is often wasted work here: main moves several times an hour, so a branch that " +
      "is merely behind does not need rebasing. Rebase only if there are real merge conflicts " +
      "preventing the merge; for semantic conflicts, bias toward fixing forward.",
    prominent:
      "Consider not doing this. Main purity is not worth much here - main moves several times " +
      "an hour, so rebasing early usually means rebasing twice. Only rebase if there are " +
      "actual merge conflicts blocking the merge. If the conflict is semantic, fix it forward " +
      "on the branch instead.",
  },
  predicate(context: InterventionContext): InterventionVerdict {
    if (context.command === undefined) return { triggered: false };
    if (!isRebaseOrDivergenceCheck(context.command)) return { triggered: false };
    return { triggered: true };
  },
};

/**
 * **I25** - several items are waiting on a visual review at once.
 *
 * A visual reviewer is the most expensive agent this system dispatches: it
 * needs a browser, it holds one of a small pool of slots, and it spends its
 * budget looking at a rendered page. Dispatching one per pull request when
 * four are in flight buys four sets of screenshots of four intermediate
 * states, most of which are superseded before anybody reads them.
 *
 * The cheaper shape is to let them all merge and do one visual pass over
 * the result. What makes that safe rather than merely cheaper is that the
 * deferral is **recorded** - the message names the affordance, because
 * advice to defer a review with no way to record the deferral is advice to
 * forget it. `Artifact.followUpItemId` already carries exactly this
 * relationship for `lgtm_with_followups`, so a deferred visual review is a
 * review artifact linked to the item minted to do it later, rather than a
 * gap where a review should be.
 *
 * **Silent at one.** One pending visual review is not a batching
 * opportunity; firing there would nudge on the ordinary case and teach the
 * reader to skip it.
 */
const batchVisualReviews: Intervention = {
  id: "visual-reviews-in-flight-concurrently",
  source: "builtin",
  summary: "Several items awaiting visual review at once, where one pass after merge is cheaper.",
  phase: "post",
  audience: "orchestrator",
  defaultLevel: "nudge",
  // Rides the digest: this is a queue-shaped observation an orchestrator
  // acts on at a juncture, not a fact needed to read the current call.
  defaultTiming: "digest",
  messages: {
    plain:
      "Several items are waiting on a visual review, and dispatching a review agent per pull " +
      "request is expensive. Let them merge, then do a single visual pass over the result. " +
      "Record each deferral as a review linked to the item minted to carry it out.",
    prominent:
      "Multiple visual reviews are in flight at once. A visual reviewer needs a browser and " +
      "one of a small pool of slots, so one per pull request is the most expensive way to do " +
      "this - and most of what it screenshots is an intermediate state nobody reads. Let them " +
      "merge, then do one visual pass. Record each deferred review against the item minted to " +
      "carry it out, so a deferral is a link rather than a gap.",
  },
  predicate(context: InterventionContext): InterventionVerdict {
    const pending = context.pendingVisualReviews;
    // Absent is "the server did not count", which is not the same as zero
    // and must not be read as one. One is a review, not a batch.
    if (pending === undefined || pending < 2) return { triggered: false };
    return { triggered: true, data: { pendingVisualReviews: pending } };
  },
};

/**
 * **I19, narrowed** — dispatching again over a tool block nobody cleared.
 *
 * ── What this is NOT, stated first ─────────────────────────────────────
 *
 * The catalogued I19 asks whether the agent being spawned *right now* has
 * the tools its job needs. **That is still unbuilt and still unbuildable
 * here**, and this entry must not be read as coverage of it. The full
 * argument for why is recorded immediately below, under "Why the detection
 * half is unbuildable on this schema".
 *
 * It is recorded *here* because there is nowhere else left for it. I19 no
 * longer has an `UNIMPLEMENTED_CATALOGUE_ENTRIES` row to carry it: shipping
 * this predicate required deleting that row, because
 * `tests/interventions-registry.test.ts` asserts no catalogue id is both
 * built and listed unbuilt, and the assertion is right to. Deleting the row
 * without rehoming its reasoning would have discarded the analysis that
 * justifies the narrowing — which is the part a future reader needs most,
 * since "why was only half of this built" is the obvious question and the
 * registry now answers it nowhere.
 *
 * ── Why the detection half is unbuildable on this schema ───────────────
 *
 * Verbatim from the catalogue entry this replaced, because the conclusion
 * has not changed and the reasoning is the reason to trust it:
 *
 * > which tools a given job requires. The tool list a subagent was spawned
 * > with is on the spawn; that a reviewer on a UI territory needed a
 * > browser is a per-role judgement, and a rule that fires on every
 * > subagent without one would fire on every subagent that correctly had
 * > none. The `agent-standup` half reads as the tractable one and is not,
 * > on this schema: no column records the tool list a session was spawned
 * > with, and the hook event carries only the tool being called, so the
 * > sole available proxy is that an agent has recorded nothing. That fires
 * > on every agent which legitimately had nothing to record — a scout, a
 * > short crew, one that failed early — which is a guard that costs more
 * > than it saves. What would make it buildable is the spawn's tool list
 * > being recorded at dispatch. **Re-examined against the owner's stronger
 * > ask** — that a subagent lacking its tools should stall immediately and
 * > report, as a hard block rather than limping on — and the conclusion is
 * > unchanged for the detection half, for a reason worth stating
 * > precisely: the request describes behaviour at the moment of
 * > *spawning*, and this server never observes a spawn. It sees a
 * > session's tool calls once that session is already running, so by the
 * > time anything here could speak, the subagent has been dispatched and
 * > is underway — which is exactly the situation the ask exists to
 * > prevent. The stall-and-report half is genuinely reachable, but not
 * > from here: it belongs to whatever performs the dispatch, which is the
 * > only party holding both the requested tool list and the ability to
 * > refuse before the agent starts. Building a server-side predicate that
 * > fired after the fact would satisfy the letter of the entry while doing
 * > none of what was asked, and would read as coverage on the settings
 * > page.
 *
 * That argument leaves exactly one door open, and it is the one this entry
 * goes through.
 *
 * ── The narrower thing that IS observable ──────────────────────────────
 *
 * Once a dispatched agent has *told* the board it could not use a tool —
 * through `report_blocked_on_tool`, which exists for exactly this — the
 * situation stops being an inference and becomes a row. An orchestrator
 * that then spawns another agent on the same item, without having acted on
 * that report, is about to reproduce the failure it was just told about.
 * That is a fact established by a call rather than guessed from an absence,
 * which is the standard every other built entry here is held to.
 *
 * The cost of the narrowing is honest and worth naming: **the first agent
 * still hits the wall.** This cannot save it, because nothing here knows
 * anything until that agent speaks. What it prevents is the *second* and
 * the third — which is the shape both documented incidents actually took.
 * Three crews on 2026-08-19 and four on 2026-08-23 each hit one gap, one
 * after another, because nothing carried the first one's discovery forward
 * to the next dispatch.
 *
 * ── Why the message names the tool and its reason ──────────────────────
 *
 * The catalogue asks that this *"name what a crew type is actually
 * missing, not just remind in the abstract — the failure mode is a brief
 * confidently asserting a capability, so a generic reminder is weak
 * medicine."* The report carries the tool, the reason and the instruction
 * that could not be followed, so the nudge can quote all three.
 *
 * The reason split is what makes the remedy correct rather than plausible,
 * and getting it backwards wastes the round:
 *
 *   - **not_granted** — the tool is absent from the agent's definition. Add
 *     it by full name; there are no wildcards. And the edit **only takes
 *     effect in a new session**, so this session cannot test the fix it
 *     just made.
 *   - **refused** — the tool was granted and the call was refused anyway.
 *     Editing the tool list changes nothing, because the tool is already
 *     there. The fix is a different call, or handing over the claim the
 *     operation requires.
 *
 * ── Why a nudge and not a block ────────────────────────────────────────
 *
 * The catalogue asks for `nudge`, and dispatching over a known tool block
 * is often correct: the next agent may have a different job that never
 * touches the tool, or the orchestrator may have already fixed the
 * definition and be spawning the new session precisely because that is the
 * only way to pick the fix up. Blocking would refuse the remedy.
 */
const dispatchOverUnresolvedToolBlock: Intervention = {
  id: "dispatch-over-unresolved-tool-block",
  source: "builtin",
  summary:
    "Spawning another agent on an item where a previous one reported a tool it could not use.",
  phase: "pre",
  audience: "orchestrator",
  defaultLevel: "nudge",
  defaultTiming: "immediate",
  messages: {
    plain:
      "An agent on this item already stopped and reported a tool it could not use. Either grant " +
      "that tool in the new agent's definition by its full name — there are no wildcards — or " +
      "brief this one not to need it. Read the reason first: an agent-definition edit only takes " +
      "effect in a NEW session, and it fixes nothing when the tool was granted and refused.",
    prominent:
      "⚠️ You are dispatching over a tool block that has not been cleared. An agent on this item " +
      "already stopped to say a tool its brief named was unusable, and nothing since has " +
      "resolved it — so this dispatch is about to repeat it. Either add the tool to the agent's " +
      "definition by full name, or brief this agent not to need it. Read the reason before you " +
      "choose: a tool that was never granted needs that edit, and the edit only takes effect in " +
      "a NEW session — you cannot test it from this one. A tool that was granted and refused is " +
      "already in the list, so editing it changes nothing: call a different operation, or hand " +
      "over the claim the refused one requires.",
  },
  predicate(context: InterventionContext): InterventionVerdict {
    const blocks = context.unresolvedToolBlocks;
    // Absent means the server did not look, or looked and found none —
    // both read as no finding, like every other optional field here. An
    // empty array is never written, so this covers both spellings.
    if (blocks === undefined || blocks.length === 0) return { triggered: false };
    return {
      triggered: true,
      data: {
        tools: blocks.map((block) => block.tool),
        reasons: blocks.map((block) => block.reason),
      },
    };
  },
};

/**
 * **I26** — work committed to a branch that never became a pull request.
 *
 * ── Why this exists, and why it is `post` ──────────────────────────────
 *
 * The prompting incident is concrete: a branch committed, unmerged, with a
 * headline that said in so many words *"needs the mobile check and a PR"*,
 * sitting untouched for weeks. **No entry caught it, because none can fire
 * on a session that simply stops.**
 *
 * That is a category difference rather than a difficulty, and it decides
 * the phase. A `pre` entry fires on the **presence** of a call it can
 * inspect; this failure is the **absence** of one. There is no tool call at
 * the moment of failure — the session commits, and then nothing happens.
 * "Nothing" is not an event a matcher can match, so an entry that tried to
 * block here would be waiting for a call that by definition never comes.
 *
 * So it fires on some **later** tool call, whenever this session or the
 * next one touches the item again. The honest framing is *"soon after the
 * work stopped"*, never *"when the work stopped"* — and the digest timing
 * matches that: nothing here is urgent to the second, and a batch arriving
 * at a natural juncture is acted on where a trickle is skipped.
 *
 * ── Why the stage, and not a pair of booleans ──────────────────────────
 *
 * Keyed on `deliveryStage === "committed"`, which means a commit artifact
 * exists and no pull request does. The stage is deliberately exclusive: an
 * item that went on to open a pull request reports a later stage and this
 * entry goes quiet, rather than needing a second condition to remember to
 * check. An entry that kept firing after the situation was resolved is the
 * shape that earns a 1 and gets switched off.
 *
 * ── What a false positive costs ────────────────────────────────────────
 *
 * One digest line on an item whose branch is deliberately not a pull
 * request yet — work in progress, an experiment, a branch parked on
 * purpose. That is a real and reasonably common case, and it is why this is
 * a nudge on the digest rather than anything louder: the cost is a line of
 * advice the reader disagrees with, and the message says "or say what it is
 * waiting on" precisely so that the parked case has an answer that is not
 * "open a pull request you did not want".
 *
 * **It cannot be a block in any case** — `post` entries structurally
 * cannot, and holding a finished session hostage to bookkeeping would be
 * wrong even if they could.
 */
const committedWithNoPullRequest: Intervention = {
  id: "committed-with-no-pull-request",
  source: "builtin",
  summary: "An item with committed work on a branch and no pull request opened for it.",
  phase: "post",
  audience: "orchestrator",
  defaultLevel: "nudge",
  defaultTiming: "digest",
  messages: {
    plain:
      "This item has committed work on a branch and no pull request. A branch nobody opened a " +
      "pull request for will not merge on its own. Create the pull request, or record plainly " +
      "what it is waiting on.",
    prominent:
      "⚠️ This item's work is committed to a branch and no pull request exists for it. Nothing " +
      "downstream is watching a branch: no review will be requested, no CI verdict will be read, " +
      "and it will sit exactly as it is until somebody notices. Create the pull request now, or " +
      "record on the item what it is still waiting on so the next session does not have to " +
      "rediscover it.",
  },
  predicate(context: InterventionContext): InterventionVerdict {
    if (context.deliveryStage !== "committed") return { triggered: false };
    return {
      triggered: true,
      ...(context.itemId === undefined ? {} : { data: { itemId: context.itemId } }),
    };
  },
};

/**
 * **I27** — a pull request exists and nothing has asked for a review of it.
 *
 * The easy one, and it is easy for a reason worth stating: **both halves
 * are already first-class records.** A `pull_request` artifact is a row,
 * and `request_review` writes a `review_requested` event. So this judges no
 * intent and infers nothing from an absence of activity — it compares two
 * things the server already stores, which is the standard every other built
 * entry here is held to.
 *
 * ── Its relationship to I1, which it deliberately does not duplicate ───
 *
 * `finished-with-no-reviewer` keys on the item's **state** (`in_review`
 * with no approval at tip) — an item that has already announced it is
 * waiting. This fires one step earlier, at the point the pull request
 * exists and nobody has asked for anything yet, which is a different
 * moment and a different remedy: I1 says *spawn a reviewer for work that is
 * waiting*, this says *the work is ready and has not asked*. The stage
 * vocabulary keeps them from both firing on one situation — once a review
 * is requested this entry is silent, and I1 takes over.
 *
 * ── What a false positive costs ────────────────────────────────────────
 *
 * One digest line where a reviewer was dispatched out of band without
 * `request_review` being called. That case is real, and the message treats
 * it as an answer rather than an error: recording the request is the point,
 * because a review nobody recorded is one the board cannot see either.
 */
/**
 * How long a pull request is left alone before this entry speaks.
 *
 * ── Chosen from reasoning, NOT from measurement — stated plainly ───────
 *
 * The honest position first: **this number is not derived from data.** The
 * right way to set it is to measure real items from `pull_request` artifact
 * to `review_requested` event and put the window past the normal case. That
 * query needs the production database, which is not reachable from the
 * machine this was built on, so no sample was taken and none is claimed. If
 * this is later measured and the normal gap turns out longer, this constant
 * is the one thing to change.
 *
 * ── Why fifteen minutes is nonetheless defensible ──────────────────────
 *
 * The entry rides the **digest**, which batches at roughly five-minute
 * intervals. So the smallest window that changes any behaviour at all is one
 * digest cycle, and a window of one cycle would fire on the second digest —
 * barely different from the first. Three cycles is the first value that
 * gives an agent a genuinely uninterrupted stretch to finish its own flow:
 * open the pull request, write the handoff, call `request_review`. That
 * sequence is minutes of work, not seconds, and it is the sequence the owner
 * means by *"a chance to go through its flow naturally"*.
 *
 * ── Which way it errs, which is the reason it is not shorter ───────────
 *
 * Too short and the entry nudges agents who were already doing the thing,
 * which is the false positive this window exists to delete and the kind that
 * teaches a reader to skip the channel. Too long and a genuinely forgotten
 * pull request waits an extra few minutes to be mentioned — on an item that
 * is, by construction, not going anywhere. The costs are plainly asymmetric,
 * so this rounds generous.
 *
 * Deliberately a constant rather than a setting: it is a property of how an
 * agent's flow is paced, not something an operator has evidence to tune, and
 * exposing it would invite raising it until the entry never fires.
 */
const PULL_REQUEST_GRACE_SECONDS = 15 * 60;

const pullRequestWithNoReviewRequested: Intervention = {
  id: "pull-request-with-no-review-requested",
  source: "builtin",
  summary: "A pull request opened on an item where nothing has requested a review of it.",
  phase: "post",
  audience: "orchestrator",
  defaultLevel: "nudge",
  defaultTiming: "digest",
  messages: {
    plain:
      "This item has an open pull request and no review has been requested for it. Request one, " +
      "or record that a reviewer is already looking.",
    prominent:
      "⚠️ A pull request exists on this item and nothing has requested a review of it. The pull " +
      "request will not route itself to anyone: request the review now. If a reviewer was " +
      "already dispatched out of band, record the request anyway — a review the board cannot " +
      "see is one nothing downstream can wait for.",
  },
  predicate(context: InterventionContext): InterventionVerdict {
    if (context.deliveryStage !== "pull_request_open") return { triggered: false };
    // The grace window. Absent is "cannot tell" and stays silent — firing on
    // an unknown age would put the entry back exactly where it was before
    // the window existed, on every item whose artifact carried no timestamp.
    const age = context.pullRequestAgeSeconds;
    if (age === undefined || age < PULL_REQUEST_GRACE_SECONDS) return { triggered: false };
    return {
      triggered: true,
      ...(context.itemId === undefined ? {} : { data: { itemId: context.itemId } }),
    };
  },
};

/**
 * **I28** — a `lgtm_with_nits` merge whose findings nothing is tracking.
 *
 * ── Why this is not I5, which is catalogued unbuilt for a good reason ──
 *
 * I5 covers `lgtm_with_followups` with no linked follow-up, and it is
 * listed unbuilt because **nothing is missing**: `merge.requires_linked_followup`
 * already refuses that exact combination at the merge gate, so an entry
 * would be a second voice on a decision already made.
 *
 * `lgtm_with_nits` is the opposite case, and the asymmetry is the whole
 * finding. Beneath that verdict a finding at `medium` or above blocks the
 * merge (`service/guards/merge-findings.ts`), which is correct — the
 * verdict claims only cosmetic work remains, so a non-cosmetic finding
 * contradicts its own terms. An `info` or `low` finding correctly does
 * **not** block. And that is the whole of its effect: below the blocking
 * threshold a finding is written to durable storage and then has no further
 * lifecycle at all — no state, no owner, no follow-up, no expiry. The
 * findings live inside an artifact on a row that is now closed. Technically
 * retrievable; practically invisible.
 *
 * ── The equilibrium this is really protecting ──────────────────────────
 *
 * The cost is not the individual forgotten nit. It is that a reviewer who
 * wants a finding to survive has exactly one lever — **inflate it to
 * `medium` so it blocks** — while a reviewer who grades honestly watches
 * the finding evaporate. Over enough reviews that either inflates
 * severities or trains reviewers to stop recording sub-blocking findings,
 * and the second is worse: it removes the evidence that the problem exists.
 * A recorded, reported instance had nine findings age out against a closed
 * row, one of which was a live hazard for the feature being built next, and
 * a person rather than the product was the backstop.
 *
 * ── Why a nudge, and why `immediate` ───────────────────────────────────
 *
 * A nudge because the verdict's entire meaning is *this does not block*,
 * and an entry that blocked here would contradict the thing it is
 * enforcing. Overridable in the only sense a nudge can be: it names the
 * number and asks where the findings went, and *"actioned in this pull
 * request"*, *"minted as an item"* and *"judged not worth doing"* are all
 * complete answers. Silence is the only one that is not.
 *
 * `immediate` rather than the digest, unlike its two siblings above, and
 * the difference is the window. I26 and I27 describe work that will still
 * be there in five minutes. This one describes a row that is **closing** —
 * once the session moves on, the findings are behind a merged item and the
 * session that knew what they meant is gone. The moment to ask is while the
 * reader still holds the context that makes the answer cheap.
 *
 * ── What a false positive costs ────────────────────────────────────────
 *
 * One immediate line where the nits were genuinely actioned inside the same
 * pull request — which is common, and is the most likely wrong match by
 * some distance. It is cheap on purpose: nothing is blocked, and the
 * message accepts "already done here" without demanding a row be minted to
 * prove it. The alternative reading — requiring a linked item — would push
 * callers to mint bookkeeping rows for nits they had already fixed, which
 * is how a guard teaches its users to route around it.
 */
const nitsMergedWithNothingTrackingThem: Intervention = {
  id: "nits-merged-with-nothing-tracking-them",
  source: "builtin",
  summary:
    "A merged item whose review returned lgtm_with_nits with findings that nothing is tracking.",
  phase: "post",
  audience: "orchestrator",
  defaultLevel: "nudge",
  defaultTiming: "immediate",
  messages: {
    plain:
      "This item's review returned lgtm_with_nits with findings, and nothing is tracking them. " +
      "Say where they went: actioned in this change, minted as an item, or judged not worth " +
      "doing. Any of those is fine; silence is not.",
    prominent:
      "⚠️ This item merged on a lgtm_with_nits verdict carrying findings that nothing is now " +
      "tracking. They were correctly not blocking — and below that threshold a finding has no " +
      "owner, no state and no expiry, so it will age out inside an artifact on a closed row. " +
      "Record where they went: actioned in this change, minted as a follow-up item, or " +
      "deliberately dropped. If recording them is consistently this manual, that is the reason " +
      "reviewers inflate severities to make findings survive.",
  },
  predicate(context: InterventionContext): InterventionVerdict {
    const nits = context.untrackedNits;
    // Absent means the server did not look, or looked and found the
    // situation resolved — both read as no finding. A zero count is never
    // written: a nits verdict that recorded nothing has nothing to lose.
    if (nits === undefined || nits.findingCount < 1) return { triggered: false };
    return {
      triggered: true,
      data: {
        findingCount: nits.findingCount,
        ...(context.itemId === undefined ? {} : { itemId: context.itemId }),
        ...(nits.reviewRound === undefined ? {} : { reviewRound: nits.reviewRound }),
      },
    };
  },
};

/**
 * **I29** — dispatching another crew when several are already in flight.
 *
 * ── The trigger was recorded without an action; this is the action ─────
 *
 * The owner's note names the situation only — *"for large orchestration
 * jobs, i.e. orchestrator is dispatching more than 2 crews at the same
 * time"* — and stops there, so the remedy below is a proposal rather than a
 * transcription, and it is worth saying what it is NOT. It does not tell
 * the orchestrator to dispatch fewer crews. Parallelism is the point of the
 * mechanism, the board exists to coordinate it, and an entry whose advice
 * is "do less of the thing this system is for" would be correctly ignored.
 *
 * What goes wrong at width is not the count, it is what the count makes
 * likely, and both failures are recorded here rather than hypothesised:
 *
 *   - **Overlapping territory.** `checkout-held-by-another-crew` exists
 *     because two crews in one checkout commit over each other. That entry
 *     fires when the collision is already happening; this one fires at the
 *     moment the orchestrator is choosing the territories, which is the
 *     only point where avoiding it is free.
 *   - **Review capacity that was never planned.** Four builders finishing
 *     together need four reviews, and `visual-reviews-in-flight-
 *     concurrently` is the record of that bill arriving unplanned.
 *
 * So the remedy is: confirm the territories are disjoint, and decide the
 * review plan now rather than when the pull requests land. Both are cheap
 * at dispatch time and expensive afterwards, which is the test every entry
 * in this catalogue has to pass.
 *
 * ── Why three, and why it counts items rather than agents ──────────────
 *
 * Three because the owner said "more than 2", and because two is the
 * ordinary shape — a builder and a reviewer, or two independent tasks — so
 * firing there would nudge the common case and teach the reader to skip it.
 * `concurrentCrewItems` counts DISTINCT items under one root session, so
 * the builder-plus-reviewer pair on one item reads as one front rather than
 * two; the reasoning is on the field and in `crewWidthFor`.
 *
 * ── A nudge, and `immediate` rather than the digest ────────────────────
 *
 * ── The worktree test, added after the entry shipped ───────────────────
 *
 * The owner's correction: *"I think this should only be if those 3 are on
 * the same worktree… There's no need to be cautious if they are on separate
 * worktrees."* He is right, and the signal was already in the rows the width
 * query read — `Assignment.worktree` sat in them and was never looked at.
 * Three crews in three separate trees cannot commit over each other, so the
 * territory half of this advice has nothing to say to them, and an entry
 * that speaks anyway is teaching its reader to skip it.
 *
 * **What keeps this honest is that `worktree` is optional on `claim`.** So
 * there are three outcomes rather than two, and they are not collapsed:
 * every path recorded and all distinct (silent); two or more sharing a tree
 * (fires, naming the tree and the items); or some claim recording no path
 * at all (fires, saying the check could not be completed). The third is the
 * one a careless implementation loses — reading "no overlap found" as "no
 * overlap" would silence the entry precisely where it knows least.
 *
 * The comparison runs over the normal form (`./worktree.ts`) and the message
 * shows the raw path, for the reason `claimedWorktree` records: a normalised
 * form is the right thing to compare and the wrong thing to display.
 *
 * ── Why review capacity does not speak on its own ──────────────────────
 *
 * Worth naming, because the entry's reasoning above gives two failures at
 * width and only one of them reaches the disjoint case. Review capacity is
 * real at width — four builders finishing together need four reviews — but
 * the owner has judged it not worth a nudge by itself, and that judgement is
 * respected rather than worked around by keeping a second reason to fire.
 *
 * A nudge because dispatching a fourth crew is frequently right and this
 * entry cannot tell whether the territories are *logically* disjoint — only
 * whether they share a checkout. `immediate` because, unlike its digest-riding siblings,
 * the decision it speaks to is being made *by the call it rides on*: the
 * dispatch is in flight, and advice to plan the territories arrives
 * worthless five minutes after the agent was spawned.
 */
const wideCrewDispatch: Intervention = {
  id: "dispatching-into-a-wide-crew",
  source: "builtin",
  summary: "Spawning another agent while this crew already holds several items at once.",
  phase: "pre",
  audience: "orchestrator",
  defaultLevel: "nudge",
  defaultTiming: "immediate",
  messages: {
    plain:
      "This crew already holds several items at once, and they are not all in separate " +
      "worktrees. Check that the new agent's territory does not overlap the ones in flight " +
      "before you add it — two crews in one checkout commit over each other — and decide now " +
      "who reviews all of this, rather than when the pull requests land together. If every " +
      "crew is in its own worktree, this one is safe to disregard.",
    prominent:
      "⚠️ You are dispatching into a crew that is already several items wide, and the claims " +
      "do not show them all in separate worktrees. Two things go wrong at this width, and both " +
      "are cheap to prevent right now and expensive afterwards. First, territory: if the new " +
      "agent's files overlap a crew already working, they will commit over each other, and a " +
      "shared checkout makes that near-certain — the finding data names the tree and the items " +
      "sharing it. Second, review capacity: every one of these finishes needing a review, and " +
      "deciding that plan when the pull requests arrive together is how a visual pass per pull " +
      "request gets dispatched. Say what the new agent's territory is, check it is disjoint " +
      "from the others, and record who reviews the batch. If some claims recorded no worktree, " +
      "this could not be checked rather than having failed — recording a worktree on `claim` " +
      "is what makes the check possible next time.",
  },
  predicate(context: InterventionContext): InterventionVerdict {
    const width = context.concurrentCrewItems;
    // Absent is "the server did not count", never zero. "More than 2" is
    // the owner's threshold, so three is the first width that speaks.
    if (width === undefined || width < 3) return { triggered: false };

    // ── The territory test, per the owner's correction ──────────────────
    //
    // Absent means the territory was never examined, which is not the same
    // as "disjoint" — so it falls through to firing, carrying no claim
    // either way. Width alone remains a reason to speak when nothing is
    // known about where the crews are.
    const territory = context.crewTerritory;
    if (territory !== undefined) {
      // **Silent when the check ran and found no overlap.** Three crews in
      // three separate trees cannot commit over each other, and telling
      // them to go and check is the noise that trains a reader to skip hook
      // output. Requires `unrecordedWorktrees === 0`: with any claim
      // missing a path the comparison was incomplete, and an empty
      // `sharedTrees` then means "found nothing" rather than "there is
      // nothing".
      if (territory.sharedTrees.length === 0 && territory.unrecordedWorktrees === 0) {
        return { triggered: false };
      }
      return {
        triggered: true,
        data: {
          concurrentCrewItems: width,
          sharedTrees: territory.sharedTrees,
          unrecordedWorktrees: territory.unrecordedWorktrees,
        },
      };
    }

    return { triggered: true, data: { concurrentCrewItems: width } };
  },
};

/**
 * **I32** — crew are still running and the orchestrator has not looked.
 *
 * The entry the `wait_for_crew` crew declined to write, and was right to:
 * the signal it needed did not exist. `InterventionContext` carried
 * `isOrchestrator` and nothing saying whether crew were actually *in
 * flight*, so the only predicate writable at the time was "you are an
 * orchestrator" — which fires on every orchestrator on every qualifying call
 * forever, catches nothing, and is precisely the pattern two notes in
 * `feedback/` already record as a guard that gets switched off. That row is
 * now built (`crewInFlight`), so this is.
 *
 * ── Why the count is the whole entry ───────────────────────────────────
 *
 * `crewInFlight` counts *holders still running* under this session's root,
 * excluding the session itself. It deliberately does not reuse
 * `concurrentCrewItems`, which counts items held: an orchestrator whose six
 * crew have all finished still holds six items, so keyed on that number this
 * would nudge somebody whose crew had already come home — advice to go and
 * check on nobody.
 *
 * ── Why absent is silence, and why that is not merely caution ──────────
 *
 * Absent means the assembler never counted — a call that did not qualify, a
 * session with no claim, or a builder rather than an orchestrator. `0` is a
 * real answer meaning it counted and nobody is running. The two must not
 * collapse, because they lead to opposite advice: "I cannot tell" and "you
 * are free to stop" are different sentences, and only one of them is safe to
 * say to someone whose crew may be mid-flight.
 *
 * ── Why a nudge, on the digest ─────────────────────────────────────────
 *
 * A nudge because having crew running is the ordinary healthy state of an
 * orchestrator — this is not a defect being reported, it is a reminder that
 * the work needs collecting. The digest because the advice keeps: crew that
 * are running now will still be running in five minutes, and `standup crew
 * wait` is just as useful then. That is the same test
 * `nits-merged-with-nothing-tracking-them` states for the split — `immediate`
 * is for a row that is *closing*, where the context evaporates once the
 * session moves on, and nothing evaporates here.
 *
 * ── Its relationship to the stop catch, which it does not duplicate ────
 *
 * `../hook/stop-catch.ts` asks the same question at the moment a session
 * tries to *end its turn*, and that is a different moment with a different
 * remedy: there, the turn is about to close and the crew's work would land
 * in a session that has stopped listening. This one rides an ordinary
 * `post` call, where the orchestrator is still working and the reminder is
 * simply that there is a cheaper way to find out than polling. The two are
 * kept apart deliberately rather than merged, because a single entry firing
 * on both would have to choose one timing, and the right timing genuinely
 * differs.
 */
const crewInFlightWithoutCheckIn: Intervention = {
  id: "crew-in-flight-without-check-in",
  source: "builtin",
  summary: "Crew are still running under this orchestrator, which has not waited on them.",
  phase: "post",
  audience: "orchestrator",
  defaultLevel: "nudge",
  defaultTiming: "digest",
  messages: {
    plain:
      "Your crew are still running. Call `standup crew wait --since <cursor> &` to background a " +
      "wait — it returns the moment one of them does something, rather than you polling the board.",
    prominent:
      "⚠️ You have crew still running and nothing waiting on them. Work that finishes into a " +
      "session which has stopped listening is indistinguishable from work that failed — nobody " +
      "reads the result and nothing merges. Call `standup crew wait --since <cursor> &` now to " +
      "background a wait: it returns the moment a crew member reports, so you collect the work " +
      "instead of rediscovering it later.",
  },
  predicate(context: InterventionContext): InterventionVerdict {
    const crew = context.crewInFlight;
    // Absent is "not counted", never zero — see the field's own note. A
    // session whose crew state could not be determined must not be nudged.
    if (crew === undefined || crew < 1) return { triggered: false };
    return { triggered: true, data: { crewInFlight: crew } };
  },
};

/**
 * **I30** — a visual review deferred with nothing recording the deferral.
 *
 * ── The half of I25 that was advice rather than a mechanism ────────────
 *
 * I25 tells an orchestrator to let concurrent pull requests merge and do
 * one visual pass afterwards, and its message asks that each deferral be
 * *"recorded as a review linked to the item minted to carry it out"*. The
 * owner's ask is specifically that this be **first class** — *"there should
 * be a first class way to handle 'review deferred because of concurrency'"*
 * — because advice to defer a review with no way to record the deferral is
 * advice to forget it.
 *
 * The affordance itself already exists and needed no schema change:
 * `Artifact.followUpItemId` carries exactly this relationship, and the
 * merge gate's `merge.requires_linked_followup` already enforces it for
 * `lgtm_with_followups`. What was missing is that **nothing noticed when it
 * was skipped.** An item flagged `needsVisualReview` that reaches a merged
 * state with neither a visual review nor a link to one is a deferral that
 * was taken but never written down — and it is indistinguishable, a week
 * later, from a visual review nobody ever thought about.
 *
 * ── Why this is not a duplicate of I25 ─────────────────────────────────
 *
 * Different moment, different remedy, and they cannot both fire on one
 * situation. I25 fires *before*, on a queue of several pending reviews, and
 * says "batch these". This fires *after*, on one item that closed without
 * its review being either done or linked, and says "the deferral you took
 * is not recorded". An orchestrator that follows I25's advice and records
 * the link never sees this entry at all — which is the property that makes
 * it a completion check rather than a second opinion.
 *
 * ── Why a nudge, and why `immediate` ───────────────────────────────────
 *
 * A nudge because deferring is legitimate and this cannot tell a deferral
 * from a decision that the visual review was never needed — both are
 * answers, and the message accepts either. `immediate` for I28's reason:
 * this describes a row that is **closing**, and once the session moves on,
 * the context that makes "why was this deferred" cheap to answer is gone.
 */
const visualReviewDeferredWithoutRecord: Intervention = {
  id: "visual-review-deferred-without-record",
  source: "builtin",
  summary:
    "An item needing a visual review closing with neither a review nor a link to one that will.",
  phase: "post",
  audience: "orchestrator",
  defaultLevel: "nudge",
  defaultTiming: "immediate",
  messages: {
    plain:
      "This item was flagged as needing a visual review and is closing without one, and nothing " +
      "records where that review went. Record the item minted to carry it out, or say plainly " +
      "that the visual review is not needed.",
    prominent:
      "⚠️ This item needed a visual review, is closing without one, and no link records what " +
      "happened to it. Deferring a visual review is fine — batching several into one pass after " +
      "they merge is cheaper and is the advice this system gives. What is not fine is deferring " +
      "it to nowhere: once this row closes, a deferral nobody wrote down is indistinguishable " +
      "from a review nobody thought of. Record the follow-up item that will carry the pass, or " +
      "say that the visual review is not needed and why.",
  },
  predicate(context: InterventionContext): InterventionVerdict {
    // Strictly `true`. Absent means the server did not look, and an unasked
    // question is not a deferral.
    if (context.visualReviewDeferredUnrecorded !== true) return { triggered: false };
    return {
      triggered: true,
      ...(context.itemId === undefined ? {} : { data: { itemId: context.itemId } }),
    };
  },
};

/**
 * **I31** — putting a question to the person before trying to answer it.
 *
 * ── The objection this entry has to answer, stated first ───────────────
 *
 * This situation was argued against, at length and correctly, and the
 * argument is worth keeping because it decides the entry's shape:
 * **judging whether a question is justified requires reading intent**,
 * which nothing here can do; and a false positive is uniquely invisible,
 * because a question that is suppressed is never asked, so neither the
 * agent nor the person ever learns it was wanted. That makes it the one
 * entry whose harm cannot be measured after the fact.
 *
 * The owner's answer is what makes it buildable, and it is a measurement
 * answer rather than a detection one: *"maybe have a way to log how often
 * that intervention ran and how often the agents decided they could figure
 * it out themselves vs how often the agent genuinely felt there was
 * justification to ask. let's build it and add logging."* The unmeasurable
 * harm becomes measurable the moment the split is recorded, so **the
 * logging is not an accompaniment to this entry — it is the precondition
 * that makes shipping it defensible.**
 *
 * ── How the split is recorded, without a parallel store ────────────────
 *
 * Every firing already becomes an `intervention_events` row, so the *how
 * often it ran* half needs nothing new. The *what the agent did next* half
 * rides the existing scoring path, which is the one Ope asked for over a
 * new store: the session rates the firing through `score_intervention`, and
 * the two outcomes land as opposite ends of a scale that already means
 * exactly this —
 *
 *   - **The agent worked it out alone.** The nudge did its job, or the
 *     question was never needed. A 4 or a 5.
 *   - **The agent asked anyway, and was right to.** The question was
 *     justified and the nudge was noise on it. A 2, or a 1 if it cost time.
 *
 * `get_intervention_scores` then aggregates per entry, so "how often did
 * this suppress a question that should have been asked" is answerable as
 * the low-score share against this id, with the notes saying why. That is
 * the measurement the objection said was impossible, and it exists because
 * the scale was already built to carry it.
 *
 * ── Why a nudge, and never anything stronger ───────────────────────────
 *
 * The asymmetry from the objection holds completely and is the reason this
 * level is not a matter of taste. A false positive on a **block** suppresses
 * a question invisibly to both parties — the failure this entry was
 * originally refused for. A false positive on a **nudge** costs one line of
 * advice the reader disagrees with and then asks anyway.
 *
 * It is also what makes the logging work at all: the split can only be
 * observed if the agent remains free to ask. An entry that blocked would
 * destroy the very measurement that justifies its existence, so `nudge` is
 * load-bearing here rather than merely cautious.
 *
 * ── Why it fires on every question, and why that is honest ─────────────
 *
 * It cannot tell a justified question from an unjustified one, and it does
 * not try. What it does is put the check *in front of* the question at the
 * one moment it is cheap — before the person's attention is spent — and
 * name the three things that are almost always worth trying first. A reader
 * who has already done them loses a line; a reader who has not gets the
 * prompt that saves the interruption.
 *
 * `immediate`, necessarily: advice about a question is worthless after the
 * question has been asked.
 */
const askingWithoutTryingFirst: Intervention = {
  id: "asking-without-trying-first",
  source: "builtin",
  summary: "A question put to the person, where the answer may be reachable without them.",
  phase: "pre",
  audience: "agent",
  // **Never stronger than a nudge.** A block here suppresses a question
  // invisibly to both parties and destroys the outcome split that justifies
  // the entry existing. See the header.
  defaultLevel: "nudge",
  defaultTiming: "immediate",
  messages: {
    plain:
      "Before asking: can you answer this yourself? Read the code or the item body, check the " +
      "brief you were given, and take the more sensible reading of an ambiguity and say which " +
      "you took. Ask anyway if it is genuinely unsafe, irreversible, or a decision only the " +
      "person can make — then rate this with score_intervention so the split between questions " +
      "that were needed and questions that were not is on the record.",
    prominent:
      "⚠️ You are about to spend the person's attention. Three things answer most questions " +
      "without them: read the code or the item body, re-read the brief you were given, and — " +
      "where a spec is ambiguous and one reading is clearly more sensible — take that reading, " +
      "implement it, and say plainly which you took and why. If the question survives all " +
      "three, it is worth asking: genuinely unsafe or irreversible work, or a judgement that is " +
      "the person's to make, should always be asked about. Either way, rate this firing with " +
      "score_intervention — a high score if you worked it out alone, a low one if the question " +
      "was justified and this was noise. That split is the only way this entry can be judged.",
  },
  predicate(context: InterventionContext): InterventionVerdict {
    // Strictly `true`, like every other optional reading here.
    if (context.isAskingUser !== true) return { triggered: false };
    return {
      triggered: true,
      ...(context.tool === undefined ? {} : { data: { tool: context.tool } }),
    };
  },
};

export const BUILTIN_INTERVENTIONS: readonly Intervention[] = [
  mergeWithoutApprovalAtTip,
  mergeWithStaleApproval,
  askingWithoutTryingFirst,
  broadGitAddOnSharedCheckout,
  broadProcessKill,
  checkoutHeldByAnotherCrew,
  workRecordedAgainstNoItem,
  finishedWithNoReviewer,
  reviewWithoutApprovalAtTip,
  orchestratorDoingTheWork,
  squashMergeRefComparison,
  rebaseRestraint,
  batchVisualReviews,
  dispatchOverUnresolvedToolBlock,
  wideCrewDispatch,
  committedWithNoPullRequest,
  pullRequestWithNoReviewRequested,
  nitsMergedWithNothingTrackingThem,
  visualReviewDeferredWithoutRecord,
  crewInFlightWithoutCheckIn,
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
      "question this schema can be asked. `Item.blockedOnType` admits `person`, " +
      "`external_process` and `time` and has no `item` member, so one row cannot even be " +
      "recorded as waiting on another. Revisited deliberately rather than inherited: building " +
      "the graph to serve one digest nudge would be the largest piece of work in the catalogue " +
      "commissioned on the weakest evidence, and if the graph is worth having it is worth " +
      "having for the board's own ordering, as its own row. The cheap substitute — treating an " +
      "item with no open children as unblocked — was rejected too, because it would fire on " +
      "every leaf in the backlog, which is most of the board.",
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
      "an acknowledgement — nothing records that a parent was *told* its subagent finished. " +
      "Stated carefully, because the previous wording led with attribution and was read as " +
      "claiming a subagent cannot be linked to its parent at all, which is false and was " +
      "challenged as such: `Assignment.parentSessionId` and `Assignment.rootSessionId` are both " +
      "stored, the latter is indexed, and `crewWidthFor` and `crewInFlightFor` both already " +
      "query on it. So the finishing half is fully observable — a released assignment under a " +
      "root whose orchestrator still holds a live claim is one query, and it is the same query " +
      "the crew-in-flight count makes with `releasedAt IS NOT NULL`. What no column carries is " +
      "the other side: 'the orchestrator has not picked this up' is indistinguishable from 'the " +
      "orchestrator picked it up half a second ago', because collection is not an event anybody " +
      "writes. Recording one is a real design question — whether acknowledgement means reading " +
      "a notification, moving the item, or simply the next tool call — and is its own row rather " +
      "than a detail to settle inside another change. Note also that even a perfect " +
      "acknowledgement signal needs a grace window, for the reason " +
      "`pull-request-with-no-review-requested` needs one: the gap between a subagent finishing " +
      "and its parent noticing is frequently seconds, and an entry without a window would fire " +
      "almost entirely on orchestrators who were already collecting the work.",
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
    id: "I18",
    missing:
      "the tier the selector would have recommended for this job. The tier a subagent was spawned " +
      "at is knowable; what it should have been is a judgement made by a service this schema does " +
      "not hold, and comparing against nothing is how a nudge becomes noise. Wanted alongside it: " +
      "the recommendation recorded at dispatch, so the comparison is against what was advised " +
      "rather than against a guess made afterwards.",
  },
  {
    id: "I20",
    missing:
      "whether the caller intends to complete the parent. A `create_subtask` is visible and so is " +
      "its parent's state, but the thing that makes a subtask the wrong shape is an intent held " +
      "by the session and stated nowhere — the same call is correct when the follow-up really is " +
      "a prerequisite. Readable from a completion attempt that follows shortly after, which makes " +
      "this a `post` check on the parent rather than a `pre` check on the create.",
  },
  {
    id: "I21",
    missing:
      "whether the SQL bodies were read before the claim. Both halves nearly exist — the " +
      "tool-call stream shows which files a session opened, and a changeset names its migrations " +
      "— but the claim itself is prose in a note or a report, and deciding that a sentence " +
      "characterises a migration as safe is the part nothing here can do. A keyword match on " +
      "`additive` would miss every paraphrase and fire on every accurate use of the word.",
  },
  {
    id: "I22",
    missing:
      "that an authorisation does not exist. A question addressed to a person is visible; " +
      "recognising that the protocol it names was invented requires knowing the full set of real " +
      "ones, which lives in an installation's own operating documents rather than in this schema. " +
      "The tractable half is the second signal — an item parked as blocked whose stated blocker " +
      "names paths rather than a dependency — and it is worth building alone. The other half of " +
      "this pair is not an intervention at all: a hold that actually holds at merge time.",
  },
  {
    id: "I9",
    missing:
      "whether an unblocked row is sitting idle — the same absent dependency graph I2 needs. The " +
      "`sleep` half is readable from the command; the half that makes it worth saying is not.",
  },
];
