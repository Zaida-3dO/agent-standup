// `update_item` — SCHEMA.md §19 `PATCH /items/{id}` ("Edit non-state
// fields"). Transitioning `state` is MILESTONES.md #27's own operation, not
// this one — a guarded move needs the transition guard layer (#19), which
// this row does not own, so `state` is deliberately absent from this
// operation's input schema rather than merely unchecked.
import { z } from "zod";
import { NotFoundError } from "../errors";
import { defineOperation } from "../operation";
import type { ServiceContext } from "../context";
import { resolveAreasRaw, setItemAreas } from "../items/item-areas";
import { linksInputSchema, normalizeLinks, setItemLinks } from "../items/item-links";
import {
  HEADLINE_MAX_CHARS,
  ITEM_COLUMNS,
  toItemRecord,
  toItemWriteRecord,
  type ItemRecord,
  type ItemWriteRecord,
  type RawItemRow,
} from "../items/row";
import { callerEventActor, liveAssignmentId } from "../items/event-attribution";
import { noSuchRepoMessage } from "../items/no-such-repo";
import { recordFieldChanges } from "@/lib/events";
import { evaluateNotifications, snapshotOf, type NotificationOutcome } from "../notify-on-change";
import { normalizeEmDashNoting } from "@/lib/text-normalize";
import { titleAdviceFor } from "@/lib/item-title";
import { resolveItemId } from "../items/resolve-id";

const inputSchema = z
  .object({
    id: z.string().min(1),
    // Same em-dash-to-hyphen normalisation `create_item` applies — see
    // `text-normalize.ts`. An edit is as much "input" as a create.
    //
    // NOT normalised by this schema's own `.transform()`, deliberately —
    // see `commonCreateShape.title` in `create-core.ts` for the identical
    // reasoning. The rewrite still happens unconditionally, in the handler
    // below, which is also where `titleAdvice` needs the pre-rewrite string
    // to say whether it happened.
    title: z.string().trim().min(1).optional(),
    /**
     * The one-line BLUF (MILESTONES.md #107). Editable because the row's
     * whole claim is that it is "maintained as it moves" — a headline
     * written at mint and never updated describes the work as it was
     * *proposed*, which is the least useful moment to freeze it at.
     * Nullable so it can be cleared back to "nobody has written one",
     * which is a state the read distinguishes.
     */
    headline: z.string().trim().min(1).max(HEADLINE_MAX_CHARS).nullable().optional(),
    body: z.string().optional(),
    priority: z.enum(["P0", "P1", "P2", "P3"]).optional(),
    /**
     * Sets the item's area set to exactly this one area (SCHEMA.md §23.1) —
     * so editing `area` on a multi-area item **narrows it to one**, which is
     * the only reading under which `area` keeps meaning the same thing on a
     * read and on a write.
     */
    area: z.string().trim().min(1).optional(),
    /**
     * Sets the item's whole area set to exactly this list, **primary
     * first**. A whole-set write rather than an add/remove pair: the set
     * arrives whole everywhere it is written (see `setItemAreas`), and a
     * caller that has to compose two operations to move an item between
     * areas can leave it briefly in neither. Supplying both `area` and
     * `areas` is refused.
     */
    areas: z.array(z.string().trim().min(1)).min(1).optional(),
    repo: z.string().min(1).nullable().optional(),
    branch: z.string().nullable().optional(),
    needsVisualReview: z.boolean().optional(),
    driveMode: z.enum(["autonomous", "supervised", "manual"]).optional(),
    mergeAuthority: z.enum(["pre-approved", "needs-approval", "agent-judgement", "pr"]).optional(),
    customFields: z.record(z.string(), z.unknown()).optional(),
    /**
     * Sets the item's link set to exactly this list — a whole-set write, the
     * same shape `areas` uses and for the same reason: the set arrives whole
     * everywhere it is written, and a caller that had to compose an add and
     * a remove could leave an item briefly pointing at the wrong thing.
     *
     * **Passing `[]` clears every link**, which is the one genuinely
     * destructive reading of this field and is deliberate rather than
     * incidental: there has to be *some* way to remove a link that turned
     * out to be wrong, and a whole-set write already means "these are the
     * links" — an empty list is that sentence with nothing in it. Omitting
     * the field leaves the set untouched, which is what an update that says
     * nothing about links should do.
     */
    links: linksInputSchema.optional(),
    /**
     * Return the whole `items` row rather than the slim default — the same
     * flag `get_item`/`list_items`/`get_board` take (MILESTONES.md #107).
     * Off by default. An edit is the sharpest case for this: a caller that
     * has just *sent* a 3,000-character `body` does not need it read back,
     * and before this row that is exactly what it got.
     */
    full: z.boolean().default(false),
  })
  .strict()
  // Both spellings at once is refused rather than resolved by precedence,
  // exactly as on the create paths. Unlike there, NEITHER is fine here: an
  // update patches only what it names, so an edit that says nothing about
  // areas leaves the set alone.
  .refine((value) => value.area === undefined || value.areas === undefined, {
    message: "pass area or areas, not both",
    path: ["areas"],
  });

export type UpdateItemInput = z.infer<typeof inputSchema>;

/**
 * What `update_item` returns — the item, plus who the notification rules say
 * to tell about the edit (MILESTONES.md #101).
 *
 * A widening of `ItemRecord`, not a wrapper: every existing caller reads
 * item fields straight off this result, and nesting them under a key would
 * break each one for no gain. `notifications` is absent when the capability
 * is off (`notify.doc` unset), which stays distinguishable from "on, and
 * nobody matched" — an outcome with empty `recipients`.
 *
 * `titleAdvice` rides along under the same rule `create-core.ts` uses
 * (MILESTONES.md #131): present only when there is something to say about
 * *this call's* title, absent — never `null` — otherwise, so an edit that
 * left `title` alone or sent a title with nothing to note carries no key.
 */
export type UpdateItemResult = (ItemRecord | ItemWriteRecord) & {
  readonly notifications?: NotificationOutcome;
  readonly titleAdvice?: string;
};

const MERGE_AUTHORITY_TO_DB: Record<
  string,
  "pre_approved" | "needs_approval" | "agent_judgement" | "pr"
> = {
  "pre-approved": "pre_approved",
  "needs-approval": "needs_approval",
  "agent-judgement": "agent_judgement",
  // The one value whose API and DB spellings coincide: `pr` is a single
  // word, so there is no hyphen to convert. Listed explicitly rather than
  // left to a fallback, because this map is also what decides which values
  // the operation ACCEPTS -- an unmapped value is refused.
  pr: "pr",
};

/** Every editable field, and how to read its current value off a raw row — for the field-change diff. */
const EDITABLE_FIELDS = [
  "title",
  "headline",
  "body",
  "priority",
  "area",
  "repo",
  "branch",
  "needsVisualReview",
  "driveMode",
  "mergeAuthority",
  "customFields",
] as const;

// Stryker disable all : this metadata is a module-level literal, read into
// the registry at import — before any test body runs and never re-evaluated
// — so a mutation here is unkillable by construction, NOT untested.
// `scripts/check-operation-metadata-mutants.mjs` requires this and carries
// the full reasoning, including why moving the assertions into a test body
// does not help.
export const updateItem = defineOperation({
  name: "update_item",
  kind: "write",
  summary: "Edits an item's non-state fields.",
  contract: {
    rules: [
      {
        fields: ["repo"],
        rule:
          "`repo` must name an existing, non-archived row in the Repo table, or be explicit `null` " +
          "to clear it. Repos are deliberate-create only and are never auto-created from this field; " +
          "an id naming an archived repo is refused the same as one that never existed. The schema " +
          "cannot enumerate valid ids because the set is a database table, not a fixed list, so a " +
          "refusal for an unrecognised `repo` names the valid ids itself (closest matches to what you " +
          "sent first, capped, with a count of the rest) — the refusal is the enumeration. From " +
          "MCP: `get_board` shows `repo` by default, and `list_items` shows it with `full: true`, so " +
          "the ids already in play are visible on the items you can already list — there is no " +
          "operation that enumerates the Repo table itself from MCP. The direct enumeration is " +
          "`list_repos` [http/cli], for HTTP/CLI callers only.",
      },
      {
        fields: ["headline"],
        rule:
          `\`headline\` is capped at ${HEADLINE_MAX_CHARS} characters, or explicit \`null\` to clear ` +
          "it back to unwritten. The cap is enforced but not visible in the schema (a bare capped " +
          "string), so this is the only place it is stated before you are refused for it.",
      },
    ],
  },
  // Stryker restore all
  input: inputSchema,
  async handler(ctx: ServiceContext, input: UpdateItemInput): Promise<UpdateItemResult> {
    // A full UUID passes straight through untouched; a short id becomes
    // the one item it identifies, or refuses when it names more than
    // one. Rebinding `input` rather than threading a separate variable
    // is what makes this safe: every read of the id below this line —
    // including the ones inside the guards and the event rows — sees the
    // canonical id, so a short id cannot survive into a stored value.
    input = {
      ...input,
      id: await resolveItemId(ctx.db, input.id, "id"),
    };

    const { id, full, ...rawEdits } = input;
    // Applied at every return below, including the two no-op paths: an
    // empty patch and a no-op patch are the calls most likely to be made in
    // a loop, so they are the last places that should answer with the whole
    // record.
    const shape = (record: ItemRecord): ItemRecord | ItemWriteRecord =>
      full ? record : toItemWriteRecord(record);
    const edits = Object.fromEntries(
      Object.entries(rawEdits).filter(([, value]) => value !== undefined),
    ) as Partial<Omit<UpdateItemInput, "id">>;

    // The em-dash rewrite, applied here rather than in the schema's own
    // `.transform()` — see the `title` field's comment above for why.
    // `titleWasRewritten` is `false` (never fired) when this edit does not
    // touch `title` at all, which is correct: nothing was rewritten because
    // nothing was sent.
    let titleWasRewritten = false;
    if (edits.title !== undefined) {
      const normalized = normalizeEmDashNoting(edits.title);
      edits.title = normalized.value;
      titleWasRewritten = normalized.rewritten;
    }

    const currentRows = await ctx.db.$queryRawUnsafe<RawItemRow[]>(
      `SELECT ${ITEM_COLUMNS} FROM "Item" WHERE "id" = $1`,
      id,
    );
    const current = currentRows[0];
    if (!current) {
      throw new NotFoundError(`No such item: ${id}.`, { fields: ["id"] });
    }

    // Both spellings collapse to one resolved set here, so everything below
    // deals with a single concept. `area: "x"` is the one-element set —
    // narrowing a multi-area item to exactly that area (see the schema).
    //
    // `edits.area` is then set to the set's PRIMARY entry so the existing
    // column-diff loop below carries it: that is what makes an area change
    // still emit its `field_change` event and still be seen by the
    // notification rules, neither of which knows about the join table.
    // `areas` itself is deleted from `edits` because the loop is driven by
    // `EDITABLE_FIELDS`, which maps one key to one column — a join table has
    // no column for it to set.
    const rawAreas = edits.areas ?? (edits.area !== undefined ? [edits.area] : undefined);
    let resolvedAreas: string[] | undefined;
    if (rawAreas !== undefined) {
      resolvedAreas = await resolveAreasRaw(ctx, rawAreas);
      edits.area = resolvedAreas[0];
      delete edits.areas;
    }
    // Links, resolved the same way and for the same reason: `EDITABLE_FIELDS`
    // drives a loop that maps one key to one column, and a join table has no
    // column for it to set. Unlike `area` there is no primary-entry column to
    // carry, so this one is removed from `edits` outright and handled below.
    //
    // Normalised before anything is written, so an unusable URL refuses the
    // call without having edited the row — the ordering `resolveAreasRaw`
    // above uses for the same purpose.
    const rawLinks = edits.links;
    let resolvedLinks: { key: string; url: string }[] | undefined;
    if (rawLinks !== undefined) {
      resolvedLinks = normalizeLinks(rawLinks);
      delete edits.links;
    }
    if (edits.repo) {
      const repoRows = await ctx.db.$queryRawUnsafe<{ id: string }[]>(
        `SELECT "id" FROM "Repo" WHERE "id" = $1 AND "archivedAt" IS NULL`,
        edits.repo,
      );
      if (repoRows.length === 0) {
        throw new NotFoundError(await noSuchRepoMessage(ctx.db, edits.repo), { fields: ["repo"] });
      }
    }

    // Nothing to do: no `RETURNING` clause and no event row for a no-op
    // call, so an empty patch (or a patch whose only key already matched
    // the current value's shape, e.g. resubmitting the same title) stays
    // provably a no-op rather than adding a phantom entry to the ledger.
    const setClauses: string[] = [];
    const values: unknown[] = [];
    let paramIndex = 1;
    const changes: { field: string; from: unknown; to: unknown }[] = [];

    for (const field of EDITABLE_FIELDS) {
      if (!(field in edits)) continue;
      const rawNewValue = (edits as Record<string, unknown>)[field];
      const oldValue = (current as unknown as Record<string, unknown>)[field];
      // `mergeAuthority` is the one editable field whose API encoding
      // (hyphenated, `"needs-approval"`) differs from its stored encoding
      // (underscored, `"needs_approval"` — the Postgres enum label). Every
      // other editable field's API form and stored form are the same
      // string (SCHEMA.md §1's enums: Priority, DriveMode use identical
      // spellings on both sides). Diffing against the *stored* form here —
      // rather than the raw input — is what makes "unchanged" actually mean
      // unchanged: comparing the two encodings directly always disagrees,
      // which is what produced a phantom field_change event on every
      // mergeAuthority no-op (review round 1, MEDIUM 1).
      const newValue =
        field === "mergeAuthority" ? MERGE_AUTHORITY_TO_DB[rawNewValue as string] : rawNewValue;
      if (JSON.stringify(newValue) === JSON.stringify(oldValue)) continue;

      changes.push({ field, from: oldValue, to: newValue });

      if (field === "mergeAuthority") {
        setClauses.push(`"mergeAuthority" = $${paramIndex}::"MergeAuthority"`);
        values.push(newValue);
      } else if (field === "priority") {
        setClauses.push(`"priority" = $${paramIndex}::"Priority"`);
        values.push(newValue);
      } else if (field === "driveMode") {
        setClauses.push(`"driveMode" = $${paramIndex}::"DriveMode"`);
        values.push(newValue);
      } else if (field === "customFields") {
        setClauses.push(`"customFields" = $${paramIndex}::jsonb`);
        values.push(JSON.stringify(newValue));
      } else {
        const column = field === "needsVisualReview" ? '"needsVisualReview"' : `"${field}"`;
        setClauses.push(`${column} = $${paramIndex}`);
        values.push(newValue);
      }
      paramIndex++;
    }

    // The area SET can change while the PRIMARY area does not — adding a
    // second area to an item, or reordering all but the first. The column
    // diff above sees nothing in that case, so it has to be asked
    // separately, or `{ areas: ["web", "infra"] }` on a `web` item would be
    // silently discarded as a no-op by the early return below.
    const areasChanged =
      resolvedAreas !== undefined &&
      JSON.stringify(resolvedAreas) !== JSON.stringify(current.areas ?? [current.area]);

    if (areasChanged) {
      await setItemAreas(ctx, id, resolvedAreas!);
    }

    // The link set has no column at all, so like `areas` it is invisible to
    // the diff loop above and has to be asked separately — otherwise
    // `{ links: [...] }` on its own would be discarded as a no-op by the
    // early return below.
    //
    // Compared against the stored set in the SAME order the read returns
    // (key, then url), because `normalizeLinks` preserves the caller's order
    // while `ITEM_LINKS_COLUMN` sorts. Without sorting both sides, sending
    // the identical set in a different order would read as a change, write
    // the same rows back, and append a `field_change` event recording that
    // nothing happened — the phantom-event failure the `mergeAuthority`
    // comment above documents.
    const sortedLinks =
      resolvedLinks === undefined
        ? undefined
        : [...resolvedLinks].sort(
            (a, b) => a.key.localeCompare(b.key) || a.url.localeCompare(b.url),
          );
    const linksChanged =
      sortedLinks !== undefined &&
      JSON.stringify(sortedLinks) !== JSON.stringify(current.links ?? []);

    if (linksChanged) {
      await setItemLinks(ctx, id, sortedLinks!);
    }

    // The rewrite note (MILESTONES.md #131's mechanism, reused): computed
    // once here from `edits.title` (already normalised above) rather than
    // per return path, since it depends only on whether THIS call's title
    // was rewritten — not on whether that rewrite happened to change the
    // stored value. A caller that resends a title whose em dash was already
    // folded on a previous call is told nothing (its own title carried no
    // em dash to begin with), but a caller whose submitted title happens to
    // normalise to what is already stored still gets told: it sent an em
    // dash and the stored form does not have one, on this call, which is
    // the exact fact `titleAdvice` exists to surface.
    const titleAdvice =
      edits.title === undefined
        ? undefined
        : (titleAdviceFor(edits.title, "title", titleWasRewritten) ?? undefined);
    const withTitleAdvice = (record: ItemRecord | ItemWriteRecord): UpdateItemResult =>
      titleAdvice === undefined ? record : { ...record, titleAdvice };

    if (setClauses.length === 0) {
      if (!areasChanged && !linksChanged) {
        return withTitleAdvice(shape(toItemRecord(current)));
      }
      // Only a join table changed, so there is no column to UPDATE — re-read
      // the row to pick up the `areas`/`links` the write above just made
      // true, rather than returning the pre-write snapshot.
      const reread = await ctx.db.$queryRawUnsafe<RawItemRow[]>(
        `SELECT ${ITEM_COLUMNS} FROM "Item" WHERE "id" = $1`,
        id,
      );
      const rereadRow = reread[0];
      if (!rereadRow) {
        throw new NotFoundError(`No such item: ${id}.`, { fields: ["id"] });
      }
      // Only the sets that actually changed are recorded. Either one alone
      // can reach this branch, so listing both unconditionally would append
      // a `field_change` claiming the untouched set had been rewritten.
      const joinBefore: Record<string, unknown> = {};
      const joinAfter: Record<string, unknown> = {};
      const joinFields: string[] = [];
      if (areasChanged) {
        joinBefore.areas = current.areas ?? [current.area];
        joinAfter.areas = resolvedAreas;
        joinFields.push("areas");
      }
      if (linksChanged) {
        joinBefore.links = current.links ?? [];
        joinAfter.links = sortedLinks;
        joinFields.push("links");
      }
      await recordFieldChanges(ctx.db, {
        itemId: id,
        actor: callerEventActor(ctx.caller),
        assignmentId: await liveAssignmentId(ctx.db, id, ctx.caller),
        before: joinBefore,
        after: joinAfter,
        fields: joinFields,
      });
      return withTitleAdvice(shape(toItemRecord(rereadRow)));
    }

    setClauses.push(`"updatedAt" = CURRENT_TIMESTAMP`);
    values.push(id);

    const rows = await ctx.db.$queryRawUnsafe<RawItemRow[]>(
      `UPDATE "Item" SET ${setClauses.join(", ")} WHERE "id" = $${paramIndex} RETURNING ${ITEM_COLUMNS}`,
      ...values,
    );
    const updated = rows[0];
    if (!updated) {
      throw new NotFoundError(`No such item: ${id}.`, { fields: ["id"] });
    }

    // "Every mutating call appends a row" (SCHEMA.md §3) — one field_change
    // event per changed field, so an edit touching several fields at once
    // (e.g. re-triaging priority and area together) reads back as several
    // distinct facts rather than one payload a consumer has to unpack.
    //
    // Through `recordFieldChanges` (#102), which is that loop plus the
    // `appendEvent` call — its first caller, and the reason it was written.
    // Routing through it is what gets `sessionId` and `assignmentId` onto
    // the rows; the inline five-column insert had nowhere to put either.
    //
    // The snapshots handed to it are built from `changes`, NOT from the raw
    // input and the loaded row. That matters: `changes` already holds the
    // *stored* form of each value (`mergeAuthority` is spelled one way in
    // the API and another in the Postgres enum), and it already dropped
    // every field whose new value equals its stored value. Passing the raw
    // input instead would re-diff the two encodings against each other and
    // resurrect the phantom `mergeAuthority` field_change on a no-op that
    // this function's own loop above exists to prevent. `recordFieldChanges`
    // compares with the same `JSON.stringify` equality, so every entry here
    // is one it will agree has changed.
    const before: Record<string, unknown> = {};
    const after: Record<string, unknown> = {};
    for (const change of changes) {
      before[change.field] = change.from;
      after[change.field] = change.to;
    }
    // `areas` rides alongside the column changes, and `area` still travels
    // on its own. Both are recorded because they answer different questions —
    // `area` is what the notification whitelist and every single-area
    // consumer reads, `areas` is the whole set — and a ledger carrying only
    // one of them would leave the other's history unreconstructable.
    const fields = changes.map((change) => change.field);
    if (areasChanged) {
      before.areas = current.areas ?? [current.area];
      after.areas = resolvedAreas;
      fields.push("areas");
    }
    // `links` rides alongside for the same reason, and only when it changed
    // — a set rewritten to its existing contents is not a fact worth a row.
    if (linksChanged) {
      before.links = current.links ?? [];
      after.links = sortedLinks;
      fields.push("links");
    }
    await recordFieldChanges(ctx.db, {
      itemId: id,
      actor: callerEventActor(ctx.caller),
      assignmentId: await liveAssignmentId(ctx.db, id, ctx.caller),
      before,
      after,
      fields,
    });

    const record = toItemRecord(updated);

    // The notification evaluator's caller — MILESTONES.md #101. An edit is
    // the only thing that changes four of the whitelisted fields a rule may
    // watch (`area`, `repo`, `priority`, `drive_mode`, `merge_authority`),
    // so wiring only `transition_item` would leave those rules dead.
    //
    // No event is written for the result, deliberately. The obvious shortcut
    // — appending a `note` — would be recording a notification under an
    // event type that means something else, and a `notify`/`notified` type of
    // its own is a schema change that needs its own row (SCHEMA.md §3: add an
    // event type only when the code that emits it exists). Returned instead,
    // which is what `transition_item` does with the same value.
    const notifyDoc = ctx.settings.values["notify.doc"];
    const notifications =
      notifyDoc === null
        ? undefined
        : await evaluateNotifications(
            ctx.db,
            notifyDoc,
            snapshotOf(toItemRecord(current), null),
            snapshotOf(record, null),
          );

    const shaped = withTitleAdvice(shape(record));
    return notifications ? { ...shaped, notifications } : shaped;
  },
});
