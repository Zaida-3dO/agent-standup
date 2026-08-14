// `get_settings` — SCHEMA.md §19 `GET /settings`: "Every declared setting
// with its value, source (default or override), schema, label, help,
// category and validation state. The registry, rendered. Carries the
// revision as an entity tag."
import { z } from "zod";
import { defineOperation } from "../operation";
import type { ServiceContext } from "../context";
import {
  readAllOverrideRows,
  renderAllSettings,
  renderUnrecognisedSettings,
  type RenderedSetting,
  type UnrecognisedSetting,
} from "./settings-shared";
import {
  renderBootstrapVariables,
  renderBuildConstants,
  type RenderedBootstrapVariable,
  type RenderedConstant,
} from "@/lib/settings/build-constants";

const inputSchema = z.object({}).strict();

export type GetSettingsInput = z.infer<typeof inputSchema>;

export interface GetSettingsOutput {
  readonly settings: readonly RenderedSetting[];
  /**
   * Stored rows for keys this build does not declare — SCHEMA.md §17.3.
   * Present and empty rather than omitted when there are none, so a client
   * never has to distinguish "no unrecognised rows" from "this build's
   * answer predates the field".
   */
  readonly unrecognised: readonly UnrecognisedSetting[];
  /** SCHEMA.md §17.6 — "exposed read-only on `/settings`". */
  readonly constants: readonly RenderedConstant[];
  /**
   * SCHEMA.md §17.1, as whether-set only. No bootstrap *value* is carried:
   * §17.2 — the bootstrap tier "exists precisely because some values must
   * not be readable from the application."
   */
  readonly bootstrap: readonly RenderedBootstrapVariable[];
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
      unrecognised: renderUnrecognisedSettings(rows),
      constants: renderBuildConstants(),
      bootstrap: renderBootstrapVariables(),
      revision: (revisionRows[0]?.revision ?? 0n).toString(),
    };
  },
});
