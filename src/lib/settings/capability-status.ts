// What an installation can actually be relied on to do — the read side of
// `capability_checks` (SCHEMA.md §17.5).
//
// **Why this module exists.** §17.5's table promises three things about a
// capability document: refuse a malformed one on write, "accept, mark
// unverified" where the server cannot see the filesystem, and "show it as
// unverified on `/settings`". The first was built. The sweep
// (`sweepCapabilityDocuments`) computes the second and writes it to
// `capability_checks` on every pass. The third had no implementation at
// all: nothing anywhere read that table, so the sweep's finding was
// detected, stored, and invisible.
//
// That is the failure this module closes, and it is worth naming precisely
// because it is not "a missing feature". A capability setting does two jobs
// at once — it is a **switch** ("is this capability on?") and an **address**
// ("where is the procedure?") — and the core only ever evaluates the switch:
// `notificationsEnabled()` is `notifyDoc !== null`, and nothing reads the
// document. So a value pointing at nothing is indistinguishable from a
// working one at the moment it matters, and a gate opens on a pointer to
// nothing.
//
// ── What this module does and does not claim ────────────────────────────
//
// It reports **the sweep's last finding**, with the path that finding was
// about and when it was made. It deliberately does not re-check anything:
// re-checking here would make a read operation do filesystem I/O, and would
// still be answering only for the machine that happens to serve the request
// — which is the very thing that makes the stored value untrustworthy.
//
// The distinction that matters to a reader is three-way, not two-way:
//
//   - **`off`** — the setting is null. The capability is deliberately not
//     configured (§17.2), and any gate depending on it will fail closed.
//     This is an honest, intended state.
//   - **`verified`** — a value is set and the last sweep found the document
//     where it pointed.
//   - **`unverified`** — a value is set and the server *could not tell*: a
//     URL it never fetches, a path on a filesystem it cannot see, or no
//     sweep has run yet. **Nothing about the value itself distinguishes
//     this from `verified`**, which is the whole point of surfacing it: the
//     server has no basis for the stronger claim, so it makes the weaker one.
//   - **`missing`** — a value is set and the last sweep looked and did not
//     find it. Configured, and known to be wrong.
//
// `missing` and `unverified` are kept apart rather than merged into "not
// verified". They call for opposite responses: `missing` is a broken
// setting to fix, `unverified` is a limit on what this server can know and
// may be entirely correct — a path that resolves on the agent's machine and
// not the server's is the *expected* case for a capability the server never
// performs itself.
import type { TransactionHandle } from "@/lib/service/context";

/** The capability keys §17.5 declares. Mirrors `CAPABILITY_KEYS` in `@/lib/liveness`. */
export const CAPABILITY_SETTING_KEYS = ["notify.doc", "visual_review.doc"] as const;

export type CapabilitySettingKey = (typeof CAPABILITY_SETTING_KEYS)[number];

/**
 * How much this installation knows about one capability.
 *
 * `off` is not a failure and `unverified` is not a pass — see the module
 * header for why these four are kept distinct.
 */
export type CapabilityStatus = "off" | "verified" | "unverified" | "missing";

export interface RenderedCapability {
  readonly key: CapabilitySettingKey;
  readonly status: CapabilityStatus;
  /**
   * The value the setting holds now, or null when it is off.
   *
   * Read from settings, not from the check row: the check row records the
   * path that was *checked*, which is deliberately not updated when the
   * setting is edited. Carrying both is what lets a reader see that a sweep
   * has not yet caught up with an edit.
   */
  readonly value: string | null;
  /** The path the last sweep actually checked, or null when no sweep has recorded one. */
  readonly checkedPath: string | null;
  /** When that check was made. Null when no sweep has recorded this key. */
  readonly lastCheckedAt: string | null;
  /**
   * True when a sweep has recorded a check whose path is not the value the
   * setting holds now — so the status below is about a path this
   * installation does not use, and the next sweep will change it.
   *
   * Surfaced rather than resolved silently: a reader seeing `verified`
   * against a path the installation does not use would otherwise draw
   * exactly the wrong conclusion.
   */
  readonly staleCheck: boolean;
  /** One line a person or an agent can act on, without needing §17.5 open. */
  readonly detail: string;
}

interface CapabilityCheckRow {
  readonly key: string;
  readonly path: string;
  readonly result: "exists" | "missing" | "unverified";
  readonly lastCheckedAt: Date;
}

/**
 * Reads the sweep's recorded findings.
 *
 * Raw SQL for the same reason `sweepCapabilityDocuments` writes with it —
 * this table is reached by key, has no relations worth traversing, and the
 * write side is already raw, so the two stay symmetrical and readable
 * beside each other.
 */
export async function readCapabilityChecks(
  db: TransactionHandle,
): Promise<Map<string, CapabilityCheckRow>> {
  const rows = await db.$queryRawUnsafe<CapabilityCheckRow[]>(
    `SELECT "key", "path", "result", "lastCheckedAt" FROM "capability_checks"`,
  );
  return new Map(rows.map((row) => [row.key, row]));
}

/**
 * Renders one capability from its configured value and the sweep's last
 * finding about it.
 *
 * Pure — takes the value and the row, returns the reading — so every branch
 * is testable without a database or a filesystem.
 */
export function renderCapability(
  key: CapabilitySettingKey,
  value: string | null,
  check: CapabilityCheckRow | undefined,
): RenderedCapability {
  if (value === null) {
    return {
      key,
      status: "off",
      value: null,
      checkedPath: null,
      lastCheckedAt: null,
      staleCheck: false,
      detail: `Not configured, so this capability is off. Any gate that needs it will refuse rather than proceed. Set ${key} to a path or URL the agent performing it can read.`,
    };
  }

  if (check === undefined) {
    return {
      key,
      status: "unverified",
      value,
      checkedPath: null,
      lastCheckedAt: null,
      staleCheck: false,
      detail: `Set, but no sweep has checked it yet. The server does not read this document — it hands the value over — so "set" is not by itself evidence that anything can read it.`,
    };
  }

  const staleCheck = check.path !== value;
  const lastCheckedAt = check.lastCheckedAt.toISOString();

  if (staleCheck) {
    return {
      key,
      status: "unverified",
      value,
      checkedPath: check.path,
      lastCheckedAt,
      staleCheck: true,
      detail: `Set to a value the last sweep has not checked yet — it looked at a different path. The reading below is about that older path, not the current one.`,
    };
  }

  if (check.result === "exists") {
    return {
      key,
      status: "verified",
      value,
      checkedPath: check.path,
      lastCheckedAt,
      staleCheck: false,
      detail: `The last sweep found this document on the server's own filesystem.`,
    };
  }

  if (check.result === "missing") {
    return {
      key,
      status: "missing",
      value,
      checkedPath: check.path,
      lastCheckedAt,
      staleCheck: false,
      detail: `The last sweep looked on the server's filesystem and did not find it. This capability reads as configured but points at nothing — fix the path or set it to null to turn the capability off honestly.`,
    };
  }

  return {
    key,
    status: "unverified",
    value,
    checkedPath: check.path,
    lastCheckedAt,
    staleCheck: false,
    detail: `Set, and the server cannot check it — a URL it never fetches, or a path on a filesystem it cannot see. This may be entirely correct: the agent that performs this capability reads the document, and it need not share a filesystem with the server. It is reported as unverified rather than as a pass because recording "I could not check" is honest and recording a pass is not.`,
  };
}

/** Renders every declared capability. The shape `get_settings` carries. */
export function renderCapabilities(
  values: Readonly<Record<string, unknown>>,
  checks: Map<string, CapabilityCheckRow>,
): RenderedCapability[] {
  return CAPABILITY_SETTING_KEYS.map((key) => {
    const raw = values[key];
    const value = typeof raw === "string" ? raw : null;
    return renderCapability(key, value, checks.get(key));
  });
}
