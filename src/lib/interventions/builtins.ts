// Two built-in interventions — deliberately two, not the catalogue.
//
// `docs/plans/INTERVENTIONS.md` holds a growing list of situations worth
// detecting. **Building that list is not this row's work.** What is wanted
// here is proof that the shape in `./types.ts` and `./registry.ts` can carry
// a real entry, so the two chosen are the two that exercise opposite ends of
// it:
//
//   - **I11** is `pre`, blocks, and is conditional on context rather than on
//     the command text — the exact shape a pattern list structurally could
//     not express, which is why this mechanism exists at all.
//   - **I7** is `post`, nudges, and could not block even if someone
//     configured it to. It proves the invariant has a real subject.
//
// Both obey the contract the eventual custom entries will need: they read
// only the context handed to them, they return a verdict, and they emit
// nothing.

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
 * The built-in entries, in a fixed order.
 *
 * Fixed rather than incidental so that findings come back in the same order
 * for the same context — an evaluation whose output order depends on object
 * iteration is one whose digests are not diffable.
 */
export const BUILTIN_INTERVENTIONS: readonly Intervention[] = [
  broadGitAddOnSharedCheckout,
  reviewWithoutApprovalAtTip,
];
