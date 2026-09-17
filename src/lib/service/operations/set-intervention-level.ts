// `set_intervention_level` — stores one entry's level, as a decision that
// sticks.
//
// ── This writes a row, and that is the whole point ─────────────────────
//
// `src/lib/interventions/settings.ts`'s rule 2: *"An override is a decision
// and it sticks. A field that is stored is applied even when the shipped
// default has moved on. The cost is that an installation keeps its own
// answer when the product's improves, which is the correct trade: the
// alternative is a product update reversing a deliberate choice."*
//
// So this operation is the only thing in the system that converts an
// operator's choice into that permanence, and it must be reached only when
// somebody actually chose. Setting a level **to the value it already
// inherits** still writes a row here, and that is correct rather than a
// wasted write: an operator who selects `nudge` on an entry that ships
// `nudge` is saying "keep this at nudge", which is exactly the decision that
// must survive a release retuning that entry to `block-overridable`. The surface
// that must not write is the one offering *inherit*, and that is
// `clear_intervention_level`'s job.
import { z } from "zod";
import { defineOperation } from "../operation";
import type { ServiceContext } from "../context";
import { INTERVENTION_LEVELS, type InterventionLevel } from "@/lib/interventions/types";
import {
  assertLevelAllowed,
  interventionSettingKey,
  renderInterventionRows,
  requireEntry,
} from "./interventions-shared";
import { appendSettingChangeEvent, bumpRevision, readOverrideRow } from "./settings-shared";
import type { InterventionSettingRow } from "@/lib/interventions/configurable";

const inputSchema = z
  .object({
    id: z.string().min(1),
    // The same tuple the types and the read-back schemas are built from, so
    // a level added to the ladder is accepted here the moment it exists and
    // one removed from it starts being refused — rather than being stored as
    // a value no code branches on any more.
    level: z.enum(INTERVENTION_LEVELS),
  })
  .strict();

export type SetInterventionLevelInput = z.infer<typeof inputSchema>;

export interface SetInterventionLevelOutput {
  readonly intervention: InterventionSettingRow;
}

// Stryker disable all : this metadata is a module-level literal, read into
// the registry at import — before any test body runs and never re-evaluated
// — so a mutation here is unkillable by construction, NOT untested.
// `scripts/check-operation-metadata-mutants.mjs` requires this and carries
// the full reasoning, including why moving the assertions into a test body
// does not help.
export const setInterventionLevel = defineOperation({
  name: "set_intervention_level",
  kind: "write",
  summary: "Sets one intervention's level for this installation, overriding the shipped default.",
  // Stryker restore all
  input: inputSchema,
  contract: {
    rules: [
      {
        fields: ["id"],
        rule: "The id must name an intervention this build ships. A row stored for a retired entry is kept and reported by the read, but a new one cannot be created for an id absent from the catalogue.",
      },
      {
        fields: ["level"],
        rule: "A post-phase intervention cannot be set to a blocking level. It runs after the tool call has already happened, so it cannot refuse it.",
      },
    ],
    example: { id: "commit-signing-explicitly-suppressed", level: "block-overridable" },
  },
  async handler(
    ctx: ServiceContext,
    input: SetInterventionLevelInput,
  ): Promise<SetInterventionLevelOutput> {
    const entry = requireEntry(input.id);
    assertLevelAllowed(entry, input.level as InterventionLevel);

    const key = interventionSettingKey(entry.id, "level");
    const before = await readOverrideRow(ctx.db, key);

    const actorType = ctx.caller.actor ? "agent" : "system";
    const rows = await ctx.db.$queryRawUnsafe<{ key: string; value: unknown }[]>(
      `INSERT INTO "settings" ("key", "value", "updatedByType", "updatedById")
       VALUES ($1, $2::jsonb, $3::"ActorType", $4)
       ON CONFLICT ("key") DO UPDATE
         SET "value" = EXCLUDED."value",
             "updatedAt" = CURRENT_TIMESTAMP,
             "updatedByType" = EXCLUDED."updatedByType",
             "updatedById" = EXCLUDED."updatedById"
       RETURNING "key", "value"`,
      key,
      JSON.stringify(input.level),
      actorType,
      ctx.caller.actor ?? null,
    );

    // The revision is bumped and the change audited on the same shared
    // counter and the same event type the declared settings use. These rows
    // live in the same table and are read by the same cache, so a write that
    // moved a different counter would leave a held snapshot stale — and an
    // operator re-levelling an intervention is making exactly the kind of
    // change §17.2's audit trail exists to record.
    await bumpRevision(ctx.db);
    await appendSettingChangeEvent(ctx.db, {
      key,
      before,
      after: rows[0] ?? null,
      batchId: crypto.randomUUID(),
      caller: ctx.caller,
    });

    const rendered = await renderInterventionRows(ctx.db);
    const intervention = rendered.find((row) => row.id === entry.id);
    if (intervention === undefined) {
      // Unreachable: `requireEntry` already established the id is in the
      // catalogue, and the renderer maps over that same catalogue. Guarded
      // rather than asserted, matching `bumpRevision`'s posture on the same
      // class of "the query that always returns a row didn't".
      throw new Error(`${entry.id} vanished from the catalogue mid-write.`);
    }
    return { intervention };
  },
});
