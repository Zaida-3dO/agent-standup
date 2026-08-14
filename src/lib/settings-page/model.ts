// The `/settings` page model — MILESTONES.md #86, derived entirely from the
// registry and the `GET /settings` answer.
//
// Everything the page decides about *structure* lives here as pure functions
// over plain data: which categories exist, which fields sit in each, which
// badge a field carries, and whether a write is allowed to proceed. The
// components under `src/components/settings/` are the thin presentational
// layer over these, and the client container is thin wiring — the same split
// `src/lib/board/view.ts` and `src/components/board/` already follow, and
// what keeps `npm run check:db-imports` passing (nothing here imports the
// service layer or a database client; it consumes the HTTP adapter's answer).
import {
  SETTINGS_REGISTRY,
  SETTING_CATEGORIES,
  SETTING_KEYS,
  isSettingKey,
  type SettingCategory,
  type SettingKey,
} from "@/lib/settings";
import { widgetFor, type Widget } from "./widget";

/** One setting as `GET /api/settings` renders it — SCHEMA.md §19. */
export interface RenderedSetting {
  readonly key: string;
  readonly value: unknown;
  readonly source: "default" | "override" | "invalid-override";
  readonly label: string;
  readonly help: string;
  readonly category: string;
  readonly appliesWhen: string;
  readonly sensitive: boolean;
  readonly irreversible: boolean;
  readonly invalidOverride?: { storedValue: unknown; errors: readonly string[] };
}

export interface UnrecognisedSetting {
  readonly key: string;
  readonly storedValue: unknown;
}

export interface BuildConstant {
  readonly name: string;
  readonly value: string;
  readonly meaning: string;
}

export interface BootstrapVariable {
  readonly name: string;
  readonly set: boolean;
  readonly meaning: string;
}

export interface SettingsResponse {
  readonly settings: readonly RenderedSetting[];
  readonly unrecognised: readonly UnrecognisedSetting[];
  readonly constants: readonly BuildConstant[];
  readonly bootstrap: readonly BootstrapVariable[];
  readonly revision: string;
}

/**
 * The badge a field carries, saying where its value came from — MILESTONES.md
 * #86's "value-source badges".
 *
 * A separate type from `RenderedSetting["source"]` so the wording lives in
 * one place and the three cases are exhaustive by construction.
 */
export type SourceBadge = "Default" | "Overridden" | "Invalid override";

const SOURCE_BADGES: Readonly<Record<RenderedSetting["source"], SourceBadge>> = {
  default: "Default",
  override: "Overridden",
  "invalid-override": "Invalid override",
};

export function sourceBadge(setting: RenderedSetting): SourceBadge {
  // An unknown source falls back to the most cautious reading rather than
  // rendering an empty badge: a field whose provenance cannot be established
  // should not look like one sitting safely at its default.
  return SOURCE_BADGES[setting.source] ?? "Invalid override";
}

/**
 * Whether reset-to-default does anything for this field.
 *
 * `false` at the default — there is no override row to clear, so the button
 * is offered only where it has an effect. **`invalid-override` counts as
 * having something to reset**, and that is the case that matters most: a
 * stored value the schema now refuses is exactly the thing someone opens
 * this page to get rid of, and it is served *displaying* its default
 * (SCHEMA.md §17.3), so a rule keyed on the displayed value alone would hide
 * the one button that fixes it.
 */
export function canReset(setting: RenderedSetting): boolean {
  return setting.source !== "default";
}

/** One field, fully derived: what to draw, what to say, and what it takes to write it. */
export interface SettingsField {
  readonly key: string;
  readonly label: string;
  readonly help: string;
  readonly appliesWhen: string;
  readonly value: unknown;
  readonly badge: SourceBadge;
  readonly canReset: boolean;
  readonly sensitive: boolean;
  readonly irreversible: boolean;
  /**
   * `null` for a key this build does not declare — which cannot happen for a
   * field built from `SETTING_KEYS`, but is representable rather than thrown
   * so a malformed server answer degrades to a read-only row instead of
   * blanking the page.
   */
  readonly widget: Widget | null;
  readonly invalidOverride?: { storedValue: unknown; errors: readonly string[] };
}

/**
 * A category and its fields. Only categories with at least one field appear —
 * `SETTING_CATEGORIES` is a closed list and a build may declare no key in one
 * of them, and an empty heading reads as a bug rather than as an absence.
 */
export interface SettingsSection {
  readonly category: SettingCategory;
  readonly fields: readonly SettingsField[];
}

function fieldFor(setting: RenderedSetting): SettingsField {
  const widget = isSettingKey(setting.key)
    ? widgetFor(SETTINGS_REGISTRY[setting.key].schema)
    : null;
  return {
    key: setting.key,
    label: setting.label,
    help: setting.help,
    appliesWhen: setting.appliesWhen,
    value: setting.value,
    badge: sourceBadge(setting),
    canReset: canReset(setting),
    sensitive: setting.sensitive,
    irreversible: setting.irreversible,
    widget,
    ...(setting.invalidOverride ? { invalidOverride: setting.invalidOverride } : {}),
  };
}

/**
 * Whether a field belongs in the `sensitive` section rather than its own
 * category — SCHEMA.md §17.8: a `sensitive` setting is "rendered in its own
 * section of `/settings` behind a 'these change what the system enforces'
 * heading", and `irreversible` is "everything `sensitive` does, plus…".
 *
 * So the test is `sensitive || irreversible`, exactly as the command line's
 * confirmation gate reads it (`src/lib/cli/config-command.ts`) — one rule,
 * read off the registry in both adapters, never a second list of dangerous
 * keys that could drift from the flags.
 */
export function isGuarded(field: {
  readonly sensitive: boolean;
  readonly irreversible: boolean;
}): boolean {
  return field.sensitive || field.irreversible;
}

/**
 * The whole page, derived.
 *
 * **Built from `SETTING_KEYS`, not from the response's array**, so a key the
 * server failed to include still renders — at its registry default, with its
 * help — rather than vanishing. A settings page that silently omits a field
 * is worse than one that shows a stale value: nobody looks for something
 * they cannot see is missing.
 */
export function settingsPageModel(response: SettingsResponse): {
  readonly sections: readonly SettingsSection[];
  readonly guarded: readonly SettingsField[];
  readonly unrecognised: readonly UnrecognisedSetting[];
  readonly constants: readonly BuildConstant[];
  readonly bootstrap: readonly BootstrapVariable[];
  readonly revision: string;
} {
  const byKey = new Map(response.settings.map((setting) => [setting.key, setting]));

  const fields = SETTING_KEYS.map((key) => {
    const served = byKey.get(key);
    return fieldFor(served ?? defaultRendering(key));
  });

  // A field is in exactly one place: the guarded section, or its category.
  // Both would mean two inputs writing one key, and the second one visited
  // would silently overwrite the first.
  const guarded = fields.filter((field) => isGuarded(field));
  const ordinary = fields.filter((field) => !isGuarded(field));

  const sections: SettingsSection[] = [];
  for (const category of SETTING_CATEGORIES) {
    const inCategory = ordinary.filter((field) => categoryOf(field.key) === category);
    if (inCategory.length > 0) sections.push({ category, fields: inCategory });
  }

  return {
    sections,
    guarded,
    unrecognised: response.unrecognised ?? [],
    constants: response.constants ?? [],
    bootstrap: response.bootstrap ?? [],
    revision: response.revision,
  };
}

/**
 * A field's category, taken from the registry rather than from the server's
 * answer.
 *
 * The registry is the source of the category (SCHEMA.md §17.2) and it is a
 * closed list; trusting a free string from the response would let a
 * mistyped category open a section that matches no heading and drop the
 * field out of the page.
 */
function categoryOf(key: string): SettingCategory | null {
  return isSettingKey(key) ? SETTINGS_REGISTRY[key].category : null;
}

/** What a declared key looks like when the server's answer did not carry it. */
function defaultRendering(key: SettingKey): RenderedSetting {
  const definition = SETTINGS_REGISTRY[key];
  return {
    key,
    value: definition.default,
    source: "default",
    label: definition.label,
    help: definition.help,
    category: definition.category,
    appliesWhen: definition.appliesWhen,
    sensitive: definition.sensitive,
    irreversible: definition.irreversible,
  };
}
