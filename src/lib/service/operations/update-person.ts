// `update_person` — SCHEMA.md §19 `/people`, §8a ("Netflix-style profile
// picker … archive rather than delete; attribution rows point here"),
// §1.1b (`notify_rules`). MILESTONES.md #116.
//
// **The gap this closes.** `people` was the only entity in the system with
// a reader and no writer: `list_people` read a table that nothing could
// populate. That is not a cosmetic hole — three capabilities were dead
// because of it, and the third loses data rather than merely blocking:
//
//   1. The profile picker (§8a) hard-gates the UI on a table with no rows.
//   2. `merge.requires_authorisation` needs a *person* to record an
//      approving `code_review` artifact, so no `needs_approval` item could
//      reach `merged`.
//   3. `create_item` accepts `originPersonId` with `originType: "person"`
//      and verifies the person exists — unsatisfiable with no way to mint
//      one, so every item had to claim `source` or `auto` origin even when
//      a human asked for it. Provenance was being silently mis-recorded for
//      as long as this was missing, and reconstructing it later means
//      guessing who asked.
//
// ── Why one upsert rather than create + update ──────────────────────────
//
// Matching the two closest siblings rather than the two furthest. `repos`
// and `areas` split creation out (`create_repo` refuses a colliding id;
// `create_area` find-or-creates), but `machines` and `accounts` — the two
// admin entities keyed on a caller-supplied natural id, which is exactly
// what `Person.id` is (a bare `String @id`, not a generated one) — are both
// a single `INSERT … ON CONFLICT DO UPDATE` named `update_*`. `Person` sits
// with those two, so it is spelled like those two.
//
// `remove_unrecognised_setting`'s precedent (do not widen an operation
// whose return shape cannot hold the new case) does not apply here: there
// is no existing operation being widened, and one `PersonAdminRecord`
// describes a freshly created row and an edited one equally well. The
// distinction a split would buy — "refuse if it already exists" — is the
// guard `create_repo` wants because aiming the merge gate at the wrong
// repository is a silent, costly mistake. Re-running `update_person` for a
// profile that exists is not that; it is a caller correcting a display name.
//
// ── `displayName` is required to create, optional to edit ───────────────
//
// Exactly `update_account`'s rule for `vendor`/`displayName`/`planType`: a
// row cannot come into existence without the NOT NULL columns, but an edit
// touching only `colour` must not be forced to restate a name it is not
// changing. Enforced by reading existence first, so the error names the
// missing field instead of surfacing a Postgres NOT NULL violation.
//
// ── The `notifyRules` casing bridge — the subtle one ────────────────────
//
// `notify_rules` is stored `snake_case` (`when_all`/`when_any`, §1.1b) and
// read by `parseStoredRules` in `../notify-on-change.ts`, while the
// evaluator's in-memory `NotifyRule` is `camelCase` (`whenAll`/`whenAny`).
// Storing the camelCase spelling would parse to a rule with *no*
// conditions, and `ruleMatches` treats a missing bucket as vacuously true —
// so the rule would fire on **every** mutation rather than never. That is
// the one direction where getting this wrong is worse than failing closed,
// which is why this operation validates what it is handed in the *stored*
// spelling and refuses anything that would not survive a round-trip
// through the evaluator's parser, rather than storing an opaque blob and
// letting it silently mean something else at evaluation time.
import { z } from "zod";
import { InvalidInputError } from "../errors";
import { defineOperation } from "../operation";
import type { ServiceContext } from "../context";
import { isNotifyField } from "@/lib/notifications";
import {
  PERSON_COLUMNS,
  toPersonAdminRecord,
  type PersonAdminRecord,
  type RawPersonAdminRow,
} from "../admin/person-row";

/** The operators §1.1b allows a condition to use. Mirrors `NotifyOperator`. */
const NOTIFY_OPERATORS = ["eq", "neq", "in", "changed"] as const;

/**
 * One stored condition, in the spelling that lands in the column.
 *
 * `field` is checked against `NOTIFY_FIELD_WHITELIST` via `isNotifyField`
 * rather than re-listed here, so this schema cannot drift from the
 * whitelist the evaluator actually enforces. A condition naming an
 * unwhitelisted field is dropped by `parseStoredRules` on the way back out;
 * refusing it on the way in is what turns a rule that silently does nothing
 * into an error the caller can see.
 */
const conditionSchema = z
  .object({
    field: z.string().refine(isNotifyField, {
      message: "field is not one of the notify-field whitelist",
    }),
    op: z.enum(NOTIFY_OPERATORS),
    value: z.unknown().optional(),
  })
  .strict();

/**
 * One stored rule — `when_all`/`when_any`, the on-disk spelling.
 *
 * `.strict()` is doing real work: it is what rejects a caller who passes
 * the evaluator's `whenAll`/`whenAny` camelCase. Without it that rule would
 * store cleanly, parse to zero conditions, and fire on every single
 * mutation. The refinement below then requires at least one non-empty
 * bucket, which is the same invariant `parseStoredRules` enforces when
 * reading and `hasAtLeastOneBucket` names.
 */
const storedRuleSchema = z
  .object({
    notify: z.array(z.string().min(1)).min(1),
    when_all: z.array(conditionSchema).optional(),
    when_any: z.array(conditionSchema).optional(),
  })
  .strict()
  .refine((rule) => (rule.when_all?.length ?? 0) > 0 || (rule.when_any?.length ?? 0) > 0, {
    message:
      "a rule needs at least one condition in when_all or when_any — " +
      "a rule with neither matches every change and notifies on everything",
  });

const inputSchema = z
  .object({
    id: z.string().trim().min(1),
    /** Required when creating; omitted on an edit means "no change". */
    displayName: z.string().trim().min(1).optional(),
    /** `null` clears it. Omitted = no change. */
    avatar: z.string().trim().min(1).nullable().optional(),
    /** `null` clears it. Omitted = no change. */
    colour: z.string().trim().min(1).nullable().optional(),
    /**
     * `null` clears the rules. Omitted = no change. An array is validated
     * in the stored snake_case spelling — see the module header on why
     * accepting the camelCase spelling here would be actively harmful.
     */
    notifyRules: z.array(storedRuleSchema).nullable().optional(),
    /** `true` archives (sets `archivedAt` to now), `false` un-archives. Omitted = no change. */
    archived: z.boolean().optional(),
  })
  .strict();

export type UpdatePersonInput = z.infer<typeof inputSchema>;

export const updatePerson = defineOperation({
  name: "update_person",
  kind: "write",
  summary: "Creates or edits a profile, and archives or un-archives it.",
  input: inputSchema,
  async handler(ctx: ServiceContext, input: UpdatePersonInput): Promise<PersonAdminRecord> {
    const existing = await ctx.db.$queryRawUnsafe<{ id: string }[]>(
      `SELECT "id" FROM "Person" WHERE "id" = $1`,
      input.id,
    );
    const exists = existing.length > 0;

    // A new row needs the one NOT NULL column that has no default. Checked
    // here so the caller gets a named field back rather than a Postgres
    // constraint violation surfacing as an internal error.
    if (!exists && input.displayName === undefined) {
      throw new InvalidInputError(`Creating a new person requires displayName.`, {
        fields: ["displayName"],
      });
    }

    const displayNameProvided = input.displayName !== undefined;
    const avatarProvided = input.avatar !== undefined;
    const colourProvided = input.colour !== undefined;
    const notifyRulesProvided = input.notifyRules !== undefined;

    // `JSON.stringify(null)` is the four-character *string* `"null"`, not a
    // SQL NULL — passing that through `$5::jsonb` would store the JSON
    // scalar null where the caller asked to clear the rules. `loadPersonRules`
    // filters on `"notifyRules" IS NOT NULL`, so a stored scalar null would
    // slip past that filter and reach `parseStoredRules` on every mutation.
    // Same guard, and same reason, as `update-account.ts`'s budget windows.
    const notifyRulesParam =
      notifyRulesProvided && input.notifyRules !== null ? JSON.stringify(input.notifyRules) : null;

    // One statement, race-free, mirroring `update-account.ts`: a fresh row
    // takes the provided values, and an existing row has a column replaced
    // only where the caller actually provided one — via the CASE rather
    // than a bare `EXCLUDED` assignment, which would clobber every
    // unmentioned field on any PATCH that touched this person for an
    // unrelated reason. `COALESCE` on insert lets the `displayName` param
    // be NULL on a pure edit without violating the NOT NULL column.
    const rows = await ctx.db.$queryRawUnsafe<RawPersonAdminRow[]>(
      `INSERT INTO "Person" ("id", "displayName", "avatar", "colour", "notifyRules", "archivedAt")
       VALUES (
         $1,
         COALESCE($2, (SELECT "displayName" FROM "Person" WHERE "id" = $1)),
         $3,
         $4,
         $5::jsonb,
         CASE WHEN $10::boolean THEN CURRENT_TIMESTAMP ELSE NULL END
       )
       ON CONFLICT ("id") DO UPDATE
         SET "displayName" = CASE WHEN $6::boolean THEN $2 ELSE "Person"."displayName" END,
             "avatar" = CASE WHEN $7::boolean THEN $3 ELSE "Person"."avatar" END,
             "colour" = CASE WHEN $8::boolean THEN $4 ELSE "Person"."colour" END,
             "notifyRules" = CASE WHEN $9::boolean THEN $5::jsonb ELSE "Person"."notifyRules" END,
             "archivedAt" = CASE
               WHEN $11::boolean THEN (CASE WHEN $10::boolean THEN CURRENT_TIMESTAMP ELSE NULL END)
               ELSE "Person"."archivedAt"
             END
       RETURNING ${PERSON_COLUMNS}`,
      input.id,
      input.displayName ?? null,
      input.avatar ?? null,
      input.colour ?? null,
      notifyRulesParam,
      displayNameProvided,
      avatarProvided,
      colourProvided,
      notifyRulesProvided,
      input.archived ?? false,
      input.archived !== undefined,
    );
    return toPersonAdminRecord(rows[0]!);
  },
});
