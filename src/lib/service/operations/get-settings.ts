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
import {
  readCapabilityChecks,
  renderCapabilities,
  type RenderedCapability,
} from "@/lib/settings/capability-status";

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
  /**
   * SCHEMA.md §17.5 — "show it as unverified on `/settings`".
   *
   * The capability documents, each with the last finding the liveness sweep
   * recorded about it. Carried separately from `settings` rather than as a
   * field on the rendered setting, because it is a different kind of fact:
   * a setting's `value` and `source` are known from the registry and the
   * stored row, while this is an observation made by a particular process at
   * a particular time, and may be about a path that differs from the one the
   * setting holds.
   *
   * Present for both capabilities always, including when they are `off`, so
   * "notifications are deliberately disabled" is a readable answer rather
   * than an absence a client has to interpret.
   */
  readonly capabilities: readonly RenderedCapability[];
  /** The entity tag — SCHEMA.md §17.2. A string: a revision is a bigint and JSON has no bigint. */
  readonly revision: string;
}

// Stryker disable all : this metadata is a module-level literal, read into
// the registry at import — before any test body runs and never re-evaluated
// — so a mutation here is unkillable by construction, NOT untested.
// `scripts/check-operation-metadata-mutants.mjs` requires this and carries
// the full reasoning, including why moving the assertions into a test body
// does not help.
export const getSettings = defineOperation({
  name: "get_settings",
  kind: "read",
  summary: "Reads every declared setting, its resolved value, and where that value came from.",
  // Stryker restore all
  input: inputSchema,
  async handler(ctx: ServiceContext): Promise<GetSettingsOutput> {
    const rows = await readAllOverrideRows(ctx.db);
    const revisionRows = await ctx.db.$queryRawUnsafe<{ revision: bigint }[]>(
      `SELECT "revision" FROM "settings_revision" WHERE "id" = 1`,
    );
    const settings = renderAllSettings(rows);
    // Built from the rendered settings rather than from the raw override
    // rows, so a capability sitting at its default (null) is reported the
    // same way as one explicitly set to null — the two mean the same thing
    // to every gate, and distinguishing them here would be a difference
    // without a consequence.
    const resolvedValues = Object.fromEntries(
      settings.map((setting) => [setting.key, setting.value]),
    );
    return {
      settings,
      unrecognised: renderUnrecognisedSettings(rows),
      constants: renderBuildConstants(),
      bootstrap: renderBootstrapVariables(),
      capabilities: renderCapabilities(resolvedValues, await readCapabilityChecks(ctx.db)),
      revision: (revisionRows[0]?.revision ?? 0n).toString(),
    };
  },
});
