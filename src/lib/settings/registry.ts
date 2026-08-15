// The settings registry: every setting this build reads, declared in code.
//
// The database stores overrides only, so a fresh database boots fully
// working with nothing in it. See docs/plans/SCHEMA.md §17.2 for the three
// properties this shape exists to give, and §17.8 for what `sensitive` and
// `irreversible` mean.
//
// Adding a key here is the whole act of adding a setting. There is no
// second place to register it, and the editing surfaces are generated from
// these declarations rather than maintained alongside them.
import { z } from "zod";
import { budgetWindowsSchema } from "./budget-windows";
import { capabilityDocSchema } from "./capability-doc";

/**
 * The categories a setting can be filed under. Closed rather than free
 * text, because `/settings` groups by it and a typo would silently invent
 * an empty section.
 */
export const SETTING_CATEGORIES = [
  "Items",
  "Agents",
  "Liveness",
  "Dispatch",
  "Crew",
  "Budget",
  "Model picker",
  "Capabilities",
  "Minting",
  "Retention",
  "Hook",
] as const;

export type SettingCategory = (typeof SETTING_CATEGORIES)[number];

/**
 * When a change to a setting takes effect. Declared per key because the
 * honest answer differs — a guard reads its setting on the next call, a
 * machine reads its poll interval on its next poll — and a surface that
 * says "saved" without saying "and it applies when" invites the bug report
 * that it did not work.
 */
export const APPLIES_WHEN = [
  /** Read at the start of the next service call. */
  "next-call",
  /** Read the next time the machine that uses it polls. */
  "next-poll",
  /** Read the next time the periodic sweep runs. */
  "next-sweep",
  /** Read once per process at start; a running process keeps what it read. */
  "restart",
] as const;

export type AppliesWhen = (typeof APPLIES_WHEN)[number];

/**
 * One registry entry. All nine fields are required — including the ones
 * that are usually `false`, because "nobody thought about it" and
 * "considered, and it is not sensitive" are different states and only one
 * of them is safe.
 */
export interface SettingDefinition<T = unknown> {
  /** Validates a write and types the read. One schema, not two. */
  schema: z.ZodType<T>;
  /** Used when no override row exists. Must itself satisfy `schema`. */
  default: T;
  /** Short human name, rendered as the field's label. */
  label: string;
  /** What it does and what changing it costs. Rendered beside the field. */
  help: string;
  category: SettingCategory;
  appliesWhen: AppliesWhen;
  /**
   * This setting relaxes an enforcement — rendered apart, confirmed by
   * typing the key, audited as its own event kind (§17.8).
   */
  sensitive: boolean;
  /**
   * This setting can destroy data that cannot be recreated. Everything
   * `sensitive` does, plus a floor in its own schema and a refusal in the
   * consuming job.
   */
  irreversible: boolean;
  /**
   * Environment-variable names that carried this value before it became a
   * setting. Empty for a key that never had one. A startup check derived
   * from these names reports a retired variable that is still set, so an
   * installation is told its environment is being ignored rather than
   * discovering it from behaviour.
   */
  formerEnv: readonly string[];
}

/**
 * Declares one entry, inferring `T` from the schema so `default` is checked
 * against it at compile time as well as by the registry's own test.
 */
function define<T>(definition: SettingDefinition<T>): SettingDefinition<T> {
  return definition;
}

/**
 * The floor under retention (§17.8). `irreversible` buys a bound in the
 * schema itself, so the smallest value anyone can store still leaves a
 * fortnight of history to notice the mistake in.
 */
export const RETENTION_FLOOR_DAYS = 14;

export const SETTINGS_REGISTRY = {
  "items.max_depth": define({
    schema: z.number().int().min(1).max(20),
    default: 6,
    label: "Maximum item depth",
    help: "How deeply items may nest. A runaway guard on the item tree: a create that would exceed this depth is refused rather than allowed to grow without bound.",
    category: "Items",
    appliesWhen: "next-call",
    sensitive: false,
    irreversible: false,
    formerEnv: [],
  }),

  "items.default_merge_authority": define({
    schema: z.enum(["pre-approved", "needs-approval", "agent-judgement"]),
    default: "needs-approval",
    label: "Default merge authority",
    help: "What merge authority a new item gets when nothing sets one. Setting this to pre-approved means every item created afterwards skips the human approval gate.",
    category: "Items",
    appliesWhen: "next-call",
    // Relaxes an enforcement: every subsequently created item skips the
    // approval gate.
    sensitive: true,
    irreversible: false,
    formerEnv: [],
  }),

  "agents.subagent_delegation": define({
    schema: z.enum(["never", "allowed", "required"]),
    default: "allowed",
    label: "Subagent delegation",
    help: "What an orchestrator may do itself. Never blocks spawning; allowed nudges towards delegating; required blocks the orchestrator doing the work. Only applies where an orchestrator role exists, so a single-agent installation is unaffected.",
    category: "Agents",
    appliesWhen: "next-call",
    sensitive: false,
    irreversible: false,
    formerEnv: [],
  }),

  "liveness.stale_after_seconds": define({
    schema: z.number().int().positive(),
    default: 900,
    label: "Stale after",
    help: "Seconds of quiet before a running session is treated as stalled. A process check comes first; this is the fallback for when that cannot answer. A large value means dead work is not noticed.",
    category: "Liveness",
    appliesWhen: "next-sweep",
    // Relaxes an enforcement: set large enough, nothing is ever reclaimed.
    sensitive: true,
    irreversible: false,
    formerEnv: [],
  }),

  "liveness.dead_after_seconds": define({
    schema: z.number().int().positive(),
    default: 1800,
    label: "Dead after",
    help: "Seconds of quiet before a stalled session is treated as dead and its claim is released. A large value means a claim held by a dead session is never handed back.",
    category: "Liveness",
    appliesWhen: "next-sweep",
    sensitive: true,
    irreversible: false,
    formerEnv: [],
  }),

  "dispatch.failed_after_seconds": define({
    schema: z.number().int().positive(),
    default: 180,
    label: "Dispatch failed after",
    help: "Seconds with no session registering against a dispatch before the launch is treated as failed.",
    category: "Dispatch",
    appliesWhen: "next-sweep",
    sensitive: false,
    irreversible: false,
    formerEnv: [],
  }),

  "dispatch.resume_attempts_before_blocked": define({
    schema: z.number().int().min(1),
    default: 3,
    label: "Resume attempts before escalating",
    help: "How many resume attempts with no durable progress are made before the item is escalated to a person. A large value means work that cannot progress never reaches anybody.",
    category: "Dispatch",
    appliesWhen: "next-sweep",
    sensitive: true,
    irreversible: false,
    formerEnv: [],
  }),

  "poll.interval_seconds": define({
    schema: z.number().int().positive(),
    default: 300,
    label: "Poll interval",
    help: "How often each machine asks for work. Takes effect on that machine's next poll, so a change is visible within one interval rather than immediately.",
    category: "Dispatch",
    appliesWhen: "next-poll",
    sensitive: false,
    irreversible: false,
    formerEnv: ["POLL_INTERVAL_SECONDS"],
  }),

  "crew.wait_timeout_seconds": define({
    schema: z.number().int().positive(),
    default: 240,
    label: "Wait-for-crew timeout",
    help: "How long a wait-for-crew call is held open before returning empty. Sized to stay inside the shortest prompt-cache lifetime a session may be given, which is not always signalled — a wait that outlives the cache costs more than the wait saves.",
    category: "Crew",
    appliesWhen: "next-call",
    sensitive: false,
    irreversible: false,
    formerEnv: ["WAIT_FOR_CREW_TIMEOUT"],
  }),

  "crew.wait_poll_interval_seconds": define({
    schema: z.number().int().positive(),
    default: 5,
    label: "Wait-for-crew poll interval",
    help: "How often the polling implementation of wait-for-crew re-reads the ledger. Used only where no long-poll is available; both implementations return identically.",
    category: "Crew",
    appliesWhen: "next-call",
    sensitive: false,
    irreversible: false,
    formerEnv: [],
  }),

  "budget.enabled": define({
    schema: z.boolean(),
    default: false,
    label: "Budget bands enabled",
    help: "The master switch for budget bands. Turning it off stops every band applying, so nothing is held back when a window is nearly spent.",
    category: "Budget",
    appliesWhen: "next-call",
    // Relaxes an enforcement: one write and the bands stop applying.
    sensitive: true,
    irreversible: false,
    formerEnv: [],
  }),

  "budget.windows": define({
    schema: budgetWindowsSchema,
    default: {},
    label: "Budget windows",
    help: "Per window: whether it is enabled, how long it is, and where each of the last three bands begins. A boundary is a constant, a slope against elapsed time, or an ordered schedule. Boundaries that would cross at any moment in the window are refused, naming the moment.",
    category: "Budget",
    appliesWhen: "next-call",
    sensitive: false,
    irreversible: false,
    formerEnv: ["BUDGET_WINDOWS"],
  }),

  "model_picker.enabled": define({
    schema: z.boolean(),
    default: false,
    label: "Model picker enabled",
    help: "Whether the model picker chooses a tier per piece of work. The mechanism ships before the data does; enable it once there is enough completed work to learn from.",
    category: "Model picker",
    appliesWhen: "next-call",
    sensitive: false,
    irreversible: false,
    formerEnv: [],
  }),

  "model_picker.explore_rate": define({
    schema: z.number().min(0).max(1),
    default: 0,
    label: "Explore rate",
    help: "How often, as a fraction, to deliberately try one tier down on low-risk work. At zero the picker never learns anything it does not already know.",
    category: "Model picker",
    appliesWhen: "next-call",
    sensitive: false,
    irreversible: false,
    formerEnv: [],
  }),

  "notify.doc": define({
    schema: capabilityDocSchema,
    default: null,
    label: "Notification document",
    help: 'Path or URL of the document explaining how to reach people here. Null means notifications are off — including the escalation that puts a blocked item on somebody\'s list. Wanted whenever any notification rule exists. Must be a well-formed absolute path or URL, with no ".." traversal (SCHEMA.md §17.5).',
    category: "Capabilities",
    appliesWhen: "next-call",
    // Relaxes an enforcement: null silences every escalation path.
    sensitive: true,
    irreversible: false,
    formerEnv: ["NOTIFY_DOC"],
  }),

  "visual_review.doc": define({
    schema: capabilityDocSchema,
    default: null,
    label: "Visual review document",
    help: 'Path or URL of the document explaining how a visual review is performed here. Null means visual review is unavailable, and an item that needs one has no way through its gate. Must be a well-formed absolute path or URL, with no ".." traversal (SCHEMA.md §17.5).',
    category: "Capabilities",
    appliesWhen: "next-call",
    sensitive: false,
    irreversible: false,
    formerEnv: ["VISUAL_REVIEW_DOC"],
  }),

  "minting.backlog_low_threshold": define({
    schema: z.number().int().min(0),
    default: 3,
    label: "Backlog low threshold",
    help: "When the on-deck count falls below this, a mint request is triggered so there is work ready before the queue empties.",
    category: "Minting",
    appliesWhen: "next-sweep",
    sensitive: false,
    irreversible: false,
    formerEnv: [],
  }),

  "minting.source_globs": define({
    schema: z.array(z.string().min(1)),
    default: [],
    label: "Minting source globs",
    help: "Where minting looks for work. This is the default; a machine carrying its own source globs overrides it, because filesystem layouts differ per machine.",
    category: "Minting",
    appliesWhen: "next-poll",
    sensitive: false,
    irreversible: false,
    formerEnv: [],
  }),

  "retention.tool_calls_days": define({
    schema: z.number().int().min(RETENTION_FLOOR_DAYS).nullable(),
    default: null,
    label: "Tool-call retention",
    help: `How many days of tool-call rows to keep. Null keeps them forever. This deletes measured history that cannot be recreated, so the smallest value accepted is ${RETENTION_FLOOR_DAYS} days and the job that does the deleting refuses a pass that would remove more than a bounded fraction of the table.`,
    category: "Retention",
    appliesWhen: "next-sweep",
    sensitive: true,
    // Destroys measured history: facet and cost data is not derivable.
    irreversible: true,
    formerEnv: [],
  }),

  "hook.require_registration_to_claim": define({
    schema: z.boolean(),
    default: true,
    label: "Require a registered, compatible session to claim",
    help: "When on, a session that has not registered a hook protocol version — or whose version is below the oldest this build supports — may not take ownership of an item. It may still read, orient and update itself. Turning this off lets an unguarded session hold work, which is the one thing this rule exists to prevent; it exists so that an installation whose sessions cannot yet register is degraded rather than stopped.",
    category: "Hook",
    appliesWhen: "next-call",
    // Relaxes an enforcement: off means work can be held under rules the
    // holder cannot enforce.
    sensitive: true,
    irreversible: false,
    formerEnv: [],
  }),
} satisfies Record<string, SettingDefinition>;

export type SettingsRegistry = typeof SETTINGS_REGISTRY;

export type SettingKey = keyof SettingsRegistry;

/** The value type of one key, taken from that key's own schema. */
export type SettingValue<K extends SettingKey> =
  SettingsRegistry[K] extends SettingDefinition<infer T> ? T : never;

export const SETTING_KEYS = Object.keys(SETTINGS_REGISTRY) as SettingKey[];

export function isSettingKey(key: string): key is SettingKey {
  return Object.prototype.hasOwnProperty.call(SETTINGS_REGISTRY, key);
}

export function getDefinition<K extends SettingKey>(key: K): SettingsRegistry[K] {
  return SETTINGS_REGISTRY[key];
}
