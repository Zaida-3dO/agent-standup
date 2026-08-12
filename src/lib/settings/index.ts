// The settings core: what the service layer reads. See SCHEMA.md §17.
export {
  SETTINGS_REGISTRY,
  SETTING_KEYS,
  SETTING_CATEGORIES,
  APPLIES_WHEN,
  RETENTION_FLOOR_DAYS,
  getDefinition,
  isSettingKey,
  type AppliesWhen,
  type SettingCategory,
  type SettingDefinition,
  type SettingKey,
  type SettingValue,
  type SettingsRegistry,
} from "./registry";

export {
  OVERRIDE_COLUMNS,
  formatIssues,
  isOverrideColumn,
  resolveOverride,
  validateOverrideColumn,
  validateSetting,
  type OverrideColumn,
  type OverriddenKey,
  type ValidationResult,
} from "./validate";

export {
  defaultSnapshot,
  deepFreeze,
  resolveSettings,
  type RejectedOverride,
  type SettingsSnapshot,
  type SettingsValues,
  type StoredOverride,
  type UnrecognisedOverride,
} from "./resolve";

export {
  DEFAULT_REVALIDATE_AFTER_MS,
  SettingsCache,
  type SettingsCacheOptions,
  type SettingsSource,
} from "./cache";

export {
  KEY_PREFIXES,
  MIN_HELP_CHARACTERS,
  checkDefaultsValid,
  checkHelpPresent,
  checkNoCredentialShapedKey,
  checkNoUnmappedPrefix,
  checkRegistryInvariants,
  type Declarations,
  type Violation,
} from "./invariants";

export {
  boundaryAt,
  boundarySchema,
  budgetWindowsSchema,
  findCrossings,
  type Boundary,
  type BudgetWindow,
  type BudgetWindows,
  type CrossingProblem,
} from "./budget-windows";

export {
  RetiredEnvVarError,
  checkFormerEnv,
  findFormerEnvHits,
  type FormerEnvHit,
} from "./former-env-check";

export {
  effectiveBudgetWindows,
  effectiveSourceGlobs,
  readMachineSourceGlobs,
  type MachineSourceGlobs,
  type RawQuery,
} from "./overrides";
