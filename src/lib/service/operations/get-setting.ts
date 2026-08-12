// `get_setting` — SCHEMA.md §19 `GET /settings/{key}`: "One setting, same shape."
import { z } from "zod";
import { defineOperation } from "../operation";
import type { ServiceContext } from "../context";
import { readOverrideRow, renderOne, requireSettingKey } from "./settings-shared";
import type { RenderedSetting } from "./settings-shared";

const inputSchema = z.object({ key: z.string().min(1) }).strict();

export type GetSettingInput = z.infer<typeof inputSchema>;

export const getSetting = defineOperation({
  name: "get_setting",
  kind: "read",
  summary: "Reads one declared setting by key.",
  input: inputSchema,
  async handler(ctx: ServiceContext, input: GetSettingInput): Promise<RenderedSetting> {
    requireSettingKey(input.key);
    const row = await readOverrideRow(ctx.db, input.key);
    return renderOne(input.key, row?.value);
  },
});
