// Regression: a stored override containing a schedule with `entries: []`
// must not crash anything that reads settings.
//
// Why this has its own file rather than a case in the budget-window suite:
// the fault was never really about budget windows. It was that a value
// which fails its schema could take out *every* entry point that resolves
// settings — and SCHEMA.md §17.3 makes an explicit promise about exactly
// that case:
//
//   "A key is declared, an override exists, it fails its schema — the
//    default is used, and the key is logged... Not a boot failure —
//    refusing to start because a bound moved turns a configuration nit
//    into an outage."
//
// A throw makes that promise unkeepable, and unkeepable in the worst
// direction: `/settings` is the surface for fixing a bad value, rendering
// it requires resolving, so resolution throwing means the row cannot be
// repaired through the interface that exists to repair it. Row #14
// resolves a snapshot per service call, so it would surface immediately.
//
// So this file walks the blast radius: the schema, both validator entry
// points, resolution, and the cache.
import { describe, expect, it } from "vitest";
import { budgetWindowsSchema } from "@/lib/settings/budget-windows";
import { validateOverrideColumn, validateSetting } from "@/lib/settings/validate";
import { resolveSettings } from "@/lib/settings/resolve";
import { SettingsCache, type SettingsSource } from "@/lib/settings/cache";

/** The offending value: correctly typed everywhere except an empty `entries`. */
function windowsWithEmptySchedule(position: "selective" | "windDown" | "stop"): unknown {
  const constant = (value: number) => ({ kind: "constant", value });
  const boundaries: Record<string, unknown> = {
    selective: constant(10),
    windDown: constant(20),
    stop: constant(30),
  };
  boundaries[position] = { kind: "schedule", entries: [] };
  return { fiveHour: { enabled: true, lengthHours: 5, boundaries } };
}

const POSITIONS = ["selective", "windDown", "stop"] as const;

describe.each(POSITIONS)("an empty schedule stored in the %s boundary", (position) => {
  const badValue = windowsWithEmptySchedule(position);

  it("is refused by the schema without throwing", () => {
    expect(() => budgetWindowsSchema.safeParse(badValue)).not.toThrow();
    expect(budgetWindowsSchema.safeParse(badValue).success).toBe(false);
  });

  it("is refused by validateSetting without throwing", () => {
    expect(() => validateSetting("budget.windows", badValue)).not.toThrow();
    expect(validateSetting("budget.windows", badValue).ok).toBe(false);
  });

  it("is refused by validateOverrideColumn without throwing", () => {
    // The per-account override path — the same validator, so the same
    // fault would have reached it.
    expect(() => validateOverrideColumn("accounts.budget_windows", badValue)).not.toThrow();
    expect(validateOverrideColumn("accounts.budget_windows", badValue).ok).toBe(false);
  });

  it("falls back to the default and is reported, exactly as §17.3 requires", () => {
    // Not a throw, and not a silent coercion either: the default is used,
    // the stored value is kept so /settings can show it beside the error,
    // and every other key still resolves.
    expect(() =>
      resolveSettings({ overrides: [{ key: "budget.windows", value: badValue }], revision: 1n }),
    ).not.toThrow();

    const snapshot = resolveSettings({
      overrides: [{ key: "budget.windows", value: badValue }],
      revision: 1n,
    });

    expect(snapshot.values["budget.windows"]).toEqual({});
    expect(snapshot.rejected).toHaveLength(1);
    expect(snapshot.rejected[0]?.key).toBe("budget.windows");
    expect(snapshot.rejected[0]?.storedValue).toEqual(badValue);
    expect(snapshot.rejected[0]?.errors.length).toBeGreaterThan(0);
  });

  it("does not stop the other settings resolving alongside it", () => {
    // The outage shape: one bad row taking the whole configuration with
    // it. Every other key must still be there and still be correct.
    const snapshot = resolveSettings({
      overrides: [
        { key: "budget.windows", value: badValue },
        { key: "items.max_depth", value: 4 },
      ],
      revision: 1n,
    });
    expect(snapshot.values["items.max_depth"]).toBe(4);
    expect(snapshot.values["liveness.stale_after_seconds"]).toBe(900);
  });

  it("does not stop a cache serving a snapshot", async () => {
    // The entry point a long-lived process actually calls.
    const source: SettingsSource = {
      async readRevision() {
        return 1n;
      },
      async readOverrides() {
        return { overrides: [{ key: "budget.windows", value: badValue }], revision: 1n };
      },
    };
    const cache = new SettingsCache({ source, now: () => 0 });

    await expect(cache.get()).resolves.toBeDefined();
    const snapshot = await cache.get();
    expect(snapshot.values["budget.windows"]).toEqual({});
    expect(snapshot.rejected).toHaveLength(1);
  });
});

describe("the neighbouring shapes that were never affected", () => {
  it("refuses a non-array entries by type, before any refinement walks it", () => {
    // The control: this one fails the array type, so the refinement never
    // receives something to iterate. Included so the regression above is
    // pinned to the empty-array case specifically rather than to
    // "schedules are broken".
    const value = {
      fiveHour: {
        enabled: true,
        lengthHours: 5,
        boundaries: {
          selective: { kind: "constant", value: 10 },
          windDown: { kind: "constant", value: 20 },
          stop: { kind: "schedule", entries: "x" },
        },
      },
    };
    expect(() => budgetWindowsSchema.safeParse(value)).not.toThrow();
    expect(budgetWindowsSchema.safeParse(value).success).toBe(false);
  });

  it("still accepts a schedule that has entries", () => {
    // A rejection-only fix that also rejected valid values would pass
    // every test above and be worse than the bug.
    const value = {
      fiveHour: {
        enabled: true,
        lengthHours: 5,
        boundaries: {
          selective: { kind: "constant", value: 10 },
          windDown: { kind: "constant", value: 20 },
          stop: {
            kind: "schedule",
            entries: [{ at: { elapsed: 0, per: "hour" }, value: { kind: "constant", value: 30 } }],
          },
        },
      },
    };
    expect(budgetWindowsSchema.safeParse(value).success).toBe(true);
  });
});
