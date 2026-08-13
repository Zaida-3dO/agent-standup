// `update_machine` — SCHEMA.md §19 `PATCH /machines/{name}`, §15, §23.2.
// MILESTONES.md #92.
//
// **Upsert, not edit-only.** SCHEMA.md §19 lists only `GET`/`PATCH` for
// `/machines` — there is no separate creation verb, unlike `repos`
// (deliberate `POST`) or `areas` (auto-create on item write). A `Machine`
// row otherwise has no admin-reachable way to come into existence before
// its first poll (§20's `standup init`/a future `/poll` upsert, neither
// built yet) — so this operation creates the row on first PATCH, the same
// way `ensureAreaRaw` creates on first item write, rather than refusing a
// caller who wants to set an override before the machine has ever polled.
// `lastPollAt`/`liveSessions` are never admin-writable — those are written
// by `/poll`, not here — so `source_globs` is the only field this touches.
import { z } from "zod";
import { InvalidInputError } from "../errors";
import { defineOperation } from "../operation";
import type { ServiceContext } from "../context";
import { validateOverrideColumn } from "@/lib/settings";
import {
  MACHINE_SELECT,
  toMachineRecord,
  type RawMachineRow,
  type MachineRecord,
} from "../admin/machine-row";

const inputSchema = z
  .object({
    name: z.string().min(1),
    /**
     * Omitted = no change (or, on first creation, no override). `null` =
     * clear the override, inheriting `minting.source_globs`. An array,
     * including `[]`, = set the override. Validated below by the same
     * registry validator the setting itself uses (§17.7) — not re-typed
     * here, so the override can never drift from what it overrides.
     */
    sourceGlobs: z.unknown().optional(),
  })
  .strict();

export type UpdateMachineInput = z.infer<typeof inputSchema>;

export const updateMachine = defineOperation({
  name: "update_machine",
  kind: "write",
  summary: "Sets or clears a machine's source-globs override, creating the machine if it is new.",
  input: inputSchema,
  async handler(ctx: ServiceContext, input: UpdateMachineInput): Promise<MachineRecord> {
    const provided = input.sourceGlobs !== undefined;
    let validatedGlobs: string[] | null = null;

    if (provided) {
      const validated = validateOverrideColumn("machines.source_globs", input.sourceGlobs);
      if (!validated.ok) {
        throw new InvalidInputError(`Invalid sourceGlobs: ${validated.errors.join("; ")}`, {
          fields: ["sourceGlobs"],
        });
      }
      validatedGlobs = validated.value;
    }

    // One statement, race-free: a fresh row is inserted with the validated
    // globs (or NULL — "no override" — if none were given); an existing row
    // has its globs replaced only when the caller actually provided a
    // value, via the CASE rather than a bare `EXCLUDED` assignment, which
    // would otherwise clobber an existing override on every PATCH that
    // touched this machine for an unrelated reason. `sourceGlobs` is the
    // only admin-writable field this operation declares, and the CASE is
    // what keeps a second one from silently regaining that same hazard.
    const rows = await ctx.db.$queryRawUnsafe<RawMachineRow[]>(
      `INSERT INTO "Machine" ("name", "source_globs")
       VALUES ($1, $2::text[])
       ON CONFLICT ("name") DO UPDATE
         SET "source_globs" = CASE WHEN $3::boolean THEN $2::text[] ELSE "Machine"."source_globs" END
       RETURNING ${MACHINE_SELECT}`,
      input.name,
      validatedGlobs,
      provided,
    );
    return toMachineRecord(rows[0]!);
  },
});
