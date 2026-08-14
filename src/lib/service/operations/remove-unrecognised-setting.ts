// `remove_unrecognised_setting` — the remove action SCHEMA.md §17.3 promises
// for a stored override whose key this build does not declare: "It is listed
// under 'Unrecognised' on `/settings` with a remove action."
//
// **A separate operation from `delete_setting`, on purpose.** The two answer
// different questions and must keep different answers. `delete_setting`
// clears an override and returns the key at its registry default — its whole
// return value is a `RenderedSetting`, which an undeclared key cannot have,
// because the registry entry that would supply the label, help and category
// is exactly what is missing. Widening it would mean either a nullable
// return on the common path or a fabricated rendering for a key nothing
// declares, and it would silently turn its `not_found` refusal — a real
// guard against a typo becoming an inert row — into a success.
//
// So the refusals are swapped rather than removed: this operation refuses a
// key the registry *does* declare, and points at `delete_setting` for it.
// Between them, every key is deletable by exactly one operation, and neither
// can be used to do the other's job by accident.
import { z } from "zod";
import { InvalidInputError, NotFoundError } from "../errors";
import { defineOperation } from "../operation";
import type { ServiceContext } from "../context";
import { isSettingKey } from "@/lib/settings";
import { appendSettingChangeEvent, bumpRevision, readOverrideRow } from "./settings-shared";

const inputSchema = z.object({ key: z.string().min(1) }).strict();

export type RemoveUnrecognisedSettingInput = z.infer<typeof inputSchema>;

export interface RemoveUnrecognisedSettingOutput {
  readonly key: string;
  /** What the row held, returned so the caller can report what it removed. */
  readonly removedValue: unknown;
}

export const removeUnrecognisedSetting = defineOperation({
  name: "remove_unrecognised_setting",
  kind: "write",
  summary: "Removes a stored override row whose key this build does not declare.",
  input: inputSchema,
  async handler(
    ctx: ServiceContext,
    input: RemoveUnrecognisedSettingInput,
  ): Promise<RemoveUnrecognisedSettingOutput> {
    if (isSettingKey(input.key)) {
      // Refused rather than quietly delegating: a caller that reached for
      // this operation believes the key is undeclared, and it is not. Doing
      // the delete anyway would skip `delete_setting`'s rendering of the key
      // back at its default, which is the answer that caller's surface then
      // shows — so it would succeed and leave the page displaying a value
      // the database no longer holds.
      throw new InvalidInputError(
        `${input.key} is a setting this build declares — clear it with delete_setting.`,
        { fields: ["key"] },
      );
    }

    const before = await readOverrideRow(ctx.db, input.key);
    if (!before) {
      // **Not idempotent, unlike `delete_setting`, and deliberately so.**
      // There is no such thing as an undeclared key "at its default": with
      // no row, the key does not exist in any sense this build recognises,
      // so reporting success would tell the caller it removed something that
      // was never there. `delete_setting` can be idempotent precisely
      // because a declared key still means something with no row.
      throw new NotFoundError(`No stored override row for ${input.key}.`, { fields: ["key"] });
    }

    await ctx.db.$executeRawUnsafe(`DELETE FROM "settings" WHERE "key" = $1`, input.key);
    // Bumped for the same reason every other settings write bumps it
    // (§17.2): a cached snapshot's "has anything changed" comparison must
    // move even though this row could never have affected resolution.
    await bumpRevision(ctx.db);
    await appendSettingChangeEvent(ctx.db, {
      key: input.key,
      before,
      after: null,
      batchId: crypto.randomUUID(),
      caller: ctx.caller,
    });

    return { key: input.key, removedValue: before.value };
  },
});
