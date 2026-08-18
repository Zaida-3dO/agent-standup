// Find-or-create for the inbox project — SCHEMA.md §17.2
// (`items.inbox_project`).
//
// The inbox is addressed by *title*, resolved to an id here. A setting that
// held an id could not ship a working default, because no id exists in a
// database nobody has written to yet; a title can, so quick capture works on
// a fresh install with no configuration at all.
//
// Find-or-create rather than create: the second task filed to the inbox must
// land in the same project as the first, or the "inbox" is a pile of
// single-task projects. The lookup is `title = $1 AND parentId IS NULL`,
// which is the definition of a root project with that name.
//
// **The race, and why it is left where it is.** Two concurrent inbox creates
// can both find nothing and both insert, producing two projects with the
// same title. There is no unique index on `Item.title` and adding one would
// be wrong — projects are allowed to share a title in general. The outcome
// of losing this race is a duplicate inbox project, which is untidy and
// self-correcting (the next call finds one of them and uses it consistently
// thereafter, since the lookup is ordered), not a lost or misfiled task. A
// constraint that made it impossible would cost every other project the
// right to a non-unique name, which is a worse trade than the duplicate.
import type { ServiceContext } from "../context";
import { ensureAreaRaw } from "./ensure-area-raw";
import { callerEventActor } from "./event-attribution";
import { setItemAreas } from "./item-areas";
import { assertOriginResolved } from "./create-core";
import { resolveSessionDefaults } from "./session-defaults";
import { appendEvent } from "@/lib/events";
import { InternalError, NotFoundError } from "../errors";

/**
 * The id of the inbox project, creating it if this is the first task to ask.
 *
 * `origin` is taken from the task being filed so the minted project is
 * attributed the same way the task is — a project that appeared because a
 * source sweep captured something is a `source` project, not an `auto` one,
 * and `origin_person` is required whenever `origin_type` is `person`
 * (SCHEMA.md §1) so it cannot simply be dropped.
 *
 * `originType` is optional on the way in and resolved here, because this
 * runs *before* `insertItem` does its own resolution (MILESTONES.md #111):
 * `create_task` has to know which project it is filing under before it can
 * insert the task. Resolving the session's declaration in both places is not
 * duplication of a decision — it is the same decision asked at the only two
 * moments an item is written, and the alternative is an inbox project
 * attributed `auto` while the task inside it is attributed to a person.
 */
export async function resolveInboxProject(
  ctx: ServiceContext,
  origin: {
    /** The filed task's `area` spelling — see `areas` for how the two combine. */
    readonly area?: string;
    /** The filed task's `areas` spelling. The inbox inherits the PRIMARY area only — see below. */
    readonly areas?: readonly string[];
    readonly originType?: "person" | "source" | "auto";
    readonly originPersonId?: string;
    /** The filed task's drive mode, so the container matches what it contains. */
    readonly driveMode?: "autonomous" | "supervised" | "manual";
  },
): Promise<string> {
  const title = ctx.settings.values["items.inbox_project"];

  const existing = await ctx.db.$queryRawUnsafe<{ id: string }[]>(
    `SELECT "id" FROM "Item"
     WHERE "parentId" IS NULL AND "title" = $1
     ORDER BY "createdAt" ASC, "id" ASC
     LIMIT 1`,
    title,
  );
  const found = existing[0];
  if (found) return found.id;

  // Only reached when the inbox has to be minted, so the session read costs
  // nothing on the overwhelmingly common path where it already exists.
  const resolvedOrigin = await resolveSessionDefaults(ctx, origin);
  assertOriginResolved(resolvedOrigin);

  // The same existence check `insertItem` runs, for the same reason: a
  // person is validated whether it was typed into the call or inherited from
  // the session, so a declaration cannot write a reference the database will
  // not accept. Without it the foreign key still refuses — nothing dangling
  // is ever stored — but it surfaces as an opaque internal error rather than
  // as a `not_found` naming the field, which is a materially worse answer
  // for the same fault.
  if (resolvedOrigin.originType === "person" && resolvedOrigin.originPersonId) {
    const personRows = await ctx.db.$queryRawUnsafe<{ id: string }[]>(
      `SELECT "id" FROM "Person" WHERE "id" = $1`,
      resolvedOrigin.originPersonId,
    );
    if (personRows.length === 0) {
      throw new NotFoundError(`No such person: ${resolvedOrigin.originPersonId}.`, {
        fields: ["originPersonId"],
      });
    }
  }

  // The inbox inherits the filed task's area rather than inventing one. An
  // area is required on every item (SCHEMA.md §1) and there is no sensible
  // constant to reach for — a hardcoded "inbox" area would mint a second
  // piece of vocabulary nobody asked for and make the inbox's own filtering
  // useless.
  //
  // The task's PRIMARY area only, when the task named several. The inbox is
  // a container for work that had nowhere else to go, not work that is
  // itself cross-area; giving it every area of the first task to arrive
  // would file the container under areas no later task in it shares, and
  // that first task's set would silently decide the inbox's own filtering
  // forever after.
  const primaryArea = origin.areas?.[0] ?? origin.area;
  if (primaryArea === undefined) {
    throw new InternalError(
      new Error("resolveInboxProject called with neither area nor areas."),
      "The operation failed unexpectedly.",
    );
  }
  const area = await ensureAreaRaw(ctx, primaryArea);

  const id = crypto.randomUUID();
  const rows = await ctx.db.$queryRawUnsafe<{ id: string }[]>(
    `INSERT INTO "Item" (
       "id", "parentId", "kind", "title", "body", "state", "priority",
       "originType", "originPersonId", "area", "needsVisualReview",
       "driveMode", "mergeAuthority", "updatedAt"
     ) VALUES (
       $1, NULL, 'project'::"ItemKind", $2, '', 'on_deck'::"ItemState", 'P2'::"Priority",
       $3::"OriginType", $4, $5, false,
       $6::"DriveMode", $7::"MergeAuthority", CURRENT_TIMESTAMP
     )
     RETURNING "id"`,
    id,
    title,
    resolvedOrigin.originType,
    resolvedOrigin.originPersonId ?? null,
    area,
    // The same fallback `insertItem` applies, from the same resolution. A
    // constant here would put the inbox project on a different drive mode
    // from the very task being filed into it — the identical mismatch this
    // function already resolves `originType` to avoid, on the field that
    // decides how much the system may act unattended.
    resolvedOrigin.driveMode ?? "autonomous",
    ctx.settings.values["items.default_merge_authority"].replace(/-/g, "_"),
  );
  const row = rows[0];
  if (!row) {
    throw new InternalError(
      new Error("Inbox project insert returned no row."),
      "The operation failed unexpectedly.",
    );
  }

  // The insert above writes `Item.area` directly (it needs the column filled
  // before the row exists), so this is the second write `setItemAreas`
  // warns against — except it is the SAME function, called immediately
  // after, inside this call's one transaction. The project ends up with
  // exactly one `ItemArea` row (its primary), which is what makes it
  // visible to `areaFilterCondition` — that filter reads ONLY `ItemArea`,
  // so an inbox project with none is invisible to every area filter even
  // though its own `area` column names one correctly.
  await setItemAreas(ctx, row.id, [area]);

  // The inbox is an item like any other, so its creation is a ledger row
  // like any other (SCHEMA.md §3) — otherwise a project would exist that
  // "when did this come to exist" cannot answer.
  await appendEvent(ctx.db, {
    itemId: row.id,
    actor: callerEventActor(ctx.caller),
    type: "field_change",
    payload: { field: "state", from: null, to: "on_deck" },
  });

  return row.id;
}
