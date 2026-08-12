// `patch_settings` — SCHEMA.md §19 `PATCH /settings`: "Set and clear several
// keys at once, in one transaction, with one revision bump and one audit
// row per key sharing a batch identifier… Cross-setting validators see the
// proposed set, not the stored set."
//
// All-or-nothing is a property of *where* validation happens, not of a
// rollback the operation triggers itself: every key is validated against
// the registry before any write is issued, so an invalid key never reaches
// SQL — nothing is written, and the caller sees exactly one refusal naming
// the offending key. (The service runtime's own transaction boundary is the
// second line of defence, for a failure this operation cannot foresee, e.g.
// the database going away mid-batch — but the up-front validation pass is
// what makes the common case, "one of six keys was wrong", a clean no-op
// with a clear message rather than a rollback discovered from a stack
// trace.)
import { z } from "zod";
import { InvalidInputError } from "../errors";
import { defineOperation } from "../operation";
import type { ServiceContext } from "../context";
import { validateSetting } from "@/lib/settings";
import {
  appendSettingChangeEvent,
  bumpRevision,
  readOverrideRow,
  renderOne,
  requireSettingKey,
  type RenderedSetting,
} from "./settings-shared";

/**
 * One entry in the patch map — the same `{set, value?}` discriminator the
 * `setting_change` audit payload uses (SCHEMA.md §3), so "set to null" and
 * "clear the override" are never conflated anywhere between the wire and
 * the ledger.
 */
const patchEntrySchema = z.discriminatedUnion("set", [
  z.object({ set: z.literal(true), value: z.unknown() }).strict(),
  z.object({ set: z.literal(false) }).strict(),
]);

const inputSchema = z
  .object({
    settings: z.record(z.string(), patchEntrySchema).refine((map) => Object.keys(map).length > 0, {
      message: "settings must contain at least one key",
    }),
  })
  .strict();

export type PatchSettingsInput = z.infer<typeof inputSchema>;

export interface PatchSettingsOutput {
  readonly settings: readonly RenderedSetting[];
}

export const patchSettings = defineOperation({
  name: "patch_settings",
  kind: "write",
  summary: "Sets or clears several settings in one transaction — all keys apply, or none do.",
  input: inputSchema,
  async handler(ctx: ServiceContext, input: PatchSettingsInput): Promise<PatchSettingsOutput> {
    const entries = Object.entries(input.settings);

    // Pass 1 — validate every key and every value before writing anything.
    // A key this build does not declare, or a value that fails its schema,
    // aborts the whole batch here: no SQL has run yet, so "all keys apply,
    // or none do" holds without depending on a rollback to undo a partial
    // write.
    const toWrite: { key: string; value: unknown }[] = [];
    for (const [key, entry] of entries) {
      requireSettingKey(key);
      if (entry.set) {
        const validated = validateSetting(key, entry.value);
        if (!validated.ok) {
          throw new InvalidInputError(`Invalid value for ${key}: ${validated.errors.join("; ")}`, {
            fields: [`settings.${key}.value`],
          });
        }
        toWrite.push({ key, value: validated.value });
      }
    }

    const batchId = crypto.randomUUID();
    const actorType = ctx.caller.actor ? "agent" : "system";
    const rendered: RenderedSetting[] = [];

    for (const [key, entry] of entries) {
      const before = await readOverrideRow(ctx.db, key);

      if (entry.set) {
        const { value } = toWrite.find((w) => w.key === key)!;
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
          JSON.stringify(value),
          actorType,
          ctx.caller.actor ?? null,
        );
        const after = rows[0]!;
        await appendSettingChangeEvent(ctx.db, { key, before, after, batchId, caller: ctx.caller });
        rendered.push(renderOne(key as never, after.value));
      } else {
        if (before) {
          await ctx.db.$executeRawUnsafe(`DELETE FROM "settings" WHERE "key" = $1`, key);
          await appendSettingChangeEvent(ctx.db, {
            key,
            before,
            after: null,
            batchId,
            caller: ctx.caller,
          });
        }
        rendered.push(renderOne(key as never, undefined));
      }
    }

    // One bump for the whole call (§19), not one per key — a batch of six
    // sets is one act, and the revision counter records it as one.
    await bumpRevision(ctx.db);

    return { settings: rendered };
  },
});
