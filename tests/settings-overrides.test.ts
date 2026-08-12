// The two per-entity override columns (SCHEMA.md §17.7).
//
// The claim these tests exist to hold to account is "the override is
// validated by the registry's own validator" — which is only true if there
// is no second schema anywhere. So the central test here is not that a bad
// value is rejected; it is that the column and the setting reject the
// *same* value with the *same* errors, which a parallel schema would
// eventually stop doing.
import { describe, expect, it } from "vitest";
import {
  OVERRIDE_COLUMNS,
  isOverrideColumn,
  resolveOverride,
  validateOverrideColumn,
  validateSetting,
} from "@/lib/settings/validate";
import {
  effectiveBudgetWindows,
  effectiveSourceGlobs,
  readMachineSourceGlobs,
  type RawQuery,
} from "@/lib/settings/overrides";
import { defaultSnapshot, resolveSettings } from "@/lib/settings/resolve";
import { SETTING_KEYS } from "@/lib/settings/registry";

const A_VALID_WINDOW = {
  fiveHour: {
    enabled: true,
    lengthHours: 5,
    boundaries: {
      selective: { kind: "constant", value: 50 },
      windDown: { kind: "constant", value: 80 },
      stop: { kind: "constant", value: 95 },
    },
  },
};

describe("the override columns are declared, not assumed", () => {
  it("covers exactly the two the schema documents, and no third", () => {
    // §17.7: "two uses, and the door is closed to a third without an
    // argument". A third appearing here without that argument is what this
    // assertion is for.
    expect(Object.keys(OVERRIDE_COLUMNS).sort()).toEqual([
      "accounts.budget_windows",
      "machines.source_globs",
    ]);
  });

  it("points every column at a key the registry actually declares", () => {
    for (const overridden of Object.values(OVERRIDE_COLUMNS)) {
      expect(SETTING_KEYS).toContain(overridden);
    }
  });

  it("recognises a column by name and refuses one it does not know", () => {
    expect(isOverrideColumn("machines.source_globs")).toBe(true);
    expect(isOverrideColumn("items.max_depth")).toBe(false);
    const result = validateOverrideColumn("repos.default_branch", "main");
    expect(result.ok).toBe(false);
  });
});

describe("an override is validated by the registry's own validator", () => {
  // The property under test, stated as an equivalence: for the same value,
  // the column and the setting it overrides must agree — both on the
  // verdict and on the errors. A second schema would diverge here first.
  it.each([
    ["machines.source_globs", "minting.source_globs", ["src/**", "docs/**"]],
    ["accounts.budget_windows", "budget.windows", A_VALID_WINDOW],
  ] as const)("accepts through %s exactly what %s accepts", (column, key, value) => {
    const viaColumn = validateOverrideColumn(column, value);
    const viaSetting = validateSetting(key, value);
    expect(viaColumn.ok).toBe(true);
    expect(viaSetting.ok).toBe(true);
    expect(viaColumn).toEqual(viaSetting);
  });

  it.each([
    ["machines.source_globs", "minting.source_globs", "not-an-array"],
    ["machines.source_globs", "minting.source_globs", [1, 2, 3]],
    ["machines.source_globs", "minting.source_globs", [""]],
    ["accounts.budget_windows", "budget.windows", { bad: { enabled: "yes" } }],
    ["accounts.budget_windows", "budget.windows", 42],
  ] as const)("rejects through %s exactly what %s rejects", (column, key, value) => {
    const viaColumn = validateOverrideColumn(column, value);
    const viaSetting = validateSetting(key, value);
    expect(viaColumn.ok).toBe(false);
    expect(viaSetting.ok).toBe(false);
    // Identical errors, not merely both failing: a parallel schema could
    // reject the same value for a different reason and still pass a test
    // that only compared verdicts.
    expect(viaColumn).toEqual(viaSetting);
  });

  it("applies the cross-boundary check to a per-account value, exactly as §17.4 requires", () => {
    // The check §17.4 calls the one worth the most, reached through the
    // override rather than the setting.
    const crossing = {
      fiveHour: {
        enabled: true,
        lengthHours: 5,
        boundaries: {
          selective: { kind: "constant", value: 90 },
          windDown: { kind: "constant", value: 80 },
          stop: { kind: "constant", value: 95 },
        },
      },
    };
    const result = validateOverrideColumn("accounts.budget_windows", crossing);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.join(" ")).toContain("above");
    }
  });

  it("treats null as no override, which is what makes the column an override", () => {
    expect(validateOverrideColumn("machines.source_globs", null)).toEqual({
      ok: true,
      value: null,
    });
    expect(validateOverrideColumn("accounts.budget_windows", null)).toEqual({
      ok: true,
      value: null,
    });
  });

  it("accepts an empty array as a real override, distinct from null", () => {
    // "Override, and scan nothing" is a different instruction from "do not
    // override". Both are legal; only one falls back to the global.
    const result = validateOverrideColumn("machines.source_globs", []);
    expect(result).toEqual({ ok: true, value: [] });
  });
});

describe("resolving an override against the global value", () => {
  it("prefers the entity's value when it has one", () => {
    expect(resolveOverride(["own/**"], ["global/**"])).toEqual(["own/**"]);
  });

  it("falls back to the global value on null or undefined", () => {
    expect(resolveOverride(null, ["global/**"])).toEqual(["global/**"]);
    expect(resolveOverride(undefined, ["global/**"])).toEqual(["global/**"]);
  });

  it("does NOT fall back on an empty array, which is a deliberate override", () => {
    // The distinction the whole raw-SQL read exists to preserve. Under a
    // naive falsy check this returns the global, silently overriding the
    // operator's instruction to scan nothing.
    expect(resolveOverride([], ["global/**"])).toEqual([]);
  });

  it("does not fall back on other falsy-but-meaningful values", () => {
    expect(resolveOverride(0, 5)).toBe(0);
    expect(resolveOverride(false, true)).toBe(false);
    expect(resolveOverride("", "fallback")).toBe("");
  });
});

describe("machines.source_globs — the null-versus-empty distinction", () => {
  /** A stand-in for the query the real read issues. */
  function fakeDb(rows: { name: string; source_globs: string[] | null }[]): RawQuery {
    return {
      async $queryRawUnsafe<T>(_query: string, ...values: unknown[]): Promise<T> {
        const wanted = values[0];
        return rows
          .filter((row) => row.name === wanted)
          .map((row) => ({
            name: row.name,
            source_globs: row.source_globs,
            overridden: row.source_globs !== null,
          })) as T;
      },
    };
  }

  it("reports null for a machine that does not override", async () => {
    const db = fakeDb([{ name: "desktop", source_globs: null }]);
    const machine = await readMachineSourceGlobs(db, "desktop");
    expect(machine?.sourceGlobs).toBeNull();
  });

  it("reports an empty array for a machine that overrides with nothing", async () => {
    // Not null. These two rows are the ones a client-typed read collapses
    // together, and they mean opposite things.
    const db = fakeDb([{ name: "laptop", source_globs: [] }]);
    const machine = await readMachineSourceGlobs(db, "laptop");
    expect(machine?.sourceGlobs).toEqual([]);
    expect(machine?.sourceGlobs).not.toBeNull();
  });

  it("reports the globs for a machine that overrides with some", async () => {
    const db = fakeDb([{ name: "laptop", source_globs: ["work/**"] }]);
    const machine = await readMachineSourceGlobs(db, "laptop");
    expect(machine?.sourceGlobs).toEqual(["work/**"]);
  });

  it("reports nothing for a machine that does not exist", async () => {
    const db = fakeDb([]);
    expect(await readMachineSourceGlobs(db, "absent")).toBeNull();
  });

  it("asks Postgres the null question rather than inferring it from an empty array", async () => {
    // If the query stopped selecting `IS NOT NULL`, the two states above
    // would become indistinguishable — so assert the question is asked.
    let issued = "";
    const db: RawQuery = {
      async $queryRawUnsafe<T>(query: string): Promise<T> {
        issued = query;
        return [] as T;
      },
    };
    await readMachineSourceGlobs(db, "desktop");
    expect(issued).toContain("IS NOT NULL");
  });
});

describe("the effective value at the point of use", () => {
  it("uses the global globs for a machine that does not override", () => {
    const snapshot = resolveSettings({
      overrides: [{ key: "minting.source_globs", value: ["global/**"] }],
      revision: 1n,
    });
    expect(effectiveSourceGlobs({ sourceGlobs: null }, snapshot)).toEqual(["global/**"]);
    expect(effectiveSourceGlobs(null, snapshot)).toEqual(["global/**"]);
  });

  it("uses the machine's globs when it overrides", () => {
    const snapshot = resolveSettings({
      overrides: [{ key: "minting.source_globs", value: ["global/**"] }],
      revision: 1n,
    });
    expect(effectiveSourceGlobs({ sourceGlobs: ["own/**"] }, snapshot)).toEqual(["own/**"]);
  });

  it("honours an empty override rather than quietly restoring the global", () => {
    const snapshot = resolveSettings({
      overrides: [{ key: "minting.source_globs", value: ["global/**"] }],
      revision: 1n,
    });
    expect(effectiveSourceGlobs({ sourceGlobs: [] }, snapshot)).toEqual([]);
  });

  it("uses the global windows for an account that does not override", () => {
    const snapshot = defaultSnapshot();
    const { windows, rejected } = effectiveBudgetWindows(null, snapshot);
    expect(windows).toEqual({});
    expect(rejected).toBeNull();
  });

  it("uses the account's windows when it overrides", () => {
    const snapshot = defaultSnapshot();
    const { windows, rejected } = effectiveBudgetWindows(A_VALID_WINDOW, snapshot);
    expect(windows).toHaveProperty("fiveHour");
    expect(rejected).toBeNull();
  });

  it("falls back and reports when a stored account override no longer validates", () => {
    // The same posture §17.3 takes for a bad settings row: the global value
    // is used and the failure is reported, rather than the account being
    // refused service or handed a coerced value nobody chose.
    const snapshot = defaultSnapshot();
    const { windows, rejected } = effectiveBudgetWindows({ bad: { enabled: 1 } }, snapshot);
    expect(windows).toEqual({});
    expect(rejected).not.toBeNull();
    expect(rejected?.length).toBeGreaterThan(0);
  });
});
