// The retired-environment-variable startup check (docs/plans/MILESTONES.md
// #90). See docs/plans/SCHEMA.md §17.3: when a key is renamed — here, moved
// from an environment variable into a setting — "the retired entry stays in
// the registry ... naming its replacement". `formerEnv` on each registry
// entry (registry.ts) *is* that naming; this file only reads it.
//
// Written as a function over an arbitrary set of declarations plus an
// arbitrary environment, for the same reason invariants.ts is: a check
// written as "for each key in SETTINGS_REGISTRY, look at process.env" can
// only ever pass on whatever this build happens to declare and whatever
// happens to be set when it runs. Handed a deliberately-shaped registry and
// a deliberately-shaped environment, the same function can be proven to
// both fire and stay silent.
import type { Declarations } from "./invariants";
import { SETTINGS_REGISTRY } from "./registry";

/** One retired environment variable found still set. */
export interface FormerEnvHit {
  /** The retired variable name, e.g. "POLL_INTERVAL_SECONDS". */
  envVar: string;
  /** The setting that replaced it. */
  key: string;
  /** The setting's own label, so a message can name it in prose. */
  label: string;
}

/**
 * Every `formerEnv` name declared anywhere in `declarations` that is also
 * set (to any value, including `""` — the operator wrote *something*,
 * which is the condition this check exists to catch) in `env`.
 *
 * Reads `formerEnv` off each declaration — nothing here hand-lists a
 * retired name. A key added to the registry with a `formerEnv` entry is
 * picked up the next time this runs, with no second edit anywhere.
 */
export function findFormerEnvHits(
  declarations: Declarations,
  env: Record<string, string | undefined>,
): FormerEnvHit[] {
  const hits: FormerEnvHit[] = [];
  for (const [key, definition] of Object.entries(declarations)) {
    for (const envVar of definition.formerEnv) {
      if (env[envVar] !== undefined) {
        hits.push({ envVar, key, label: definition.label });
      }
    }
  }
  return hits;
}

function formatHit(hit: FormerEnvHit): string {
  return `${hit.envVar} (now the "${hit.label}" setting, ${hit.key})`;
}

export class RetiredEnvVarError extends Error {
  readonly hits: FormerEnvHit[];

  constructor(hits: FormerEnvHit[]) {
    super(
      `The following environment variable(s) are ignored: ` +
        `${hits.map(formatHit).join(", ")}. Configure the named setting ` +
        `instead (via /settings or \`standup config set\`) and remove the ` +
        `variable from the environment.`,
    );
    this.name = "RetiredEnvVarError";
    this.hits = hits;
  }
}

/**
 * Runs the check once at startup. Behaviour genuinely differs by mode —
 * this is not one code path with a cosmetic label swapped on top:
 *
 * - Not `production` (development, test, and anything else): **throws**
 *   `RetiredEnvVarError`. A retired variable being set locally is a mistake
 *   worth stopping on immediately, before it is mistaken for working
 *   configuration.
 * - `production`: **never throws** — logs each hit at `error` level via
 *   `log` and returns the hits. A live deployment must not be taken down by
 *   an operator's stale environment; the point is to be loud, not to add a
 *   new way to be down.
 *
 * `env` and `log` are both injectable so the two branches can be exercised
 * without mutating `process.env` or capturing real console output.
 */
export function checkFormerEnv({
  declarations = SETTINGS_REGISTRY as unknown as Declarations,
  env = process.env,
  nodeEnv = process.env.NODE_ENV,
  log = console,
}: {
  declarations?: Declarations;
  env?: Record<string, string | undefined>;
  nodeEnv?: string | undefined;
  log?: Pick<Console, "error">;
} = {}): FormerEnvHit[] {
  const hits = findFormerEnvHits(declarations, env);
  if (hits.length === 0) {
    return hits;
  }

  if (nodeEnv === "production") {
    for (const hit of hits) {
      log.error(
        `RETIRED ENVIRONMENT VARIABLE STILL SET: ${formatHit(hit)}. It is being ` +
          `ignored — the running deployment is using the setting's current ` +
          `value, not this variable. Configure it as a setting instead.`,
      );
    }
    return hits;
  }

  throw new RetiredEnvVarError(hits);
}
