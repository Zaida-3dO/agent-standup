// `repair_stuck_projects` — finds every parentless, childless item and, on
// request, files each one under a project so it becomes a transitionable
// task. SCHEMA.md §1, DECISIONS.md §13c.
//
// ── What "stuck" means, precisely ───────────────────────────────────────
//
// An item is stuck when it is a **project with no children and no terminal
// state**. Each half of that matters:
//
//   - **A project** has no state of its own — its column is derived from its
//     children — so the state machine refuses to transition it.
//   - **With no children**, there is no child whose completion could derive
//     one either.
//
// Neither route to a resolved state exists, so the row reads as open
// permanently no matter what actually happened to the work. That is not a
// hypothetical shape: a bulk import from a store with no project/task
// distinction types every root it loads as a project, and ordinary tasks
// arrive as projects in exactly this condition.
//
// A project with children is **not** stuck — it derives its column from them,
// which is the design working — and is never touched here. A parentless item
// in a terminal state is also skipped: its column already reads as finished,
// so moving it would be churn against a row that is not broken.
//
// ── Why it is idempotent, and why that is a property rather than a hope ──
//
// The scan's own predicate is what makes the second run a no-op. A repaired
// row has a parent, so it is a task, so it falls outside "parentless" — it
// cannot be selected twice, and there is no marker to write or read to
// achieve that. Running this ten times has the same effect as running it
// once, because each run leaves nothing that the next one matches.
//
// ── Why it never invents a parent ───────────────────────────────────────
//
// The one parent it will file an item under is the one the caller names, and
// `projectId` is required. There is no heuristic that guesses a project from
// an item's area, title or history: a wrong guess files real work under a
// project it does not belong to, which is harder to notice and harder to undo
// than the stuck row it replaced. `"inbox"` is available and is the honest
// default for a caller that does not know — it says "these need triage",
// which is true, rather than asserting a relationship that is not.
//
// ── Dry run is the default ──────────────────────────────────────────────
//
// `apply` defaults to `false`, so the first call anyone makes reports what
// it *would* touch and changes nothing. A repair pass over a whole
// installation is exactly the operation whose blast radius should be
// readable before it happens, and defaulting the other way would make the
// safe call the one you have to remember to ask for.
import { z } from "zod";
import { defineOperation } from "../operation";
import type { ServiceContext } from "../context";
import {
  applyMove,
  assertDepthFits,
  assertNoCycle,
  loadItem,
  resolveParent,
  subtreeOf,
} from "../items/reparent-core";
import { resolveInboxProject } from "../items/inbox-project";
import { INBOX_PROJECT_ID } from "./create-task";

/**
 * The states that mean the work is over, one way or another — the same four
 * `hierarchy.ts` and `transition.ts` treat as completed. Re-declared rather
 * than imported for the reason that guard gives for doing the same: the
 * question here ("is this row's column already resolved") is a different cut
 * of the vocabulary from "does entering this state stamp `completedAt`", and
 * the two sets coinciding is a fact about the vocabulary rather than a
 * dependency either should carry.
 */
const TERMINAL_STATES: readonly string[] = ["merged", "research_done", "wont_do", "cancelled"];

const inputSchema = z
  .object({
    /**
     * The project every repaired item is filed under — an item id, or the
     * literal `"inbox"`. Required even for a dry run, so the report says
     * where the items would actually go rather than describing a move whose
     * destination is still unknown.
     */
    projectId: z.string().trim().min(1, "projectId is required"),
    /** Restricts the scan to one area. Omitted scans every area. */
    area: z.string().trim().min(1).optional(),
    /** `false` (the default) reports what would move and writes nothing. */
    apply: z.boolean().default(false),
  })
  .strict();

export type RepairStuckProjectsInput = z.infer<typeof inputSchema>;

/** One stuck row, as the report names it. */
export interface StuckItem {
  readonly id: string;
  readonly title: string;
  readonly area: string;
  /** The state already on the row — what it keeps, and transitions from, after repair. */
  readonly state: string;
}

export interface RepairStuckProjectsResult {
  /** Whether anything was written. `false` on a dry run. */
  readonly applied: boolean;
  /** The project the items were (or would be) filed under, resolved past any sentinel. */
  readonly projectId: string;
  /** Every stuck row found. On an applied run, every one of these was moved. */
  readonly items: readonly StuckItem[];
  readonly count: number;
}

interface StuckRow {
  id: string;
  title: string;
  area: string;
  state: string;
}

// Stryker disable all : this metadata is a module-level literal, read into
// the registry at import — before any test body runs and never re-evaluated
// — so a mutation here is unkillable by construction, NOT untested.
// `scripts/check-operation-metadata-mutants.mjs` requires this and carries
// the full reasoning, including why moving the assertions into a test body
// does not help.
export const repairStuckProjects = defineOperation({
  name: "repair_stuck_projects",
  kind: "write",
  summary:
    'Finds parentless, childless, non-terminal items — which can neither be transitioned (a project has no state of its own) nor resolved by a child completing — and files each under a project so it becomes a transitionable task. Reports without writing unless apply is true. Idempotent: a repaired item has a parent, so it falls outside the scan. Pass projectId as a project id or the literal "inbox"; no parent is ever guessed.',
  // Stryker restore all
  input: inputSchema,
  contract: {
    rules: [
      {
        fields: ["projectId"],
        rule: 'A parent is never inferred. projectId is required, and the literal "inbox" is the honest choice when the right project is not known — it says the items need triage rather than asserting a relationship.',
      },
      {
        fields: ["apply"],
        rule: "Defaults to false. A call that omits it reports what would change and writes nothing.",
      },
    ],
    example: { projectId: "inbox", apply: false },
  },
  async handler(
    ctx: ServiceContext,
    input: RepairStuckProjectsInput,
  ): Promise<RepairStuckProjectsResult> {
    // Resolved before the scan so a dry run reports the real destination,
    // and so `"inbox"` names the same project the applied run would use.
    const projectId =
      input.projectId === INBOX_PROJECT_ID
        ? await resolveInboxProject(ctx, {
            area: input.area ?? "inbox",
            originType: "auto",
          })
        : input.projectId;

    // The whole definition of "stuck", as one predicate: parentless, no
    // child of any kind, and not already resolved. `NOT EXISTS` rather than
    // a join and a count, so a project with a thousand children costs the
    // same as one with a single child — the query stops at the first.
    //
    // The destination is excluded explicitly. It is itself a parentless
    // item, and if it happens to be childless and non-terminal it matches
    // this predicate — a scan that then tried to file it under itself would
    // be refused by the cycle check on the one row that has no alternative.
    const rows = await ctx.db.$queryRawUnsafe<StuckRow[]>(
      `SELECT i."id", i."title", i."area", i."state"::text AS "state"
       FROM "Item" i
       WHERE i."parentId" IS NULL
         AND i."id" <> $1
         AND NOT EXISTS (SELECT 1 FROM "Item" c WHERE c."parentId" = i."id")
         AND i."state"::text <> ALL($2::text[])
         AND ($3::text IS NULL OR i."area" = $3::text)
       ORDER BY i."createdAt" ASC, i."id" ASC`,
      projectId,
      TERMINAL_STATES,
      input.area ?? null,
    );

    const items: StuckItem[] = rows.map((row) => ({
      id: row.id,
      title: row.title,
      area: row.area,
      state: row.state,
    }));

    if (!input.apply) {
      return { applied: false, projectId, items, count: items.length };
    }

    // Resolved once, outside the loop: every item lands under the same
    // parent, so asking the same question per row would be the same answer
    // paid for `count` times.
    const parentDepth = await resolveParent(ctx, { parentId: projectId, field: "projectId" });
    const newDepth = parentDepth + 1;

    for (const row of items) {
      const item = await loadItem(ctx, row.id);
      const subtree = await subtreeOf(ctx, row.id);
      // Both checks run per row rather than once for the batch. They are
      // cheap, and skipping them because "the scan already proved these are
      // childless" would make this the one write path in the module that
      // trusts a prior query instead of the guard.
      assertNoCycle({ newParentId: projectId, subtree, field: "projectId" });
      assertDepthFits(ctx, { newDepth, subtree, field: "projectId" });
      await applyMove(ctx, { item, newParentId: projectId, newDepth, subtree });
    }

    return { applied: true, projectId, items, count: items.length };
  },
});
