// `report_blocked_on_tool` — the channel a dispatched agent stalls through
// when its brief names a tool it cannot actually use.
//
// ── What this is for ────────────────────────────────────────────────────
//
// `docs/plans/INTERVENTIONS.md` I19 asks for a subagent that discovers it
// lacks a tool to *"immediately stall and return telling the orchestrator
// they can't continue"*. That entry's detection half is unbuildable here and
// remains unbuilt, for the reason recorded against it in `builtins.ts`: this
// server never observes a spawn, so nothing on this schema can compare the
// tool list an agent was given against the one its job needed. What that
// analysis also says is that the stall-and-report half **is** reachable, and
// belongs to whatever performs the dispatch.
//
// This operation is the missing half's other end. It does not detect
// anything and makes no judgement about whether the agent was right. It is
// the *place the stall goes*, so that "I was told to do X and X is not
// available to me" lands on the board at the moment it is discovered rather
// than in a final report the orchestrator may never read.
//
// ── Why an escalation and not a note ────────────────────────────────────
//
// `escalation` is already in `CREW_EVENT_TYPES` (`@/lib/crew/wait-core`), so
// an orchestrator sitting in a wait on its crew is **woken by this row**.
// A `note` is in that set too, but a note is the ordinary channel for
// everything an agent has to say, and an orchestrator that has to distinguish
// "here is my progress" from "I am stopped and need you" by reading prose is
// back to the situation this exists to remove. The type is the signal; the
// prose is the detail.
//
// No new `EventType` member was added for it. `escalation` already means
// *this needs someone above me*, it already renders in the item history
// (`@/lib/item-detail/history`) and in the since-your-last-visit view
// (`@/lib/since/view`), and a new member would have bought a migration and a
// fresh row in each of those in exchange for a distinction nobody reading the
// board would act on differently.
//
// ── The one judgement this operation does encode ────────────────────────
//
// `reason` separates **not_granted** from **refused**, and that distinction
// is the whole reason this is a typed field rather than free prose. The two
// documented incidents this comes from are one of each, and they have
// different fixes:
//
//   - *not_granted* — the tool is absent from the agent's definition. The
//     fix is an edit to that definition, and it does not take effect until a
//     **new session**, so the orchestrator cannot test it from the session
//     that made it.
//   - *refused* — the tool was granted and the call was still refused,
//     because the operation has a precondition the caller does not meet.
//     `checkpoint` requiring a live assignment is the known case. The fix is
//     usually a different call, or the orchestrator handing over the claim —
//     never an edit to the tool list, which already contains the tool.
//
// A report keyed only on the allowlist would miss the second kind entirely,
// which is exactly how a briefing instruction that could not be followed
// survived four crews.
//
// **`unknown` is a first-class answer and not a failure to fill the field in.**
// An agent that has been refused and cannot tell which of the two it hit
// should say so rather than guess, because a confident wrong classification
// sends the orchestrator to the wrong fix. It is the schema's default for
// exactly that reason.
import { z } from "zod";
import { NotFoundError } from "../errors";
import { defineOperation } from "../operation";
import type { ServiceContext } from "../context";
import { appendEvent, type AppendedEvent } from "@/lib/events";
import { resolveItemId } from "../items/resolve-id";

/**
 * Why the tool could not be used.
 *
 * Deliberately three values and not two. See the header — the third is the
 * honest answer for a caller that was refused and cannot tell why, and
 * removing it would push those callers into guessing one of the other two.
 */
export const BLOCKED_ON_TOOL_REASONS = ["not_granted", "refused", "unknown"] as const;
export type BlockedOnToolReason = (typeof BLOCKED_ON_TOOL_REASONS)[number];

const inputSchema = z
  .object({
    itemId: z.string().min(1),
    /**
     * The tool the brief named. One tool per report: an agent blocked on
     * three tools makes three calls, because the orchestrator's fix for each
     * may differ and a single row naming all of them cannot be resolved
     * piecemeal.
     */
    tool: z.string().trim().min(1, "name the tool you could not use"),
    reason: z.enum(BLOCKED_ON_TOOL_REASONS).default("unknown"),
    /**
     * What the agent was trying to do — the brief's instruction, in the
     * agent's own words.
     *
     * Required, and it is the field that makes the row actionable. A report
     * saying only *"checkpoint is unavailable"* leaves the orchestrator to
     * work out whether that matters; one saying *"the brief said to
     * checkpoint against this id as I go"* names the instruction to correct.
     */
    needed: z.string().trim().min(1, "say what the brief asked you to do with it"),
    /** The refusal text, verbatim, when there was one. */
    refusal: z.string().trim().min(1).nullable().optional(),
    sessionId: z.string().min(1).nullable().optional(),
  })
  .strict();

export type ReportBlockedOnToolInput = z.infer<typeof inputSchema>;

/** The one-line summary the orchestrator reads on the board. */
function headlineFor(input: ReportBlockedOnToolInput): string {
  const why =
    input.reason === "not_granted"
      ? "not granted to this agent"
      : input.reason === "refused"
        ? "granted but refused"
        : "unavailable";
  return `Stalled: \`${input.tool}\` is ${why}`;
}

/**
 * The rules the schema cannot state.
 *
 * Hoisted out of the `defineOperation` literal rather than written inline,
 * so the `Stryker disable` range below stays tight around the metadata it
 * is for. `check-operation-metadata-mutants.mjs` requires the restore within
 * a bounded window of the declaration, and its own header says why that
 * bound is worth respecting rather than widening: an unclosed range runs on
 * through the schema and the handler, silencing mutants that are genuinely
 * killable. Keeping this out here costs nothing and keeps the handler
 * mutable.
 */
const contract = {
  rules: [
    {
      fields: ["reason"],
      rule:
        "`not_granted` means the tool is absent from this agent's definition and the fix is an " +
        "edit to it, which only takes effect in a new session. `refused` means the tool was " +
        "granted and the call was still refused because a precondition is unmet — the known " +
        "case is an operation that requires a live assignment, which a dispatched agent " +
        "usually does not hold. Where the two cannot be told apart, this field's own default " +
        "records that honestly rather than guessing: they have different fixes.",
    },
    {
      fields: ["needed"],
      rule:
        "State what the brief asked you to do, not merely that the tool is missing. The " +
        "orchestrator is correcting an instruction, and cannot do that from the tool name alone.",
    },
  ],
  example: {
    itemId: "0f8b1c2d-3e4f-5a6b-7c8d-9e0f1a2b3c4d",
    tool: "checkpoint",
    reason: "refused",
    needed: "The brief said to checkpoint against this id as I go.",
    refusal: "This session holds no live assignment on the item.",
    sessionId: "crew-session-1",
  },
} as const;

// Stryker disable all : this metadata is a module-level literal, read into
// the registry at import — before any test body runs and never re-evaluated
// — so a mutation here is unkillable by construction, NOT untested.
// `scripts/check-operation-metadata-mutants.mjs` requires this and carries
// the full reasoning.
export const reportBlockedOnTool = defineOperation({
  name: "report_blocked_on_tool",
  kind: "write",
  summary: "Stops and tells the orchestrator that a tool the brief named cannot be used, and why.",
  contract,
  // Stryker restore all
  input: inputSchema,
  async handler(ctx: ServiceContext, input: ReportBlockedOnToolInput): Promise<AppendedEvent> {
    // A short id becomes the one item it identifies. Rebinding `input` is
    // what stops a short id surviving into a stored value — same reasoning
    // as `note`.
    input = {
      ...input,
      itemId: await resolveItemId(ctx.db, input.itemId, "itemId"),
    };

    const itemRows = await ctx.db.$queryRawUnsafe<{ id: string }[]>(
      `SELECT "id" FROM "Item" WHERE "id" = $1`,
      input.itemId,
    );
    if (itemRows.length === 0) {
      throw new NotFoundError(`No such item: ${input.itemId}.`, { fields: ["itemId"] });
    }

    // **This call must succeed for a caller holding nothing.** A dispatched
    // subagent normally holds no claim — the orchestrator holds it — and
    // that is the exact population this operation exists to serve. Requiring
    // an assignment here would reproduce, in the reporting channel itself,
    // the failure it was built to report. So the assignment is looked up
    // only to attribute the row, never to gate it.
    let assignmentId: string | null = null;
    let actorId: string | null = null;

    if (input.sessionId) {
      const liveRows = await ctx.db.$queryRawUnsafe<{ id: string; holderId: string }[]>(
        `SELECT "id", "holderId" FROM "Assignment"
         WHERE "itemId" = $1 AND "sessionId" = $2 AND "releasedAt" IS NULL
         LIMIT 1`,
        input.itemId,
        input.sessionId,
      );
      const live = liveRows[0];
      if (live) {
        assignmentId = live.id;
        actorId = live.holderId;
      }
    }

    return appendEvent(ctx.db, {
      itemId: input.itemId,
      actor: {
        // Always `agent`: a person who cannot use a tool does not stall and
        // report to an orchestrator, they go and fix it. The one caller this
        // operation has is a dispatched agent.
        actorType: "agent",
        actorId,
        sessionId: input.sessionId ?? null,
      },
      assignmentId,
      type: "escalation",
      payload: {
        // `to_person: null` matches what the liveness sweep writes on its own
        // escalations — this is addressed to the orchestrator, not to a human.
        to_person: null,
        blocked_on_tool: input.tool,
        reason: input.reason,
        ...(input.refusal == null ? {} : { refusal: input.refusal }),
      },
      body: input.needed,
      headline: headlineFor(input),
    });
  },
});
