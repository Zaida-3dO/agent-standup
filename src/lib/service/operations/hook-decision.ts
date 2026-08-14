// `hook_decision` — MILESTONES.md #41, SCHEMA.md §19 `POST /hook`: "The dumb
// pipe. Sends event type, session, tool, command. Returns allow/deny for
// guarded patterns, or nudge text, or nothing."
//
// This operation is the service-layer half of that contract: allow-list
// silent, ask-list answered, denies when unsure (MILESTONES.md #41's own
// row text). It is one of two callers of `decideHook`
// (`src/lib/service/hook-decision.ts`) — the HTTP route (`../hook/route.ts`)
// is the other, and `standup hook` (MILESTONES.md #88) will be a third, over
// the same operation rather than a second implementation of the match.
//
// What this row does NOT do, on purpose, because later rows own it:
// - It never returns nudge text or a merge-gate/kill-guard verdict — #44-#47
//   add judgement on top of the `ask` outcome; this operation only decides
//   which of the three buckets a command falls into.
// - It touches no table and appends no event: a decision made on every tool
//   call is the highest-volume path in the system (DECISIONS.md §4's whole
//   point is keeping it a "dumb pipe"), so it reads settings only, the same
//   posture `service_info` already uses for a DB-free read.
// - **Any event with no command is allowed by construction** — nothing to
//   match against, and "unsure" does not apply to an event with no command
//   to be unsure about. This is deliberately broader than "a `Stop` event
//   is allowed", and the width is the point rather than an oversight:
//   `PostToolUse` fires for non-Bash tools too, and those carry no command
//   either, so keying the carve-out on `eventType === "Stop"` would leave
//   every command-less `PostToolUse` falling through to the "matches
//   neither list" path and reading as a false `deny`. What is being allowed
//   is precisely "there is nothing here to classify", which is a statement
//   about the payload and not about which event produced it.
//
//   It is still a widening of an allow path in a gate whose default is to
//   deny when unsure, so it is pinned by test rather than left to this
//   comment: see `tests/hook-decision-operation.test.ts`. The boundary can
//   move, but not silently.
import { z } from "zod";
import { defineOperation } from "../operation";
import type { ServiceContext } from "../context";
import { decideHook, HOOK_DECISIONS, type HookDecision } from "../hook-decision";

const EVENT_TYPES = ["PreToolUse", "PostToolUse", "Stop"] as const;

const inputSchema = z
  .object({
    eventType: z.enum(EVENT_TYPES),
    sessionId: z.string().min(1),
    /** The tool the hook observed, e.g. `Bash`. Absent for a `Stop` event. */
    tool: z.string().min(1).optional(),
    /** The command text to classify. Absent for a `Stop` event. */
    command: z.string().optional(),
  })
  .strict();

export type HookDecisionOperationInput = z.infer<typeof inputSchema>;

export interface HookDecisionOperationOutput {
  readonly decision: HookDecision;
  readonly matchedList: "allow" | "ask" | null;
  readonly matchedPattern: string | null;
}

export const hookDecision = defineOperation({
  name: "hook_decision",
  kind: "read",
  summary: "Classifies one hook event as allow, ask or deny against the configured pattern lists.",
  input: inputSchema,
  async handler(
    ctx: ServiceContext,
    input: HookDecisionOperationInput,
  ): Promise<HookDecisionOperationOutput> {
    // A `Stop` event, or any event with nothing to match, has no command to
    // be unsure about — allowed by construction rather than falling through
    // the "matches neither list" path and reading as a false `deny`.
    if (input.command === undefined || input.command.length === 0) {
      return { decision: "allow", matchedList: null, matchedPattern: null };
    }

    return decideHook({
      command: input.command,
      allowPatterns: ctx.settings.values["hook.allow_patterns"],
      askPatterns: ctx.settings.values["hook.ask_patterns"],
    });
  },
});

export { HOOK_DECISIONS };
