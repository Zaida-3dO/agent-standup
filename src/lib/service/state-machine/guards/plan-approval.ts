// Guard: `executing` **from** `plan_review` requires an approved plan. See
// docs/plans/MILESTONES.md #17, SCHEMA.md §16
// ("`executing` from `plan-review` | A `plan-review` artifact with
// `verdict = approved`.").
//
// **Existence only** — was a `plan_review` artifact with `verdict =
// 'approved'` ever recorded for this item. Deliberately does not also ask
// whether that approval is still current: `evidence-at-tip.ts` registers
// that as its own guard on the same `(plan_review, executing)` pair, so a
// rejection here always means "never approved" and a rejection from the tip
// guard always means "approved, but stale" — two distinct causes stay two
// distinct rejections instead of collapsing into one guard's ambiguous "no".
import type { Guard, GuardInput } from "../guard";
import { guardOk, guardRejected } from "../guard";
import { hasApproval } from "./artifact-tip";

export const planApprovalGuard: Guard = {
  id: "artifact.plan_approval",
  description: "Entering executing from plan_review requires an approved plan_review artifact.",
  appliesTo: (from, to) => from === "plan_review" && to === "executing",
  async check(input: GuardInput) {
    const ok = await hasApproval(input.db, input.item.id, "plan_review");
    if (!ok) {
      return guardRejected(
        "No approved plan_review artifact for this item — get the plan reviewed and approved before executing.",
        { fields: ["state"] },
      );
    }
    return guardOk;
  },
};
