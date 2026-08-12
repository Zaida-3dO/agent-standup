// The registry's own test (docs/plans/MILESTONES.md #77).
//
// Every invariant here is checked twice, and the second check is the one
// that matters:
//
//   1. the real registry satisfies it, and
//   2. a deliberately-broken fixture is REJECTED by the same function.
//
// (1) alone proves nothing. A check written as "for each key in the
// registry, assert X" reads the registry it was written against, so it
// passes the moment it is written and keeps passing whatever anyone adds
// later — it names a property it cannot fail on. The fixtures are the
// evidence that the check has teeth; if a checker were gutted to
// `return []`, every assertion in group (1) would still pass and only the
// rejection assertions would go red.
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  APPLIES_WHEN,
  SETTINGS_REGISTRY,
  SETTING_CATEGORIES,
  SETTING_KEYS,
  type SettingDefinition,
} from "@/lib/settings/registry";
import {
  KEY_PREFIXES,
  MIN_HELP_CHARACTERS,
  checkDefaultsValid,
  checkHelpPresent,
  checkNoCredentialShapedKey,
  checkNoUnmappedPrefix,
  checkRegistryInvariants,
  type Declarations,
} from "@/lib/settings/invariants";

/**
 * A well-formed declaration, used as the base every broken fixture is a
 * single deviation from — so a rejection can only be attributed to the one
 * field that was changed.
 */
function soundDefinition(overrides: Partial<SettingDefinition> = {}): SettingDefinition {
  return {
    schema: z.number().int(),
    default: 1,
    label: "Items maximum depth",
    help: "A long enough explanation of what this field does and what changing it will cost the installation.",
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

describe("the registry itself", () => {
  it("declares at least one setting, so the checks below are not vacuous", () => {
    // Without this, a registry emptied by a bad merge would satisfy every
    // "for each key" assertion in this file by having no keys to check.
    expect(SETTING_KEYS.length).toBeGreaterThan(0);
  });

  it("passes every invariant at once", () => {
    expect(checkRegistryInvariants(SETTINGS_REGISTRY as unknown as Declarations)).toEqual([]);
  });
});

describe("invariant: every key has help text", () => {
  it("holds for the real registry", () => {
    expect(checkHelpPresent(SETTINGS_REGISTRY as unknown as Declarations)).toEqual([]);
  });

  // The failing case: a key declared with an empty help string.
  it("rejects a key whose help text is empty", () => {
    const violations = checkHelpPresent(fixture("items.example", { help: "" }));
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ key: "items.example", invariant: "help" });
    expect(violations[0]?.message).toContain("no help text");
  });

  // The failing case: help that is present but too short to explain
  // anything — the version a non-empty check would wave through.
  it("rejects a key whose help text is too short to be an explanation", () => {
    const stub = "The max depth.";
    expect(stub.length).toBeLessThan(MIN_HELP_CHARACTERS);
    const violations = checkHelpPresent(fixture("items.example", { help: stub }));
    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toContain("floor");
  });

  it("rejects help that is only whitespace, which is not the same as short", () => {
    const violations = checkHelpPresent(fixture("items.example", { help: "        " }));
    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toContain("no help text");
  });
});

describe("invariant: every default validates against its own key's schema", () => {
  it("holds for the real registry", () => {
    expect(checkDefaultsValid(SETTINGS_REGISTRY as unknown as Declarations)).toEqual([]);
  });

  // The failing case: a default of the wrong type for its schema.
  it("rejects a default of the wrong type", () => {
    const violations = checkDefaultsValid(
      fixture("items.example", {
        schema: z.number().int() as unknown as SettingDefinition["schema"],
        default: "six",
      }),
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ key: "items.example", invariant: "default" });
  });

  // The failing case that actually happens: the schema is tightened and
  // the default is left where it was, so a fresh database — which stores
  // no overrides at all — resolves a value this same build would refuse.
  it("rejects a default outside a bound the schema has tightened to", () => {
    const violations = checkDefaultsValid(
      fixture("items.example", {
        schema: z.number().int().min(30) as unknown as SettingDefinition["schema"],
        default: 6,
      }),
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toContain("fails its own schema");
  });

  it("accepts a null default where the schema is nullable, which is a real case here", () => {
    // retention.tool_calls_days and notify.doc both default to null; a
    // checker that treated null as missing would fail them.
    expect(
      checkDefaultsValid(
        fixture("retention.example", {
          schema: z.number().int().nullable() as unknown as SettingDefinition["schema"],
          default: null,
          category: "Retention",
        }),
      ),
    ).toEqual([]);
  });
});

describe("invariant: no credential-shaped key", () => {
  it("holds for the real registry", () => {
    expect(checkNoCredentialShapedKey(SETTINGS_REGISTRY as unknown as Declarations)).toEqual([]);
  });

  // The failing cases. These are invented key *names* with no value behind
  // them — the point is the shape of the name, and naming a real secret to
  // test a check that exists to keep real secrets out would defeat it.
  it.each([
    ["notify.webhook_token", "token"],
    ["items.api_key", "api_key"],
    ["dispatch.runner_password", "password"],
    ["agents.shared_secret", "secret"],
    ["minting.private_key", "private_key"],
    ["liveness.probe_credentials", "credentials"],
  ])("rejects %s", (key, word) => {
    const violations = checkNoCredentialShapedKey(fixture(key));
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ key, invariant: "credential-shape" });
    expect(violations[0]?.message).toContain(word);
  });

  it("does not fire on an ordinary key that merely contains a matching substring", () => {
    // "tool_calls" contains "auth" nowhere, but "authority" does contain
    // "auth" — matching on substrings rather than words would reject
    // items.default_merge_authority, a key the registry really declares.
    expect(checkNoCredentialShapedKey(fixture("items.default_merge_authority"))).toEqual([]);
    expect(checkNoCredentialShapedKey(fixture("retention.tool_calls_days"))).toEqual([]);
  });
});

describe("invariant: no unmapped prefix", () => {
  it("holds for the real registry", () => {
    expect(checkNoUnmappedPrefix(SETTINGS_REGISTRY as unknown as Declarations)).toEqual([]);
  });

  // The failing case: a prefix naming a subsystem the build does not have.
  it("rejects a key under a prefix that is not mapped", () => {
    const violations = checkNoUnmappedPrefix(fixture("telemetry.sample_rate"));
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ key: "telemetry.sample_rate", invariant: "prefix" });
    expect(violations[0]?.message).toContain("unmapped prefix");
  });

  it("rejects a key with no prefix at all", () => {
    const violations = checkNoUnmappedPrefix(fixture("maxdepth"));
    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toContain("<prefix>.<name>");
  });

  it("rejects a key whose prefix is empty", () => {
    expect(checkNoUnmappedPrefix(fixture(".max_depth"))).toHaveLength(1);
  });

  // The failing case that is invisible in normal use: the key is
  // well-prefixed but filed in the wrong section of /settings, so it looks
  // right everywhere except the one screen it is rendered on.
  it("rejects a well-prefixed key filed under the wrong category", () => {
    const violations = checkNoUnmappedPrefix(fixture("liveness.example", { category: "Budget" }));
    expect(violations).toHaveLength(1);
    expect(violations[0]?.message).toContain("maps to");
  });

  it("maps every prefix the real registry uses", () => {
    for (const key of SETTING_KEYS) {
      const prefix = key.slice(0, key.indexOf("."));
      expect(KEY_PREFIXES[prefix], `prefix "${prefix}" is unmapped`).toBeDefined();
    }
  });
});

describe("the nine per-key fields", () => {
  // MILESTONES #77 lists nine fields, and the reason they are all required
  // rather than optional-with-a-default is that "nobody considered it" and
  // "considered, and it is false" are different states — only one of which
  // is safe for `sensitive`.
  const NINE_FIELDS = [
    "schema",
    "default",
    "label",
    "help",
    "category",
    "appliesWhen",
    "sensitive",
    "irreversible",
    "formerEnv",
  ] as const;

  it.each(SETTING_KEYS)("%s declares all nine fields", (key) => {
    const definition = SETTINGS_REGISTRY[key] as unknown as Record<string, unknown>;
    for (const field of NINE_FIELDS) {
      expect(Object.prototype.hasOwnProperty.call(definition, field), field).toBe(true);
      expect(definition[field], field).not.toBeUndefined();
    }
  });

  it.each(SETTING_KEYS)("%s uses a declared category and appliesWhen", (key) => {
    const definition = SETTINGS_REGISTRY[key];
    expect(SETTING_CATEGORIES).toContain(definition.category);
    expect(APPLIES_WHEN).toContain(definition.appliesWhen);
  });

  it.each(SETTING_KEYS)("%s declares sensitive and irreversible as booleans", (key) => {
    const definition = SETTINGS_REGISTRY[key];
    expect(typeof definition.sensitive).toBe("boolean");
    expect(typeof definition.irreversible).toBe("boolean");
  });

  it("marks every irreversible setting sensitive too", () => {
    // §17.8: irreversible is "everything sensitive does, plus…". One that
    // was irreversible but not sensitive would skip the confirmation and
    // the distinct audit event while being the most destructive kind.
    for (const key of SETTING_KEYS) {
      const definition = SETTINGS_REGISTRY[key];
      if (definition.irreversible) {
        expect(definition.sensitive, `${key} is irreversible but not sensitive`).toBe(true);
      }
    }
  });

  it("marks the five enforcement-relaxing settings sensitive (§17.8)", () => {
    // Named individually rather than counted, so adding a sensitive key
    // does not silently satisfy this while one of these five loses its flag.
    for (const key of [
      "items.default_merge_authority",
      "budget.enabled",
      "notify.doc",
      "liveness.dead_after_seconds",
      "dispatch.resume_attempts_before_blocked",
      "retention.tool_calls_days",
    ] as const) {
      expect(SETTINGS_REGISTRY[key].sensitive, key).toBe(true);
    }
  });

  it("gives retention a floor in its own schema rather than only in the job", () => {
    // §17.8: the floor is "the cheap half" of breaking the
    // irreversible-plus-unauthenticated combination. A schema that accepts
    // 1 would leave the whole guarantee to the consuming job.
    const schema = SETTINGS_REGISTRY["retention.tool_calls_days"].schema;
    expect(schema.safeParse(1).success).toBe(false);
    expect(schema.safeParse(0).success).toBe(false);
    expect(schema.safeParse(-5).success).toBe(false);
    expect(schema.safeParse(365).success).toBe(true);
    expect(schema.safeParse(null).success).toBe(true);
  });

  it("records formerEnv for the keys that had an environment variable", () => {
    // PR #90 derives its retired-variable startup check from these, so an
    // empty formerEnv on a key that had a variable is a silent hole there,
    // not here.
    expect(SETTINGS_REGISTRY["poll.interval_seconds"].formerEnv).toContain("POLL_INTERVAL_SECONDS");
    expect(SETTINGS_REGISTRY["crew.wait_timeout_seconds"].formerEnv).toContain(
      "WAIT_FOR_CREW_TIMEOUT",
    );
    expect(SETTINGS_REGISTRY["notify.doc"].formerEnv).toContain("NOTIFY_DOC");
    expect(SETTINGS_REGISTRY["visual_review.doc"].formerEnv).toContain("VISUAL_REVIEW_DOC");
  });

  it("never lists the same environment variable under two keys", () => {
    // Two keys claiming one variable is unresolvable for #90's check: it
    // cannot say which setting to point the operator at.
    const seen = new Map<string, string>();
    for (const key of SETTING_KEYS) {
      for (const name of SETTINGS_REGISTRY[key].formerEnv) {
        expect(
          seen.get(name),
          `${name} is claimed by ${seen.get(name)} and ${key}`,
        ).toBeUndefined();
        seen.set(name, key);
      }
    }
  });

  it("keeps labels and help distinct, so help is not the label restated", () => {
    for (const key of SETTING_KEYS) {
      const { label, help } = SETTINGS_REGISTRY[key];
      expect(help.trim(), key).not.toBe(label.trim());
    }
  });
});

describe("what the registry does not foreclose", () => {
  it("declares no hook protocol version, which is a build constant", () => {
    // §17.6. The versions are per variant (HTTP and command line) and per
    // role (spoken, and oldest accepted), and they describe what this build
    // implements — a value that can be set to something the build does not
    // implement produces a system refusing everything for a reason nobody
    // can act on. A later per-variant map must be free to land as a
    // constant without colliding with a key declared here.
    //
    // This is narrower than "no key mentions hook at all": MILESTONES.md
    // #41 adds `hook.allow_patterns` / `hook.ask_patterns`, which are
    // ordinary, deliberately-configurable pattern lists — the opposite of a
    // protocol version, which §17.6 is explicit must NOT be configurable.
    // What stays foreclosed here is a key that is actually about protocol
    // versioning, however it might be spelled.
    for (const key of SETTING_KEYS) {
      expect(key.toLowerCase()).not.toContain("protocol");
      expect(key.toLowerCase()).not.toMatch(/hook[._]?version/);
    }
  });

  it("declares no key for installation-owned entity data", () => {
    // §17.7: repos, areas, machines, accounts and people are entities with
    // their own surface. A registry key for one is what turns the registry
    // into the generic map §17.5 rejects.
    for (const key of SETTING_KEYS) {
      const prefix = key.slice(0, key.indexOf("."));
      expect(["repos", "areas", "machines", "accounts", "people"]).not.toContain(prefix);
    }
  });
});
