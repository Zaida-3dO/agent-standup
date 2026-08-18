// `src/lib/nav/density.ts` — the density preference, its storage, and the
// pre-paint boot script.
//
// The rule this file is really guarding is the one in the module header:
// density changes SPACING AND LINE-HEIGHT, never font size. That half is
// asserted against `globals.css` in `tests/design-density-tokens.test.ts`,
// because it is a property of the stylesheet rather than of this module.
import { describe, expect, it } from "vitest";
import {
  DEFAULT_DENSITY,
  DENSITIES,
  DENSITY_STORAGE_KEY,
  densityBootScript,
  densityClass,
  isDensity,
  readStoredDensity,
  writeStoredDensity,
} from "@/lib/nav/density";

/** A `Storage` stand-in — the harness has no DOM, so there is no real one. */
function memoryStorage(initial: Record<string, string> = {}): Storage {
  const map = new Map(Object.entries(initial));
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (key: string) => map.get(key) ?? null,
    key: (index: number) => [...map.keys()][index] ?? null,
    removeItem: (key: string) => void map.delete(key),
    setItem: (key: string, value: string) => void map.set(key, value),
  } as Storage;
}

/** A `Storage` that throws on every access — a browser with site data blocked. */
function hostileStorage(): Storage {
  return {
    get length(): number {
      throw new Error("blocked");
    },
    clear: () => {
      throw new Error("blocked");
    },
    getItem: () => {
      throw new Error("blocked");
    },
    key: () => {
      throw new Error("blocked");
    },
    removeItem: () => {
      throw new Error("blocked");
    },
    setItem: () => {
      throw new Error("blocked");
    },
  } as unknown as Storage;
}

describe("density vocabulary", () => {
  it("has exactly two densities and defaults to the roomier one", () => {
    expect(DENSITIES).toEqual(["comfortable", "compact"]);
    // Comfortable, deliberately: a first-run reader has not asked for
    // anything, and compact assumes you already know what you are looking
    // at. Flipping the default flips this.
    expect(DEFAULT_DENSITY).toBe("comfortable");
  });

  it("accepts only the two names", () => {
    expect(isDensity("compact")).toBe(true);
    expect(isDensity("comfortable")).toBe(true);
    expect(isDensity("cosy")).toBe(false);
    expect(isDensity(null)).toBe(false);
    expect(isDensity(2)).toBe(false);
  });

  it("gives compact a class and comfortable none — comfortable is the token baseline", () => {
    expect(densityClass("compact")).toBe("density-compact");
    // Emphatically the empty string, not `"density-comfortable"`: the
    // baseline tokens in globals.css §8 are the comfortable ones, so a
    // class for them would have nothing to declare.
    expect(densityClass("comfortable")).toBe("");
  });
});

describe("readStoredDensity / writeStoredDensity", () => {
  it("round-trips a stored preference", () => {
    const storage = memoryStorage();
    writeStoredDensity("compact", storage);
    expect(storage.getItem(DENSITY_STORAGE_KEY)).toBe("compact");
    // This is the "persists across a reload" claim: a fresh read of the
    // same storage returns what was written.
    expect(readStoredDensity(storage)).toBe("compact");
  });

  it("falls back to the default when nothing is stored", () => {
    expect(readStoredDensity(memoryStorage())).toBe("comfortable");
  });

  it("falls back to the default for a stored value that is not a density", () => {
    // A hand-edited value, or one written by an earlier build. Dropping the
    // `isDensity` guard in `readStoredDensity` returns "cosy" and fails.
    expect(readStoredDensity(memoryStorage({ [DENSITY_STORAGE_KEY]: "cosy" }))).toBe("comfortable");
  });

  it("survives storage that throws rather than taking the page down with it", () => {
    // `localStorage` genuinely throws in a browser with site data blocked,
    // so the try/catch is load-bearing. Removing it makes both of these
    // throw instead of degrading.
    expect(readStoredDensity(hostileStorage())).toBe("comfortable");
    expect(() => writeStoredDensity("compact", hostileStorage())).not.toThrow();
  });
});

describe("densityBootScript", () => {
  it("adds the compact class for a stored compact preference, before any paint", () => {
    // The script is evaluated the way the browser would, against a fake
    // document and localStorage — which is what proves it does the right
    // thing, rather than merely that it is a non-empty string.
    const classes = new Set<string>();
    const run = (stored: string | null) => {
      classes.clear();
      const fn = new Function("localStorage", "document", densityBootScript()) as (
        storage: unknown,
        doc: unknown,
      ) => void;
      fn(
        { getItem: () => stored },
        { documentElement: { classList: { add: (c: string) => void classes.add(c) } } },
      );
    };

    run("compact");
    expect([...classes]).toEqual(["density-compact"]);

    // Comfortable adds nothing — the baseline needs no class.
    run("comfortable");
    expect([...classes]).toEqual([]);

    // Nothing stored, and a junk value, both leave the document alone.
    run(null);
    expect([...classes]).toEqual([]);
    run("cosy");
    expect([...classes]).toEqual([]);
  });

  it("swallows a throwing storage instead of breaking the document", () => {
    const fn = new Function("localStorage", "document", densityBootScript()) as (
      storage: unknown,
      doc: unknown,
    ) => void;
    expect(() =>
      fn(
        {
          getItem: () => {
            throw new Error("blocked");
          },
        },
        { documentElement: { classList: { add: () => {} } } },
      ),
    ).not.toThrow();
  });
});
