// `record_intervention` — persisting a firing so it can be rated later.
//
// The write behind `src/lib/interventions/capture.ts`. One call carries
// every finding from one decision, because they share a call and a session
// and a round trip per finding on the highest-volume path in the system
// would be a cost the loop cannot justify.
//
// ── Why this is a separate operation from `hook_decision` ──────────────
//
// `hook_decision` is declared `kind: "read"`, and that declaration is load
// bearing rather than descriptive: the runtime opens a transaction per call
// and the kind is what a reader relies on when reasoning about which paths
// write. Making the busiest read in the system into a write, so that it
// could record its own findings, would change that contract for every
// caller — including the overwhelming majority of calls, which trigger
// nothing and would then be opening a write transaction to record nothing.
//
// Keeping it separate also keeps the recording **optional**. A hook that
// cannot reach this operation still gets its decision; it loses the
// evidence loop, not the guard. That is the correct direction of failure —
// the same fail-open posture the hook path already takes, applied to
// something even less critical than the decision itself.
//
// ── Returned ids are the survey's only handle ──────────────────────────
//
// Each row's id comes back, because the session-end survey attributes an
// answer to a firing by id. A recording call that returned nothing would
// leave the survey unable to say *which* firing a 1 was about, and the
// entry-level aggregate is built from exactly those attributions.

import { z } from "zod";
import { defineOperation } from "../operation";
import type { ServiceContext } from "../context";
import { INTERVENTION_OUTCOMES } from "../../interventions/capture";
import { MAX_CAPTURED_COMMAND } from "../../interventions/capture";

const captureSchema = z
  .object({
    entryId: z.string().trim().min(1),
    outcome: z.enum(INTERVENTION_OUTCOMES),
    level: z.string().trim().min(1),
    phase: z.string().trim().min(1),
    itemId: z.string().trim().min(1).optional(),
    tool: z.string().trim().min(1).optional(),
    // Bounded here as well as by the builder. The builder is the ordinary
    // route and truncates; this bound is what stops a caller that assembled
    // its own payload writing a multi-kilobyte heredoc into a table sized
    // for recognisable fragments.
    command: z
      .string()
      .max(MAX_CAPTURED_COMMAND + 32)
      .optional(),
    message: z.string().max(2000).optional(),
    overrideReason: z.string().trim().min(1).max(1000).optional(),
  })
  .strict();

const inputSchema = z
  .object({
    sessionId: z.string().trim().min(1),
    rootSessionId: z.string().trim().min(1).optional(),
    // Bounded: one decision produces at most one finding per catalogue
    // entry, so a payload far larger than the catalogue is a malformed
    // caller rather than a busy one.
    captures: z.array(captureSchema).min(1).max(50),
  })
  .strict();

export type RecordInterventionInput = z.infer<typeof inputSchema>;

export interface RecordInterventionOutput {
  /** The written rows, in the order they were supplied. */
  readonly recorded: readonly { readonly id: string; readonly entryId: string }[];
}

interface InsertedRow {
  id: bigint;
  entry_id: string;
}

// Stryker disable all : module-level metadata read into the registry at
// import, before any test body runs. See
// `scripts/check-operation-metadata-mutants.mjs`.
export const recordIntervention = defineOperation({
  name: "record_intervention",
  kind: "write",
  summary: "Records intervention firings from one decision, so they can be surveyed and scored.",
  // Stryker restore all
  input: inputSchema,
  async handler(
    ctx: ServiceContext,
    input: RecordInterventionInput,
  ): Promise<RecordInterventionOutput> {
    const recorded: { id: string; entryId: string }[] = [];

    // Sequential rather than one multi-row insert. The rows are few — one
    // per triggered entry, and more than a couple triggering on one call is
    // already unusual — and a per-row insert keeps the returned ids
    // unambiguously in the caller's order, which is what the survey
    // attributes answers by.
    for (const capture of input.captures) {
      const rows = await ctx.db.$queryRawUnsafe<InsertedRow[]>(
        `INSERT INTO "intervention_events"
           ("entry_id", "session_id", "root_session_id", "item_id",
            "outcome", "level", "phase", "tool", "command", "message", "override_reason")
         VALUES ($1, $2, $3, $4, $5::"InterventionOutcome", $6, $7, $8, $9, $10, $11)
         RETURNING "id", "entry_id"`,
        capture.entryId,
        input.sessionId,
        input.rootSessionId ?? null,
        capture.itemId ?? null,
        capture.outcome,
        capture.level,
        capture.phase,
        capture.tool ?? null,
        capture.command ?? null,
        capture.message ?? null,
        capture.overrideReason ?? null,
      );
      const row = rows[0]!;
      recorded.push({ id: String(row.id), entryId: row.entry_id });
    }

    return { recorded };
  },
});
