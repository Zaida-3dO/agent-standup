// `src/lib/nav/landing.ts` and the `ui.default_landing` setting.
//
// The pair is the point: the setting's `z.enum` and this module's
// `LANDING_CHOICES` are two lists that must agree, and the whole reason a
// mismatch matters is that the setting would accept a value the consumer
// then silently ignores.
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  DEFAULT_LANDING,
  LANDING_CHOICES,
  isLandingChoice,
  landingRedirectPath,
  landingRoute,
} from "@/lib/nav/landing";
import { NAV_ROUTES } from "@/lib/nav/routes";
import { SETTINGS_REGISTRY } from "@/lib/settings";

describe("ui.default_landing", () => {
  const definition = SETTINGS_REGISTRY["ui.default_landing"];

  it("is a real registry entry, filed under Interface, defaulting to Standup", () => {
    expect(definition).toBeDefined();
    expect(definition.category).toBe("Interface");
    // The resolution: Standup-first as the entry point, projects-first as
    // the organising principle. Changing the default here changes what a
    // fresh installation lands on.
    expect(definition.default).toBe("standup");
  });

  it("accepts every landing choice and refuses anything else", () => {
    for (const choice of LANDING_CHOICES) {
      expect(definition.schema.safeParse(choice).success).toBe(true);
    }
    // Settings and Cost are deliberately NOT landing choices — you go there
    // with a question, and landing there every morning is a configuration
    // mistake the reader has to undo before starting.
    expect(definition.schema.safeParse("settings").success).toBe(false);
    expect(definition.schema.safeParse("/board").success).toBe(false);
    expect(definition.schema.safeParse("").success).toBe(false);
  });

  it("declares exactly the same options as the consuming module", () => {
    // The two lists drifting apart is the defect this catches: the setting
    // would accept a value `landingRoute` then falls back from, so the
    // preference would appear saved and do nothing. Adding a fifth value to
    // either list alone fails here.
    const enumOptions = (definition.schema as z.ZodEnum<[string, ...string[]]>).options;
    expect([...enumOptions].sort()).toEqual([...LANDING_CHOICES].sort());
  });
});

describe("landingRoute", () => {
  it("resolves every declared choice to a real destination in the route map", () => {
    for (const choice of LANDING_CHOICES) {
      const route = landingRoute(choice);
      expect(route.id).toBe(choice);
      expect(NAV_ROUTES).toContain(route);
    }
  });

  it("falls back to the default for anything unrecognised", () => {
    // This runs on the one route with no way out — a reader who cannot
    // render `/` cannot navigate anywhere, because the sidebar is inside
    // the page that failed. Throwing here would be a blank app.
    for (const junk of [undefined, null, "", "nope", 7, {}]) {
      expect(landingRoute(junk).id).toBe(DEFAULT_LANDING);
    }
  });
});

describe("landingRedirectPath", () => {
  it("returns null for Standup — it lives AT the root and renders in place", () => {
    // Redirecting `/` to `/` is an infinite bounce; returning null is what
    // makes the default case cost no navigation at all.
    expect(landingRedirectPath("standup")).toBeNull();
    expect(landingRedirectPath(undefined)).toBeNull();
  });

  it("returns the destination's own path for every other choice", () => {
    expect(landingRedirectPath("projects")).toBe("/projects");
    expect(landingRedirectPath("board")).toBe("/board");
    expect(landingRedirectPath("needs-you")).toBe("/needs-you");
  });
});

describe("isLandingChoice", () => {
  it("narrows only the four names", () => {
    expect(isLandingChoice("board")).toBe(true);
    expect(isLandingChoice("settings")).toBe(false);
    expect(isLandingChoice(null)).toBe(false);
  });
});
