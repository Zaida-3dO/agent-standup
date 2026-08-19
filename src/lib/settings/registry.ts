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
import { modelPricesSchema } from "@/lib/telemetry/pricing";
import { savedViewsSchema } from "@/lib/board/saved-views";

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
  "Pricing",
  "Retention",
  "Hook",
  "Telemetry",
  "Interface",
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

  "items.inbox_project": define({
    // A title, not an id. A default that named an id could not ship with a
    // value — no id exists in a fresh database — so it would default to
    // empty and the escape hatch would be off until somebody configured it,
    // which is the opposite of what quick capture needs. A title is
    // find-or-create: the first task that asks for the inbox mints the
    // project, and every later one lands in the same row.
    schema: z.string().trim().min(1).max(200),
    default: "Inbox",
    label: "Inbox project",
    help: 'The project a task lands in when it is created with projectId set to "inbox" instead of a real project id. Created on first use if it does not exist. Changing this points later inbox tasks at a different project; tasks already filed do not move.',
    category: "Items",
    appliesWhen: "next-call",
    sensitive: false,
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

  // The lazy-eviction threshold. Deliberately far above
  // `dead_after_seconds`, and the reason is the honest note in `help`: the
  // sweep's thresholds assume `lastActive` is stamped on every tool call,
  // and in this tree nothing stamps it except the `heartbeat` operation,
  // which agents are told is "usually unnecessary". The full reasoning —
  // including why a tool-call timestamp is consulted as a second,
  // independent signal and why the promised process check does not exist —
  // is in `src/lib/claim-eviction.ts`, which is the one place that policy
  // is written down.
  "liveness.evict_after_seconds": define({
    schema: z.number().int().positive(),
    default: 14_400,
    label: "Evict a claim after",
    help:
      "Seconds a claim holder must go unseen before another session's claim may take the item from it. " +
      "Checked only when a competing claim actually arrives — there is no timer. " +
      "Much larger than the dead threshold on purpose: liveness here is read from the heartbeat " +
      "timestamp and the session's most recent tool call, and the heartbeat is usually not written " +
      "at all (the hook does not stamp it, and the process check the stale threshold refers to does " +
      "not exist), so a session working normally can look quiet for as long as its turn lasts. " +
      "Lowering this risks evicting a live agent mid-run and losing its uncommitted work; raising it " +
      "means a genuinely dead holder keeps its claim for longer. Use takeover to reclaim sooner.",
    category: "Liveness",
    // Read on the next claim that contends, not on a sweep — this is the
    // whole point of the setting, so it must not say "next-sweep".
    appliesWhen: "next-call",
    // Relaxes an enforcement in the dangerous direction when lowered: a
    // small value evicts live holders.
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

  "pricing.model_prices": define({
    schema: modelPricesSchema,
    // Empty, and the emptiness is the design (see `modelPricesSchema`). A
    // table of figures compiled into the build would be current on the day
    // it was written and quietly stale on every day after, and a stale rate
    // produces a confident wrong total rather than a visible gap. Empty
    // prices nothing and says so — every cost reads as "not known" until
    // somebody states what a model costs here.
    default: {},
    label: "Model prices",
    help: "What each model costs per million tokens, keyed by its exact vendor model ID, with a separate rate for input, output, cache writes and cache reads. Run costs are recomputed from these rates and the stored token counts, so correcting a rate here corrects every figure computed from it afterwards. A model with no entry is recorded and left unpriced rather than counted as free.",
    category: "Pricing",
    appliesWhen: "next-call",
    // Neither relaxes an enforcement nor destroys anything. A wrong rate
    // yields a wrong figure, and the figure is recomputable from counts
    // this setting cannot touch — which is the whole reason the counts are
    // stored beside the cost.
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
    default: false,
    label: "Require a registered, compatible session to claim",
    help: "When on, a session that has not registered a hook protocol version — or whose version is below the oldest this build supports — may not take ownership of an item. It defaults to off: the protocol version tells the server what signals to expect from a session, and a session that reports none is one whose tool calls simply go unobserved, which is not a reason to stop it working. Turn it on for an installation that wants ownership restricted to sessions whose rules it can enforce.",
    category: "Hook",
    appliesWhen: "next-call",
    // Tightens an enforcement rather than relaxing one: on means a session
    // that cannot register cannot hold work.
    sensitive: true,
    irreversible: false,
    formerEnv: [],
  }),

  // The four `shape.*` keys below are the thresholds a session-shape reading
  // is taken against (`@/lib/telemetry/shape`). They are settings rather than
  // constants because what counts as "wide" or "circling" is a property of
  // the repository being worked in, not of this build: a spread of 30 files
  // is a routine afternoon in a large application and a red flag in a small
  // library. None of them is `sensitive` — a shape signal is advice, and
  // every consumer of it (a digest, a nudge) is advisory by construction, so
  // a threshold set uselessly high silences a hint rather than disarming an
  // enforcement.

  "shape.minimum_sample": define({
    schema: z.number().int().positive(),
    default: 20,
    label: "Shape minimum sample",
    help: "How many tool calls a session must have made before its shape is reported as anything other than unknown. Below this the reading is withheld rather than guessed, because a judgement drawn from a handful of calls is noise presented as a finding.",
    category: "Telemetry",
    appliesWhen: "next-call",
    sensitive: false,
    irreversible: false,
    formerEnv: [],
  }),

  "shape.repeat_threshold": define({
    schema: z.number().int().positive(),
    default: 3,
    label: "Repeat-command threshold",
    help: "How many times a session must return to a shell command it already ran — with another command in between — before that reads as going in circles. A command run and immediately re-run is a retry loop and counts once however long it runs, so this counts returns rather than attempts, and reading or editing between two runs does not break the run. Only Bash calls are compared, because every other tool reports a file path rather than a command.",
    category: "Telemetry",
    appliesWhen: "next-call",
    sensitive: false,
    irreversible: false,
    formerEnv: [],
  }),

  "shape.spread_threshold": define({
    schema: z.number().int().positive(),
    default: 25,
    label: "File-spread threshold",
    help: "How many distinct files a session must touch before its spread reads as wide. Distinct files, not calls: reading one file thirty times is not a spread of thirty.",
    category: "Telemetry",
    appliesWhen: "next-call",
    sensitive: false,
    irreversible: false,
    formerEnv: [],
  }),

  // Where `/` sends a reader. A setting rather than a constant because the
  // right answer is a claim about how this installation is used and not a
  // property of the build: a digest is the better entry for someone
  // triaging overnight work every morning, and the project list is the
  // better one for someone who steers weekly and rarely reads a feed. Both
  // readings are defensible, so this is settled by use rather than by
  // argument — the value is one preference change, not a rewrite.
  //
  // Not `sensitive`: it relaxes no enforcement and gates nothing. Every
  // destination it can name is reachable from the sidebar on every screen,
  // so the worst a wrong value does is cost one click.
  "ui.default_landing": define({
    // The route ids, not paths. A path stored here would be free text that
    // could name a route that does not exist — and the failure would be a
    // reader landing on a 404 on the one screen they cannot navigate away
    // from before it renders. An id is checked against the map at build
    // time (`tests/nav-landing.test.ts` asserts every option resolves).
    schema: z.enum(["standup", "projects", "board", "needs-you"]),
    default: "standup",
    label: "Default landing page",
    help: "Which screen the root of the app shows. Standup is an overnight digest, Projects is the project list, Board is the kanban, and Needs you is the narrow list of items blocked on you. Every one of them is also reachable from the sidebar, so this only decides what you see first.",
    category: "Interface",
    appliesWhen: "next-call",
    sensitive: false,
    irreversible: false,
    formerEnv: [],
  }),

  // The named board filters a reader has pinned (MILESTONES.md #75). A
  // setting rather than browser storage, deliberately: a view is a way of
  // looking at *this installation's* work — "my P0s", "everything blocked in
  // the web area" — and it is worth the same on the laptop it was made on
  // and the desktop it wasn't. Browser storage would make it a property of a
  // machine, which is the wrong noun.
  //
  // Not `sensitive`: it relaxes no enforcement and gates nothing. The worst
  // a malformed value does is drop a chip from the sidebar, because a stored
  // query string this build cannot parse degrades to the filters it does
  // recognise rather than failing (see `@/lib/board/saved-views`).
  "ui.saved_views": define({
    schema: savedViewsSchema,
    default: [],
    label: "Saved board views",
    help: "Named filter and sort combinations pinned beside the board and in the sidebar. Each one stores the board's query string, so applying a view is the same as opening its link — and a view saved before a filter existed keeps working, ignoring the parts it does not know.",
    category: "Interface",
    appliesWhen: "next-call",
    sensitive: false,
    irreversible: false,
    formerEnv: [],
  }),

  "shape.read_share_threshold": define({
    schema: z.number().min(0).max(1),
    default: 0.9,
    label: "Read-share threshold",
    help: "The share of a session's classifiable calls that must be reads before it reads as mostly-looking, between 0 and 1. Taken over calls that could be classified as a read or a write, so shell commands — which may be either — neither raise nor lower it.",
    category: "Telemetry",
    appliesWhen: "next-call",
    sensitive: false,
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
