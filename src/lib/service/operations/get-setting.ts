// `get_setting` — SCHEMA.md §19 `GET /settings/{key}`: "One setting, same shape."
import { z } from "zod";
import { defineOperation } from "../operation";
import type { ServiceContext } from "../context";
import { readOverrideRow, renderOne, requireSettingKey } from "./settings-shared";
import type { RenderedSetting } from "./settings-shared";

const inputSchema = z.object({ key: z.string().min(1) }).strict();

export type GetSettingInput = z.infer<typeof inputSchema>;

// Stryker disable all : this metadata is a module-level literal, read into
// the registry at import — before any test body runs and never re-evaluated
// — so a mutation here is unkillable by construction, NOT untested.
// `scripts/check-operation-metadata-mutants.mjs` requires this and carries
// the full reasoning, including why moving the assertions into a test body
// does not help.
export const getSetting = defineOperation({
  name: "get_setting",
  kind: "read",
  summary: "Reads one declared setting by key.",
  // Stryker restore all
  input: inputSchema,
  async handler(ctx: ServiceContext, input: GetSettingInput): Promise<RenderedSetting> {
    requireSettingKey(input.key);
    const row = await readOverrideRow(ctx.db, input.key);
    return renderOne(input.key, row?.value);
  },
});
