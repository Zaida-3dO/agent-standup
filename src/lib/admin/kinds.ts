// The administration surface's entity kinds — MILESTONES.md #93: "one page
// pattern per entity kind, over the API from #92".
//
// **"One page pattern" is taken literally: the pattern is code, the kinds
// are data.** Each entry below describes an entity kind — where to read it,
// what to call it, which columns a row shows, and which fields an editor
// offers — and a single set of components renders any of them. Four
// hand-written pages would drift the moment one grew a field, in exactly the
// way SCHEMA.md §17.2 warns about for settings; the same argument applies to
// the surface next door.
//
// **What this deliberately does NOT do is invent validation.** Every rule
// about a value — that an account's vendor must have a registered adapter,
// that `sourceGlobs` and `budgetWindows` satisfy the settings registry
// (§17.7) — lives in the service operations #92 delivered, and is enforced
// there for every caller.
// This layer decides what to *draw* and reports what the service *refuses*.
// A second copy of the rules here would be a second thing to keep in step,
// and the one that drifts is always the copy furthest from the database.
//
// Pure data and pure functions, no DOM: the harness runs `environment:
// "node"` (`vitest.config.ts`), so all of this is exercised directly rather
// than through a rendered component — the same split `src/lib/board/view.ts`
// follows.

/** How a field is edited. Mirrors the shapes the #92 input schemas accept. */
export type AdminFieldKind = "text" | "boolean" | "enum" | "string-list" | "json";

export interface AdminField {
  /** The property name in the API's row and in the PATCH/POST body. */
  readonly name: string;
  readonly label: string;
  readonly help: string;
  readonly kind: AdminFieldKind;
  /** For `enum` — the permitted values. */
  readonly options?: readonly string[];
  /** Required when creating. Never consulted on an edit, where every field is optional. */
  readonly requiredOnCreate?: boolean;
  /**
   * The field cannot be edited after creation — an entity's own identifier,
   * or a value the API exposes read-only. Rendered, never in a PATCH body.
   */
  readonly readOnly?: boolean;
  /**
   * This field overrides a setting (§17.7, §23.2), and `null` means "inherit
   * the global value". The editor offers that as a distinct action rather
   * than as an empty box, because an empty box means an empty *value* for
   * `sourceGlobs`, where `[]` and `null` are genuinely different: an empty
   * override says "look nowhere", and inheriting says "use the setting".
   */
  readonly overridesSetting?: string;
}

export interface AdminKind {
  /** The path segment: `/admin/<slug>`. */
  readonly slug: string;
  readonly title: string;
  /** One row, named for a heading and a button ("New repository"). */
  readonly singular: string;
  readonly blurb: string;
  /** The collection endpoint. */
  readonly listPath: string;
  /** The property the list response carries the array under. */
  readonly collection: string;
  /** The property that identifies a row, and forms its own path segment. */
  readonly idField: string;
  /** Whether the API accepts a create for this kind. */
  readonly canCreate: boolean;
  /**
   * Whether rows can be archived rather than deleted — SCHEMA.md §23.1:
   * "Archive, never delete — attribution and history point at these rows."
   */
  readonly canArchive: boolean;
  readonly fields: readonly AdminField[];
}

/**
 * Repositories — SCHEMA.md §23.1. **Deliberate create**: "A wrong repository
 * aims the merge gate at the wrong repository, and creating one is rare."
 */
const REPOS: AdminKind = {
  slug: "repos",
  title: "Repositories",
  singular: "repository",
  blurb:
    "Where a change lands. Creating one is an explicit act, because the merge gate reads this to decide which repository an item belongs to.",
  listPath: "/api/repos",
  collection: "repos",
  idField: "id",
  canCreate: true,
  canArchive: true,
  fields: [
    {
      name: "id",
      label: "Identifier",
      help: "The exact value an item stores. Chosen once and never edited, because items already point at it.",
      kind: "text",
      requiredOnCreate: true,
      readOnly: true,
    },
    {
      name: "displayName",
      label: "Display name",
      help: "What it is called on screen. Safe to change; nothing stores it.",
      kind: "text",
      requiredOnCreate: true,
    },
    {
      name: "defaultBranch",
      label: "Default branch",
      help: "The branch a change targets unless something says otherwise. Leave blank if you don't know it — a caller reading a blank value has to ask, which is safer than a guess it would trust.",
      kind: "text",
    },
    {
      name: "host",
      label: "Host",
      help: "Where it lives, if that is worth recording. Optional.",
      kind: "text",
    },
    {
      name: "needsVisualReview",
      label: "Needs visual review",
      help: "Every item in this repository reaches a visual-review gate. That gate needs the visual-review document set, or an item has no way through it.",
      kind: "boolean",
    },
  ],
};

/**
 * Areas — SCHEMA.md §23.1. **Auto-created on first use**, so the page exists
 * to rename and archive rather than to populate: "It is written on every
 * item, including research and non-code work; blocking that is friction on
 * the most common operation in the system."
 */
const AREAS: AdminKind = {
  slug: "areas",
  title: "Areas",
  singular: "area",
  blurb:
    "What a piece of work is about. Created automatically the first time an item names one, with the name lowercased and its separators collapsed, so one area is one row however it was typed. Normalising kills case and separator variants, not synonyms — web and website will coexist until somebody merges them.",
  listPath: "/api/areas",
  collection: "areas",
  idField: "id",
  canCreate: true,
  canArchive: true,
  fields: [
    {
      name: "id",
      label: "Identifier",
      help: "The normalised name items store.",
      kind: "text",
      requiredOnCreate: true,
      readOnly: true,
    },
    {
      name: "displayName",
      label: "Display name",
      help: "What it is called on screen.",
      kind: "text",
    },
  ],
};

/**
 * Machines — SCHEMA.md §23.2. Rows appear by polling rather than by being
 * created here, so the page is about the one thing a person sets: the
 * per-machine minting override.
 */
const MACHINES: AdminKind = {
  slug: "machines",
  title: "Machines",
  singular: "machine",
  blurb:
    "The machines that ask for work. A row appears when a machine first polls. The only value set here is where minting looks on that machine, because filesystem layouts differ per machine.",
  listPath: "/api/machines",
  collection: "machines",
  idField: "name",
  // A machine registers itself by polling; there is no create endpoint, and
  // inventing a form that writes a row for a machine that has never
  // reported would create an entry nothing keeps up to date.
  canCreate: false,
  canArchive: false,
  fields: [
    {
      name: "name",
      label: "Name",
      help: "How the machine identifies itself.",
      kind: "text",
      readOnly: true,
    },
    {
      name: "lastPollAt",
      label: "Last poll",
      help: "When it last asked for work.",
      kind: "text",
      readOnly: true,
    },
    {
      name: "liveSessions",
      label: "Live sessions",
      help: "How many sessions it reported running at its last poll.",
      kind: "text",
      readOnly: true,
    },
    {
      name: "sourceGlobs",
      label: "Minting source globs",
      help: "Where minting looks on this machine. Inheriting uses the global setting; an override is the complete list for this machine on its own, and an empty override means this machine mints from nowhere.",
      kind: "string-list",
      overridesSetting: "minting.source_globs",
    },
  ],
};

/**
 * Accounts — SCHEMA.md §23.2. `vendor` selects the usage adapter and is
 * checked against the registered list *by the service* on write; a vendor
 * with no adapter is a setting nobody can act on.
 */
const ACCOUNTS: AdminKind = {
  slug: "accounts",
  title: "Accounts",
  singular: "account",
  blurb:
    "The accounts whose usage is measured. The vendor selects which usage reader applies to an account and is checked against the readers this build ships.",
  listPath: "/api/accounts",
  collection: "accounts",
  idField: "id",
  canCreate: true,
  canArchive: false,
  fields: [
    {
      name: "id",
      label: "Identifier",
      help: "How this account is referred to elsewhere.",
      kind: "text",
      requiredOnCreate: true,
      readOnly: true,
    },
    {
      name: "displayName",
      label: "Display name",
      help: "What it is called on screen.",
      kind: "text",
    },
    {
      name: "vendor",
      label: "Vendor",
      help: "Which usage reader applies. Checked against the readers this build ships — one with no reader is refused rather than stored.",
      kind: "text",
    },
    {
      name: "planType",
      label: "Plan type",
      help: "A subscription has windows that budget bands can have boundaries in; a metered account does not.",
      kind: "enum",
      options: ["subscription", "metered"],
    },
    {
      name: "usage5h",
      label: "Usage (5h)",
      help: "The most recent five-hour reading.",
      kind: "text",
      readOnly: true,
    },
    {
      name: "usageWeekly",
      label: "Usage (weekly)",
      help: "The most recent weekly reading.",
      kind: "text",
      readOnly: true,
    },
    {
      name: "budgetWindows",
      label: "Budget windows",
      help: "This account's own band boundaries. Inheriting uses the global setting. Boundaries that would cross at any moment in the window are refused, naming the moment.",
      kind: "json",
      overridesSetting: "budget.windows",
    },
  ],
};

/**
 * People — edit and archive, no create. A profile is an attribution claim
 * rather than a credential (SCHEMA.md §17.8), and `update_person` (#116)
 * upserts it the same way `update_machine`/`update_account` do — so this
 * kind is edit-and-archive-only here, like `MACHINES`, rather than offering
 * a `POST`-based create through the generic form: creating a profile is the
 * profile picker's job (T13, its own inline form on the empty state), the
 * one place §8a actually asks for a "who's working?" prompt. This is where
 * an *existing* profile is corrected or retired.
 */
const PEOPLE: AdminKind = {
  slug: "people",
  title: "People",
  singular: "person",
  blurb:
    "The profiles work is attributed to. New profiles are created from the picker; this is where an existing one is renamed, recoloured, or archived.",
  listPath: "/api/people",
  collection: "people",
  idField: "id",
  canCreate: false,
  canArchive: true,
  fields: [
    {
      name: "id",
      label: "Identifier",
      help: "How this person is referred to.",
      kind: "text",
      readOnly: true,
    },
    {
      name: "displayName",
      label: "Display name",
      help: "What they are called on screen.",
      kind: "text",
    },
    {
      name: "avatar",
      label: "Avatar",
      help: "A short symbol shown on their tile — an emoji works well. Leave blank to fall back to the first letter of the display name.",
      kind: "text",
    },
    {
      name: "colour",
      label: "Colour",
      help: "The tile's border colour, e.g. #6366f1. Leave blank for the default.",
      kind: "text",
    },
  ],
};

/** Every entity kind the administration surface covers, in navigation order. */
export const ADMIN_KINDS: readonly AdminKind[] = Object.freeze([
  REPOS,
  AREAS,
  MACHINES,
  ACCOUNTS,
  PEOPLE,
]);

export function adminKindBySlug(slug: string): AdminKind | null {
  return ADMIN_KINDS.find((kind) => kind.slug === slug) ?? null;
}

/** The fields an editor may write — everything not marked read-only. */
export function editableFields(kind: AdminKind): readonly AdminField[] {
  return kind.fields.filter((field) => !field.readOnly);
}

/**
 * The fields a create form asks for.
 *
 * Includes the read-only identifier, because "cannot be edited afterwards"
 * and "cannot be set in the first place" are different things, and an
 * identifier is exactly the field that is one but not the other.
 */
export function createFields(kind: AdminKind): readonly AdminField[] {
  return kind.fields.filter((field) => field.requiredOnCreate || !field.readOnly);
}
