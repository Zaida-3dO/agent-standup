// `clear_intervention_level` — returns one entry to tracking the product.
//
// ── A deletion, and it must never become a write ───────────────────────
//
// This is the operation `src/lib/interventions/settings.ts`'s rule 1 is
// about: *"An entry that has never been overridden tracks the product. An
// absent field is absent, never materialised into the current default. If a
// later release retunes a level or a message, an installation that never
// expressed an opinion picks it up on update with nothing to migrate. The
// moment this module wrote a resolved default into a row, that would stop
// being true silently — the row would look identical to a deliberate
// choice."*
//
// The tempting implementation — read the entry's `defaultLevel` and store
// it — passes every test anyone would think to write. The configuration
// reads back correctly, the entry fires at the right level, and the page
// shows the right value. It is wrong in exactly one way, and the way is
// invisible until a release changes the shipped level months later: the
// installation keeps the superseded value for ever, in a stored row
// indistinguishable from one somebody chose on purpose.
//
// So the row is **deleted**, and `renderInterventionSettings` reports
// `source: "default"` again — which is the state the caller asked for, and
// the state that will pick up the next release's answer.
//
// ── Idempotent, like `delete_setting` ──────────────────────────────────
//
// No row to clear is not an error: calling this twice, or calling it on an
// entry nobody ever overrode, both leave the entry inheriting, which is what
// was asked for. Only a real deletion bumps the revision and writes an audit
// event, so a no-op call does not invalidate every held settings snapshot in
// the system for nothing.
import { z } from "zod";
import { defineOperation } from "../operation";
import type { ServiceContext } from "../context";
import {
  interventionSettingKey,
  renderInterventionRows,
  requireEntry,
} from "./interventions-shared";
import { appendSettingChangeEvent, bumpRevision, readOverrideRow } from "./settings-shared";
import type { InterventionSettingRow } from "@/lib/interventions/configurable";

const inputSchema = z.object({ id: z.string().min(1) }).strict();

export type ClearInterventionLevelInput = z.infer<typeof inputSchema>;

export interface ClearInterventionLevelOutput {
  readonly intervention: InterventionSettingRow;
  /**
   * Whether a stored row was actually removed.
   *
   * Carried because the caller cannot infer it from the rendered entry: an
   * entry that was already inheriting and one that has just stopped
   * overriding render identically, by construction. A surface that reports
   * "reverted to the default" either way is claiming an act that may not
   * have happened.
   */
  readonly cleared: boolean;
}

// Stryker disable all : this metadata is a module-level literal, read into
// the registry at import — before any test body runs and never re-evaluated
// — so a mutation here is unkillable by construction, NOT untested.
// `scripts/check-operation-metadata-mutants.mjs` requires this and carries
// the full reasoning, including why moving the assertions into a test body
// does not help.
export const clearInterventionLevel = defineOperation({
  name: "clear_intervention_level",
  kind: "write",
  summary: "Clears one intervention's stored level so it tracks the level this build ships again.",
  // Stryker restore all
  input: inputSchema,
  async handler(
    ctx: ServiceContext,
    input: ClearInterventionLevelInput,
  ): Promise<ClearInterventionLevelOutput> {
    const entry = requireEntry(input.id);
    const key = interventionSettingKey(entry.id, "level");
    const before = await readOverrideRow(ctx.db, key);

    if (before) {
      await ctx.db.$executeRawUnsafe(`DELETE FROM "settings" WHERE "key" = $1`, key);
      await bumpRevision(ctx.db);
      await appendSettingChangeEvent(ctx.db, {
        key,
        before,
        after: null,
        batchId: crypto.randomUUID(),
        caller: ctx.caller,
      });
    }

    const rendered = await renderInterventionRows(ctx.db);
    const intervention = rendered.find((row) => row.id === entry.id);
    if (intervention === undefined) {
      // Unreachable for the reason its sibling in `set_intervention_level`
      // records: the id came from the catalogue the renderer maps over.
      throw new Error(`${entry.id} vanished from the catalogue mid-write.`);
    }
    return { intervention, cleared: before !== null };
  },
});
