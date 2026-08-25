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

import { isBroadProcessKill, isMergeAttempt, isWorkRecordingCommand } from "./commands";
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
export const BUILTIN_INTERVENTIONS: readonly Intervention[] = [
  mergeWithoutApprovalAtTip,
  broadGitAddOnSharedCheckout,
  broadProcessKill,
  checkoutHeldByAnotherCrew,
  workRecordedAgainstNoItem,
  finishedWithNoReviewer,
  reviewWithoutApprovalAtTip,
  orchestratorDoingTheWork,
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
    id: "I19",
    missing:
      "which tools a given job requires. The tool list a subagent was spawned with is on the " +
      "spawn; that a reviewer on a UI territory needed a browser is a per-role judgement, and a " +
      "rule that fires on every subagent without one would fire on every subagent that correctly " +
      "had none. The `agent-standup` half is the tractable one — a spawned agent that records " +
      "nothing is visible without knowing anything about the territory.",
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
