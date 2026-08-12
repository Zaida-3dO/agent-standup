// Resolution and the frozen snapshot (SCHEMA.md §17.3).
//
// The freeze assertions here attempt a real mutation and check the outcome,
// rather than asserting the type is readonly. `readonly` is erased at run
// time: a snapshot typed readonly and never frozen passes a type-level test
// and is freely mutable in production, which is the exact bug the freeze
// exists to prevent.
import { describe, expect, it } from "vitest";
import {
  defaultSnapshot,
  deepFreeze,
  resolveSettings,
  type SettingsSnapshot,
} from "@/lib/settings/resolve";
import { SETTINGS_REGISTRY, SETTING_KEYS } from "@/lib/settings/registry";

/**
 * Attempts a mutation and reports what actually happened.
 *
 * Strict mode throws on a write to a frozen object and sloppy mode silently
 * no-ops; test files are modules, so this runs strict and should throw. It
 * is written to accept either outcome as "the write did not land", but to
 * insist the value is unchanged afterwards — which is the property that
 * matters and the one a caller cannot work around.
 */
function attemptMutation(mutate: () => void): { threw: boolean } {
  try {
    mutate();
    return { threw: false };
  } catch {
    return { threw: true };
  }
}

describe("resolution", () => {
  it("returns every declared key when there are no overrides at all", () => {
    const snapshot = defaultSnapshot();
    for (const key of SETTING_KEYS) {
      expect(snapshot.values, key).toHaveProperty(key);
    }
    expect(Object.keys(snapshot.values).sort()).toEqual([...SETTING_KEYS].sort());
  });

  it("resolves a fresh database to exactly the registry defaults", () => {
    // §17.2's first property: a fresh database boots fully working with no
    // configuration, because the defaults are code.
    const snapshot = defaultSnapshot();
    expect(snapshot.values["items.max_depth"]).toBe(6);
    expect(snapshot.values["liveness.stale_after_seconds"]).toBe(900);
    expect(snapshot.values["budget.enabled"]).toBe(false);
    expect(snapshot.values["notify.doc"]).toBeNull();
    expect(snapshot.values["retention.tool_calls_days"]).toBeNull();
    expect(snapshot.values["minting.source_globs"]).toEqual([]);
  });

  it("applies an override that validates", () => {
    const snapshot = resolveSettings({
      overrides: [{ key: "items.max_depth", value: 3 }],
      revision: 7n,
    });
    expect(snapshot.values["items.max_depth"]).toBe(3);
    expect(snapshot.revision).toBe(7n);
    expect(snapshot.rejected).toEqual([]);
  });

  it("treats an explicit JSON null as a value, not as an absent row", () => {
    // §17.2: null is "explicitly nothing" and is not the same as no row,
    // which means "at the default". Here the default is already null, so
    // the case that distinguishes them is a key whose default is not null.
    const snapshot = resolveSettings({
      overrides: [{ key: "retention.tool_calls_days", value: null }],
      revision: 1n,
    });
    expect(snapshot.values["retention.tool_calls_days"]).toBeNull();
    expect(snapshot.rejected).toEqual([]);
  });

  it("falls back to the default and reports when an override fails its schema", () => {
    // §17.3: not a boot failure — refusing to start because a bound moved
    // turns a configuration nit into an outage — and not silently coerced
    // either, because a coerced value is one nobody chose.
    const snapshot = resolveSettings({
      overrides: [{ key: "items.max_depth", value: "not a number" }],
      revision: 2n,
    });
    expect(snapshot.values["items.max_depth"]).toBe(6);
    expect(snapshot.rejected).toHaveLength(1);
    expect(snapshot.rejected[0]?.key).toBe("items.max_depth");
    expect(snapshot.rejected[0]?.storedValue).toBe("not a number");
    expect(snapshot.rejected[0]?.errors.length).toBeGreaterThan(0);
  });

  it("keeps a stored value that fails, so /settings can show it beside the error", () => {
    const snapshot = resolveSettings({
      overrides: [{ key: "model_picker.explore_rate", value: 4 }],
      revision: 3n,
    });
    expect(snapshot.values["model_picker.explore_rate"]).toBe(0);
    expect(snapshot.rejected[0]?.storedValue).toBe(4);
  });

  it("makes a row for an undeclared key inert rather than deleting or applying it", () => {
    const snapshot = resolveSettings({
      overrides: [{ key: "items.retired_key", value: 99 }],
      revision: 4n,
    });
    expect(snapshot.unrecognised).toEqual([{ key: "items.retired_key", storedValue: 99 }]);
    expect(snapshot.values).not.toHaveProperty("items.retired_key");
    // Inert means it cannot affect behaviour — resolution starts from the
    // registry, so no declared key was touched by it either.
    expect(snapshot.values["items.max_depth"]).toBe(6);
  });

  it("does not let one bad override discard the good ones alongside it", () => {
    const snapshot = resolveSettings({
      overrides: [
        { key: "items.max_depth", value: 4 },
        { key: "liveness.stale_after_seconds", value: "nope" },
        { key: "budget.enabled", value: true },
      ],
      revision: 5n,
    });
    expect(snapshot.values["items.max_depth"]).toBe(4);
    expect(snapshot.values["budget.enabled"]).toBe(true);
    expect(snapshot.values["liveness.stale_after_seconds"]).toBe(900);
    expect(snapshot.rejected).toHaveLength(1);
  });
});

describe("the snapshot is frozen, not merely typed readonly", () => {
  it("refuses a write to a scalar setting and leaves the value unchanged", () => {
    const snapshot = defaultSnapshot();
    const before = snapshot.values["items.max_depth"];

    const { threw } = attemptMutation(() => {
      (snapshot.values as unknown as Record<string, unknown>)["items.max_depth"] = 999;
    });

    expect(threw).toBe(true);
    expect(snapshot.values["items.max_depth"]).toBe(before);
    expect(snapshot.values["items.max_depth"]).not.toBe(999);
  });

  it("refuses adding a key that was never declared", () => {
    const snapshot = defaultSnapshot();
    attemptMutation(() => {
      (snapshot.values as unknown as Record<string, unknown>)["items.invented"] = 1;
    });
    expect(snapshot.values).not.toHaveProperty("items.invented");
  });

  it("refuses a write to the snapshot's own fields", () => {
    const snapshot = defaultSnapshot();
    attemptMutation(() => {
      (snapshot as unknown as Record<string, unknown>).revision = 999n;
    });
    expect(snapshot.revision).toBe(0n);
  });

  it("freezes deeply — an array value cannot be pushed to", () => {
    // The mutation worth preventing: reached through a chain long enough
    // that nobody notices they are writing to shared state. A shallow
    // Object.freeze leaves this one writable.
    const snapshot = resolveSettings({
      overrides: [{ key: "minting.source_globs", value: ["src/**"] }],
      revision: 1n,
    });
    const globs = snapshot.values["minting.source_globs"];
    expect(Object.isFrozen(globs)).toBe(true);

    attemptMutation(() => {
      (globs as string[]).push("etc/**");
    });
    expect(globs).toEqual(["src/**"]);
    expect(globs).toHaveLength(1);
  });

  it("freezes deeply — a nested object value cannot be reassigned", () => {
    const snapshot = resolveSettings({
      overrides: [
        {
          key: "budget.windows",
          value: {
            fiveHour: {
              enabled: true,
              lengthHours: 5,
              boundaries: {
                selective: { kind: "constant", value: 50 },
                windDown: { kind: "constant", value: 80 },
                stop: { kind: "constant", value: 95 },
              },
            },
          },
        },
      ],
      revision: 1n,
    });

    const windows = snapshot.values["budget.windows"] as Record<string, { enabled: boolean }>;
    expect(Object.isFrozen(windows)).toBe(true);
    expect(Object.isFrozen(windows.fiveHour)).toBe(true);

    attemptMutation(() => {
      windows.fiveHour!.enabled = false;
    });
    expect(windows.fiveHour!.enabled).toBe(true);

    const nested = windows as unknown as Record<
      string,
      { boundaries: { stop: { value: number } } }
    >;
    expect(Object.isFrozen(nested.fiveHour!.boundaries.stop)).toBe(true);
    attemptMutation(() => {
      nested.fiveHour!.boundaries.stop.value = 1;
    });
    expect(nested.fiveHour!.boundaries.stop.value).toBe(95);
  });

  it("freezes the rejected and unrecognised lists too", () => {
    const snapshot = resolveSettings({
      overrides: [
        { key: "items.max_depth", value: "bad" },
        { key: "items.gone", value: 1 },
      ],
      revision: 1n,
    });
    expect(Object.isFrozen(snapshot.rejected)).toBe(true);
    expect(Object.isFrozen(snapshot.unrecognised)).toBe(true);
    attemptMutation(() => {
      (snapshot.rejected as unknown as unknown[]).push({});
    });
    expect(snapshot.rejected).toHaveLength(1);
  });

  it("never freezes the registry's own default objects", () => {
    // Freezing a default in place would make a module-level constant
    // immutable for the lifetime of the process the first time anything
    // resolved, and would have two snapshots sharing one object.
    resolveSettings({ overrides: [], revision: 1n });
    expect(Object.isFrozen(SETTINGS_REGISTRY["minting.source_globs"].default)).toBe(false);
    expect(Object.isFrozen(SETTINGS_REGISTRY["budget.windows"].default)).toBe(false);
  });

  it("gives two snapshots separate objects, so freezing one cannot affect the other", () => {
    const first = resolveSettings({
      overrides: [{ key: "minting.source_globs", value: ["a/**"] }],
      revision: 1n,
    });
    const second = resolveSettings({
      overrides: [{ key: "minting.source_globs", value: ["b/**"] }],
      revision: 2n,
    });
    expect(first.values["minting.source_globs"]).not.toBe(second.values["minting.source_globs"]);
    expect(first.values["minting.source_globs"]).toEqual(["a/**"]);
    expect(second.values["minting.source_globs"]).toEqual(["b/**"]);
  });

  it("does not share a mutable object with the input overrides", () => {
    // A caller keeping a reference to what it passed in must not be able to
    // reach into the snapshot through it.
    const supplied = { key: "minting.source_globs", value: ["src/**"] };
    const snapshot = resolveSettings({ overrides: [supplied], revision: 1n });
    (supplied.value as string[]).push("mutated/**");
    expect(snapshot.values["minting.source_globs"]).toEqual(["src/**"]);
  });
});

describe("deepFreeze", () => {
  it("terminates on a cyclic structure rather than recursing forever", () => {
    const cyclic: Record<string, unknown> = { name: "a" };
    cyclic.self = cyclic;
    const frozen = deepFreeze(cyclic);
    expect(Object.isFrozen(frozen)).toBe(true);
    expect(frozen.self).toBe(frozen);
  });

  it("freezes objects inside arrays inside objects", () => {
    const value = deepFreeze({ list: [{ deep: { deeper: 1 } }] });
    expect(Object.isFrozen(value.list)).toBe(true);
    expect(Object.isFrozen(value.list[0])).toBe(true);
    expect(Object.isFrozen(value.list[0]?.deep)).toBe(true);
  });

  it("leaves primitives alone rather than throwing on them", () => {
    expect(deepFreeze(1)).toBe(1);
    expect(deepFreeze(null)).toBeNull();
    expect(deepFreeze(undefined)).toBeUndefined();
    expect(deepFreeze("text")).toBe("text");
  });

  it("does not invoke a getter while freezing", () => {
    // Reading a getter here would run someone's code during resolution and
    // freeze an object the getter may not own.
    let reads = 0;
    const withGetter = {
      get expensive() {
        reads += 1;
        return { untouched: true };
      },
    };
    deepFreeze(withGetter);
    expect(reads).toBe(0);
  });
});

describe("the snapshot a caller receives", () => {
  it("is typed per key rather than as a bag of unknowns", () => {
    // A compile-time assertion: these lines do not typecheck if the
    // snapshot degrades to Record<string, unknown>. `npx tsc --noEmit` is
    // where this one actually fails.
    const snapshot: SettingsSnapshot = defaultSnapshot();
    const depth: number = snapshot.values["items.max_depth"];
    const enabled: boolean = snapshot.values["budget.enabled"];
    const doc: string | null = snapshot.values["notify.doc"];
    expect(depth).toBe(6);
    expect(enabled).toBe(false);
    expect(doc).toBeNull();
  });
});
