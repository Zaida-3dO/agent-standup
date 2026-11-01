// Guard: `executing` **from** `plan_review` requires an approved plan. See
// docs/plans/MILESTONES.md #17, SCHEMA.md §16
// ("`executing` from `plan-review` | A `plan-review` artifact with
// `verdict = approved`.").
//
// **Existence only** — was a `plan_review` artifact with `verdict =
// 'approved'` ever recorded for this item. Deliberately does not also ask
// whether that approval is still current: `evidence-at-tip.ts` registers
// that as its own guard on the same `(plan_review, executing)` pair, so a
// nudge here always means "never approved" and a nudge from the tip guard
// always means "approved, but stale" — two distinct causes stay two
// distinct warnings instead of collapsing into one guard's ambiguous "no".
//
// **A missing approval is a nudge, not a refusal.** Executing without an
// approved plan is a process gap the item can close afterwards (approve the
// plan, or reopen if the approval comes back with changes), and the board's
// rule is to nudge process rather than block it.
import { guardNudged, guardOk, type Guard, type GuardInput } from "../state-machine/guard";
import { hasApproval } from "./artifact-tip";

export const planApprovalGuard: Guard = {
  id: "artifact.plan_approval",
  description:
    "Entering executing from plan_review nudges when no approved plan_review artifact exists — " +
    "the transition is applied, and the answer says to get the plan approved.",
  appliesTo: (from, to) => from === "plan_review" && to === "executing",
  async check(input: GuardInput) {
    const ok = await hasApproval(input.db, input.item.id, "plan_review");
    if (!ok) {
      return guardNudged(
        "No approved plan_review artifact for this item — executing was entered without an " +
          "approved plan. Get the plan reviewed and approved now; if the review comes back " +
          "with changes, reopen the item rather than leaving executing as the record.",
      );
    }
    return guardOk;
  },
};
