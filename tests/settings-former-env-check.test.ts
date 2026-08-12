// The retired-environment-variable startup check (docs/plans/MILESTONES.md
// #90).
//
// Same discipline as settings-registry.test.ts: every claim here is
// checked against the real registry AND against a fixture the function was
// not written to pass, because the second is the only proof the function
// has teeth. In particular AC1 below is not "the check finds the names it
// hardcodes" — findFormerEnvHits hardcodes no names at all; it only walks
// `formerEnv` on whatever declarations it is handed.
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { Declarations } from "@/lib/settings/invariants";
import type { SettingDefinition } from "@/lib/settings/registry";
import { SETTINGS_REGISTRY } from "@/lib/settings/registry";
import {
  RetiredEnvVarError,
  checkFormerEnv,
  findFormerEnvHits,
} from "@/lib/settings/former-env-check";

function soundDefinition(overrides: Partial<SettingDefinition> = {}): SettingDefinition {
  return {
    schema: z.number().int(),
    default: 1,
    label: "Fixture setting",
    help: "A long enough explanation of what this fixture field does for the invariant checks.",
    category: "Items",
    appliesWhen: "next-call",
    sensitive: false,
    irreversible: false,
    formerEnv: [],
    ...overrides,
  } as SettingDefinition;
}

function fixture(key: string, overrides: Partial<SettingDefinition> = {}): Declarations {
  return { [key]: soundDefinition(overrides) } as Declarations;
}

describe("findFormerEnvHits", () => {
  // AC1: derived from the registry, not a hand-written list. The fixture
  // key and env var below ("items.example_migrated" /
  // "EXAMPLE_MIGRATED_VAR") appear nowhere in former-env-check.ts — if the
  // function worked off a hardcoded list instead of reading
  // `definition.formerEnv`, this fixture-only name could never be found.
  it("picks up a fixture key's formerEnv with no edit to the checker itself", () => {
    const declarations = fixture("items.example_migrated", {
      formerEnv: ["EXAMPLE_MIGRATED_VAR"],
    });
    const hits = findFormerEnvHits(declarations, { EXAMPLE_MIGRATED_VAR: "some-value" });
    expect(hits).toEqual([
      { envVar: "EXAMPLE_MIGRATED_VAR", key: "items.example_migrated", label: "Fixture setting" },
    ]);
  });

  it("finds every real retired variable that is set, from the real registry", () => {
    const hits = findFormerEnvHits(SETTINGS_REGISTRY as unknown as Declarations, {
      POLL_INTERVAL_SECONDS: "300",
      WAIT_FOR_CREW_TIMEOUT: "240",
      NOTIFY_DOC: "/docs/notify.md",
    });
    const envVars = hits.map((h) => h.envVar).sort();
    expect(envVars).toEqual(["NOTIFY_DOC", "POLL_INTERVAL_SECONDS", "WAIT_FOR_CREW_TIMEOUT"]);
  });

  it("treats an empty string as set — the operator wrote something", () => {
    const declarations = fixture("items.example_migrated", { formerEnv: ["EXAMPLE_VAR"] });
    expect(findFormerEnvHits(declarations, { EXAMPLE_VAR: "" })).toHaveLength(1);
  });

  it("does not fire when the retired variable is genuinely absent", () => {
    const declarations = fixture("items.example_migrated", { formerEnv: ["EXAMPLE_VAR"] });
    expect(findFormerEnvHits(declarations, {})).toEqual([]);
  });

  // AC's false-positive guard: the three variables that legitimately remain
  // bootstrap environment (SCHEMA.md §17.1) must never trip this — none of
  // them is any key's formerEnv, but a false positive here would refuse to
  // boot every installation, so it is worth proving directly against the
  // real registry rather than trusting the absence by inspection.
  it("does not fire on DATABASE_URL, BIND, or PORT against the real registry", () => {
    const hits = findFormerEnvHits(SETTINGS_REGISTRY as unknown as Declarations, {
      DATABASE_URL: "postgresql://example/example",
      BIND: "0.0.0.0",
      PORT: "3000",
    });
    expect(hits).toEqual([]);
  });
});

describe("checkFormerEnv — development and test", () => {
  // AC2. The single-character change that breaks this: flip the `===` on
  // the nodeEnv === "production" branch in former-env-check.ts to `!==` (or
  // delete the `throw`) and this test starts failing because nothing is
  // thrown any more.
  it("throws RetiredEnvVarError when a retired variable is set and NODE_ENV is not production", () => {
    expect(() =>
      checkFormerEnv({
        declarations: fixture("items.example", { formerEnv: ["OLD_VAR"] }),
        env: { OLD_VAR: "1" },
        nodeEnv: "development",
      }),
    ).toThrow(RetiredEnvVarError);
  });

  it("throws in test mode too — NODE_ENV is not an allowlist of one", () => {
    expect(() =>
      checkFormerEnv({
        declarations: fixture("items.example", { formerEnv: ["OLD_VAR"] }),
        env: { OLD_VAR: "1" },
        nodeEnv: "test",
      }),
    ).toThrow(RetiredEnvVarError);
  });

  it("names the retired variable and the setting that replaced it in the thrown message", () => {
    try {
      checkFormerEnv({
        declarations: fixture("items.example", {
          formerEnv: ["OLD_VAR"],
          label: "Example Setting",
        }),
        env: { OLD_VAR: "1" },
        nodeEnv: "development",
      });
      throw new Error("expected checkFormerEnv to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(RetiredEnvVarError);
      const retiredErr = err as RetiredEnvVarError;
      expect(retiredErr.message).toContain("OLD_VAR");
      expect(retiredErr.message).toContain("Example Setting");
      expect(retiredErr.hits).toEqual([
        { envVar: "OLD_VAR", key: "items.example", label: "Example Setting" },
      ]);
    }
  });

  it("does not throw when nothing retired is set", () => {
    expect(() =>
      checkFormerEnv({
        declarations: fixture("items.example", { formerEnv: ["OLD_VAR"] }),
        env: {},
        nodeEnv: "development",
      }),
    ).not.toThrow();
  });
});

describe("checkFormerEnv — production", () => {
  // AC3. The single-character change that breaks this: swap the `throw`
  // and the log-and-return bodies of the two branches (or delete the
  // `nodeEnv === "production"` guard) and this test starts throwing
  // instead of returning — proving it genuinely takes a different path
  // than the development test above, not a shared one with a relabelled
  // assertion.
  it("does not throw when a retired variable is set and NODE_ENV is production", () => {
    const log = { error: vi.fn() };
    expect(() =>
      checkFormerEnv({
        declarations: fixture("items.example", { formerEnv: ["OLD_VAR"] }),
        env: { OLD_VAR: "1" },
        nodeEnv: "production",
        log,
      }),
    ).not.toThrow();
  });

  it("logs at error level and returns the hit instead of throwing", () => {
    const log = { error: vi.fn() };
    const hits = checkFormerEnv({
      declarations: fixture("items.example", { formerEnv: ["OLD_VAR"], label: "Example Setting" }),
      env: { OLD_VAR: "1" },
      nodeEnv: "production",
      log,
    });
    expect(hits).toEqual([{ envVar: "OLD_VAR", key: "items.example", label: "Example Setting" }]);
    expect(log.error).toHaveBeenCalledTimes(1);
    const [message] = log.error.mock.calls[0] as [string];
    expect(message).toContain("OLD_VAR");
    expect(message).toContain("Example Setting");
  });

  it("logs once per hit when more than one retired variable is set", () => {
    const log = { error: vi.fn() };
    const declarations = {
      ...fixture("items.a", { formerEnv: ["OLD_A"], label: "A" }),
      ...fixture("items.b", { formerEnv: ["OLD_B"], label: "B" }),
    };
    checkFormerEnv({
      declarations,
      env: { OLD_A: "1", OLD_B: "1" },
      nodeEnv: "production",
      log,
    });
    expect(log.error).toHaveBeenCalledTimes(2);
  });

  it("does not log when nothing retired is set", () => {
    const log = { error: vi.fn() };
    checkFormerEnv({
      declarations: fixture("items.example", { formerEnv: ["OLD_VAR"] }),
      env: {},
      nodeEnv: "production",
      log,
    });
    expect(log.error).not.toHaveBeenCalled();
  });
});

describe("checkFormerEnv — against the real registry", () => {
  it("does not throw in development when only DATABASE_URL, BIND, and PORT are set", () => {
    expect(() =>
      checkFormerEnv({
        env: { DATABASE_URL: "postgresql://example/example", BIND: "0.0.0.0", PORT: "3000" },
        nodeEnv: "development",
      }),
    ).not.toThrow();
  });

  it("throws in development when a real retired variable is set", () => {
    expect(() =>
      checkFormerEnv({
        env: { POLL_INTERVAL_SECONDS: "300" },
        nodeEnv: "development",
      }),
    ).toThrow(RetiredEnvVarError);
  });
});
