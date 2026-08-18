// Defaults a session declares once and later calls inherit — MILESTONES.md
// #111, SCHEMA.md §21 (the registration handshake), §1.2 (`drive_mode`).
//
// ── The problem, stated as a caller experiences it ──────────────────────
//
// A session that is driven by a person is driven by that person for its
// whole life, and a session running unattended runs unattended for its whole
// life. Neither fact changes between two `create_task` calls a minute apart.
// Yet every creation call has had to carry both — `originType`,
// `originPersonId`, `driveMode` — so a caller restates on every write
// something it already told the server at registration. That is context
// spent per call on a constant, which is the same cost `describe_tool`
// exists to avoid paying in tool descriptions.
//
// ── Why this is a resolution and not a schema default ───────────────────
//
// The values cannot move into `commonCreateShape` as `.default()`s, because
// a Zod default resolves before any handler runs and has no access to the
// caller. The resolution needs the session row, which means it happens after
// parsing, inside the transaction — which is also where it belongs, since
// what a session declared is a database fact and not an input.
//
// ── An explicit value always wins, and silence is never inferred ────────
//
// This resolves *omitted* fields only. A caller that names `driveMode`
// gets what it named, including when that equals what the session declared,
// because the point is that the call is on the record either way.
//
// The distinction that makes this safe is the one `Session.driveMode` is
// nullable for: a session that declared nothing is not a session that
// declared `autonomous`. Only a real declaration is inherited, so this can
// never manufacture a value nobody chose — an unregistered session, or one
// that registered without declaring, falls through to exactly the item-level
// defaults that applied before this existed.
//
// ── `originType` is inferred, and only in the one direction that is sound
//
// A session with a declared `personId` that omits `originType` gets
// `person`, with that person as `originPersonId`. This is the one inference
// here, and it is worth being explicit about why it is not a guess: a
// session declares a person precisely to say "the work I create comes from
// this person", so `originType: "person"` is what the declaration *means*
// rather than something derived from it.
//
// The reverse is deliberately not done. A session with no declared person
// does **not** get `originType: "auto"` — a caller creating an item on
// somebody's behalf from an autonomous session is ordinary, and defaulting
// the field would quietly relabel that work as machine-originated. So
// `originType` stays required unless a person declaration answers it, and
// the refusal a caller gets for omitting it is unchanged in every other
// case.
import type { ServiceContext } from "../context";

/** What a session declared at registration, as far as a creation call cares. */
export interface SessionDeclaration {
  readonly personId: string | null;
  readonly driveMode: "autonomous" | "supervised" | "manual" | null;
}

/**
 * The declaration on the calling session's row, or `null` when there is no
 * session or no row for it.
 *
 * A single narrow read — two columns, by primary key — rather than a join
 * onto every create, so a call that supplies everything explicitly and a
 * call that inherits differ by one indexed lookup. Skipped entirely when
 * the caller carries no session, which is every in-process call and every
 * adapter that has not registered one.
 */
export async function readSessionDeclaration(
  ctx: ServiceContext,
): Promise<SessionDeclaration | null> {
  const sessionId = ctx.caller.sessionId;
  if (sessionId === undefined) return null;

  const rows = await ctx.db.$queryRawUnsafe<
    { personId: string | null; driveMode: string | null }[]
  >(`SELECT "personId", "driveMode" FROM "Session" WHERE "id" = $1`, sessionId);
  const row = rows[0];
  if (!row) return null;

  return {
    personId: row.personId,
    driveMode: (row.driveMode as SessionDeclaration["driveMode"]) ?? null,
  };
}

/** The subset of a create's input this resolution touches. */
export interface ResolvableOrigin {
  readonly originType?: "person" | "source" | "auto";
  readonly originPersonId?: string;
  readonly driveMode?: "autonomous" | "supervised" | "manual";
}

/**
 * Fills a create's omitted origin and drive fields from what the session
 * declared. Pure, so the rules above are testable without a database.
 *
 * Returns only the fields it resolved, for the caller to spread over its
 * parsed input. A partial rather than a whole input, so a field this
 * function has nothing to say about cannot be accidentally overwritten with
 * `undefined` by a spread.
 */
export function applySessionDeclaration(
  input: ResolvableOrigin,
  declaration: SessionDeclaration | null,
): ResolvableOrigin {
  if (declaration === null) return {};

  const resolved: {
    originType?: "person" | "source" | "auto";
    originPersonId?: string;
    driveMode?: "autonomous" | "supervised" | "manual";
  } = {};

  if (input.driveMode === undefined && declaration.driveMode !== null) {
    resolved.driveMode = declaration.driveMode;
  }

  if (declaration.personId !== null) {
    // The person is supplied whenever the origin is — or resolves to —
    // `person` and the caller named nobody. Covers both the inference
    // (`originType` omitted entirely) and the case a caller states
    // `originType: "person"` and leaves the session to say which person,
    // which is the shape that actually removes a field from the common call.
    if (input.originType === undefined) {
      resolved.originType = "person";
    }
    const effectiveOrigin = input.originType ?? "person";
    if (effectiveOrigin === "person" && input.originPersonId === undefined) {
      resolved.originPersonId = declaration.personId;
    }
  }

  return resolved;
}

/**
 * Reads the calling session's declaration and applies it to a create's
 * input — the one call every creation operation makes.
 *
 * Exists as a single function rather than two called in sequence at four
 * sites because the guarantee wanted is that the four creates resolve
 * defaults *identically*. Two steps at each site is two chances for one of
 * them to drift, and the drift would be invisible: each operation would
 * still work, and only the answer to "does `create_subtask` inherit what
 * `create_task` inherits" would quietly become no.
 */
export async function resolveSessionDefaults<T extends ResolvableOrigin>(
  ctx: ServiceContext,
  input: T,
): Promise<T> {
  const declaration = await readSessionDeclaration(ctx);
  return { ...input, ...applySessionDeclaration(input, declaration) };
}
