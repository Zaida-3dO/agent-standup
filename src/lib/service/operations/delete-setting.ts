// `delete_setting` — SCHEMA.md §19 `DELETE /settings/{key}`: "Clear an
// override, returning the key to its registry default. Also audited." The
// operation that §17.2's revision-bump rule is written to protect: "the
// counter only goes up… a delete can lower a maximum" is why this bumps the
// same shared counter a set does, in the same transaction as the row
// deletion.
import { z } from "zod";
import { defineOperation } from "../operation";
import type { ServiceContext } from "../context";
import {
  appendSettingChangeEvent,
  bumpRevision,
  readOverrideRow,
  renderOne,
  requireSettingKey,
  type RenderedSetting,
} from "./settings-shared";

const inputSchema = z.object({ key: z.string().min(1) }).strict();

export type DeleteSettingInput = z.infer<typeof inputSchema>;

// Stryker disable all : this metadata is a module-level literal, read into
// the registry at import — before any test body runs and never re-evaluated
// — so a mutation here is unkillable by construction, NOT untested.
// `scripts/check-operation-metadata-mutants.mjs` requires this and carries
// the full reasoning, including why moving the assertions into a test body
// does not help.
export const deleteSetting = defineOperation({
  name: "delete_setting",
  kind: "write",
  summary: "Clears one setting's override, reverting it to the registry default.",
  // Stryker restore all
  input: inputSchema,
  async handler(ctx: ServiceContext, input: DeleteSettingInput): Promise<RenderedSetting> {
    requireSettingKey(input.key);

    const before = await readOverrideRow(ctx.db, input.key);

    // No row to clear is not an error — DELETE is idempotent: calling it
    // twice, or calling it on a key that was never overridden, both leave
    // the key at its default, which is the state the caller asked for.
    if (before) {
      await ctx.db.$executeRawUnsafe(`DELETE FROM "settings" WHERE "key" = $1`, input.key);
      await bumpRevision(ctx.db);
      await appendSettingChangeEvent(ctx.db, {
        key: input.key,
        before,
        after: null,
        batchId: crypto.randomUUID(),
        caller: ctx.caller,
      });
    }

    return renderOne(input.key, undefined);
  },
});
