// `list_intervention_settings` — every catalogue entry with the level it
// actually runs at, and whether that level is inherited or chosen.
//
// The read half of the configuration surface MILESTONES.md #128 asks for.
// It is deliberately **not** part of `get_settings`: that operation answers
// "the registry, rendered", and its whole output is shaped by
// `SETTINGS_REGISTRY` — a closed compile-time record the catalogue is
// explicitly not in. Folding these in would mean either fabricating registry
// definitions for keys nothing declares, or a second, differently-shaped
// collection inside an answer documented as being one thing.
import { z } from "zod";
import { defineOperation } from "../operation";
import type { ServiceContext } from "../context";
import { renderInterventionRows } from "./interventions-shared";
import type { InterventionSettingRow } from "@/lib/interventions/configurable";

const inputSchema = z.object({}).strict();

export type ListInterventionSettingsInput = z.infer<typeof inputSchema>;

export interface ListInterventionSettingsOutput {
  /**
   * Every entry this build ships, in the registry's own order.
   *
   * Ordered rather than sorted by id, so the list a person reads matches the
   * order `evaluate` runs them in, and two renders of one configuration are
   * byte-identical — the property that makes a diff of this output mean
   * something.
   */
  readonly interventions: readonly InterventionSettingRow[];
}

// Stryker disable all : this metadata is a module-level literal, read into
// the registry at import — before any test body runs and never re-evaluated
// — so a mutation here is unkillable by construction, NOT untested.
// `scripts/check-operation-metadata-mutants.mjs` requires this and carries
// the full reasoning, including why moving the assertions into a test body
// does not help.
export const listInterventionSettings = defineOperation({
  name: "list_intervention_settings",
  kind: "read",
  summary: "Reads every intervention this build ships, with the level it runs at and its source.",
  // Stryker restore all
  input: inputSchema,
  async handler(ctx: ServiceContext): Promise<ListInterventionSettingsOutput> {
    return { interventions: await renderInterventionRows(ctx.db) };
  },
});
