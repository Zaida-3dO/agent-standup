// `get_settings` — SCHEMA.md §19 `GET /settings`: "Every declared setting
// with its value, source (default or override), schema, label, help,
// category and validation state. The registry, rendered. Carries the
// revision as an entity tag."
import { z } from "zod";
import { defineOperation } from "../operation";
import type { ServiceContext } from "../context";
import { readAllOverrideRows, renderAllSettings, type RenderedSetting } from "./settings-shared";

const inputSchema = z.object({}).strict();

export type GetSettingsInput = z.infer<typeof inputSchema>;

export interface GetSettingsOutput {
  readonly settings: readonly RenderedSetting[];
  /** The entity tag — SCHEMA.md §17.2. A string: a revision is a bigint and JSON has no bigint. */
  readonly revision: string;
}

export const getSettings = defineOperation({
  name: "get_settings",
  kind: "read",
  summary: "Reads every declared setting, its resolved value, and where that value came from.",
  input: inputSchema,
  async handler(ctx: ServiceContext): Promise<GetSettingsOutput> {
    const rows = await readAllOverrideRows(ctx.db);
    const revisionRows = await ctx.db.$queryRawUnsafe<{ revision: bigint }[]>(
      `SELECT "revision" FROM "settings_revision" WHERE "id" = 1`,
    );
    return {
      settings: renderAllSettings(rows),
      revision: (revisionRows[0]?.revision ?? 0n).toString(),
    };
  },
});
