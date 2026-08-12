// `put_setting` — SCHEMA.md §19 `PUT /settings/{key}`: "Set one override —
// the single-key case of the same path [as PATCH]." Write-time validation
// against row #77's registry validator; the revision bump and the audit
// event both happen in the same transaction as the write (§17.2).
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

const inputSchema = z
  .object({
    key: z.string().min(1),
    // JSON `null` is a legal setting value (§17.2 — "explicitly nothing")
    // and must arrive as an explicit `null`, not be indistinguishable from
    // an omitted field. `z.unknown()` alone accepts a *missing* `value` key
    // just as happily as a present `null` — both parse to the property
    // being `undefined` — so the `.refine` below is what actually rejects
    // "no value key at all": it inspects the raw candidate object, before
    // Zod has erased the distinction between "absent" and "present as
    // undefined".
    value: z.unknown(),
  })
  .strict()
  .refine((candidate) => "value" in (candidate as object), {
    message: "value is required (use null for an explicit no-value)",
    path: ["value"],
  });

export type PutSettingInput = z.infer<typeof inputSchema>;

export const putSetting = defineOperation({
  name: "put_setting",
  kind: "write",
  summary: "Sets one setting's override to a value, validated against its declared schema.",
  input: inputSchema,
  async handler(ctx: ServiceContext, input: PutSettingInput): Promise<RenderedSetting> {
    requireSettingKey(input.key);

    const validated = validateSetting(input.key, input.value);
    if (!validated.ok) {
      throw new InvalidInputError(
        `Invalid value for ${input.key}: ${validated.errors.join("; ")}`,
        { fields: ["value"] },
      );
    }

    const before = await readOverrideRow(ctx.db, input.key);

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
      input.key,
      JSON.stringify(validated.value),
      actorType,
      ctx.caller.actor ?? null,
    );
    const after = rows[0];
    if (!after) {
      throw new InvalidInputError(`Setting write for ${input.key} produced no row.`, {
        fields: ["key"],
      });
    }

    await bumpRevision(ctx.db);
    await appendSettingChangeEvent(ctx.db, {
      key: input.key,
      before,
      after,
      batchId: crypto.randomUUID(),
      caller: ctx.caller,
    });

    return renderOne(input.key, after.value);
  },
});
