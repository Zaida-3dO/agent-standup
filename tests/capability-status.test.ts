// The read side of `capability_checks` (`src/lib/settings/capability-status.ts`)
// — SCHEMA.md §17.5's "show it as unverified on `/settings`".
//
// **Why this file exists.** The sweep has always computed whether a
// capability document could be found and written the answer to
// `capability_checks`; nothing read that table, so the finding was
// detected, stored and invisible. These cases pin the reading, and in
// particular pin the two distinctions the whole thing exists for:
// `unverified` is not `verified`, and `unverified` is not `missing`.
//
// Pure — `renderCapability` takes the value and the row and returns the
// reading, so no database and no filesystem. Every fixture is invented;
// this repository is public (CLAUDE.md).
import { describe, expect, it } from "vitest";
import {
  CAPABILITY_SETTING_KEYS,
  renderCapabilities,
  renderCapability,
} from "@/lib/settings/capability-status";

const CHECKED_AT = new Date("1970-01-02T03:04:05.000Z");

/** A recorded sweep finding. */
function check(path: string, result: "exists" | "missing" | "unverified") {
  return { key: "notify.doc", path, result, lastCheckedAt: CHECKED_AT } as const;
}

describe("a capability that is not configured", () => {
  it("reads as `off` rather than as a failure", () => {
    // §17.2: null means the capability is off. That is an intended state,
    // not a broken one, and must not be reported as though somebody
    // misconfigured something.
    const rendered = renderCapability("notify.doc", null, undefined);

    expect(rendered.status).toBe("off");
    expect(rendered.value).toBeNull();
    expect(rendered.lastCheckedAt).toBeNull();
  });

  it("says a gate depending on it will refuse, and names the key to set", () => {
    const rendered = renderCapability("visual_review.doc", null, undefined);

    expect(rendered.detail).toContain("visual_review.doc");
    expect(rendered.detail).toContain("refuse");
  });

  it("ignores a stale check row for a capability since turned off", () => {
    // The setting is null now; whatever a sweep found before is not a fact
    // about the current configuration.
    const rendered = renderCapability("notify.doc", null, check("/old/doc.md", "exists"));

    expect(rendered.status).toBe("off");
    expect(rendered.checkedPath).toBeNull();
  });
});

describe("a capability that is set but never swept", () => {
  it("reads as `unverified`, not as verified", () => {
    // The failure this module exists to fix: before it, "set" and "set and
    // working" were the same observable state. A value with no check behind
    // it must never read as a pass.
    const rendered = renderCapability("notify.doc", "/docs/notify.md", undefined);

    expect(rendered.status).toBe("unverified");
    expect(rendered.value).toBe("/docs/notify.md");
    expect(rendered.lastCheckedAt).toBeNull();
  });

  it("says plainly that being set is not evidence anything can read it", () => {
    const rendered = renderCapability("notify.doc", "/docs/notify.md", undefined);

    expect(rendered.detail).toContain("does not read this document");
  });
});

describe("a capability the sweep could check", () => {
  it("reads as `verified` when the document was found", () => {
    const rendered = renderCapability("notify.doc", "/docs/notify.md", {
      ...check("/docs/notify.md", "exists"),
    });

    expect(rendered.status).toBe("verified");
    expect(rendered.checkedPath).toBe("/docs/notify.md");
    expect(rendered.lastCheckedAt).toBe(CHECKED_AT.toISOString());
    expect(rendered.staleCheck).toBe(false);
  });

  it("reads as `missing` when the sweep looked and found nothing", () => {
    // Configured, and known to be wrong — the case where a gate would
    // otherwise open on a pointer to nothing.
    const rendered = renderCapability("notify.doc", "/gone/notify.md", {
      ...check("/gone/notify.md", "missing"),
    });

    expect(rendered.status).toBe("missing");
    expect(rendered.detail).toContain("did not find it");
  });

  it("keeps `missing` and `unverified` apart, because they call for opposite responses", () => {
    // The distinction is the point: `missing` is a setting to fix,
    // `unverified` may be entirely correct. Collapsing them into "not
    // verified" would either cry wolf about every URL or hide every broken
    // path.
    const missing = renderCapability("notify.doc", "/gone.md", { ...check("/gone.md", "missing") });
    const unverified = renderCapability("notify.doc", "https://example.test/d.md", {
      ...check("https://example.test/d.md", "unverified"),
    });

    expect(missing.status).not.toBe(unverified.status);
    expect(unverified.status).toBe("unverified");
  });

  it("explains that an unverified reading may be entirely correct", () => {
    // A path resolving on the agent's machine and not the server's is the
    // *expected* case for a capability the server never performs itself, so
    // the message must not read as an error.
    const rendered = renderCapability("visual_review.doc", "https://example.test/review.md", {
      ...check("https://example.test/review.md", "unverified"),
    });

    expect(rendered.status).toBe("unverified");
    expect(rendered.detail).toContain("may be entirely correct");
  });
});

describe("a check recorded against a path the setting does not hold", () => {
  const rendered = renderCapability("notify.doc", "/new/notify.md", {
    ...check("/old/notify.md", "exists"),
  });

  it("is flagged as stale rather than credited to the current value", () => {
    // A `verified` badge against a path nobody uses any more is worse than
    // no badge: it reports a pass for a document that was never checked.
    expect(rendered.staleCheck).toBe(true);
    expect(rendered.status).toBe("unverified");
  });

  it("carries both paths, so the disagreement is visible", () => {
    expect(rendered.value).toBe("/new/notify.md");
    expect(rendered.checkedPath).toBe("/old/notify.md");
  });

  it("does not credit a stale `missing` check either", () => {
    // Symmetry: an old failure about an old path must not condemn a new one.
    const staleMissing = renderCapability("notify.doc", "/new.md", {
      ...check("/old.md", "missing"),
    });

    expect(staleMissing.status).toBe("unverified");
    expect(staleMissing.staleCheck).toBe(true);
  });
});

describe("renderCapabilities", () => {
  it("reports every declared capability, including the ones that are off", () => {
    const rendered = renderCapabilities({}, new Map());

    expect(rendered.map((entry) => entry.key)).toEqual([...CAPABILITY_SETTING_KEYS]);
    expect(rendered.every((entry) => entry.status === "off")).toBe(true);
  });

  it("matches each capability to its own check row", () => {
    const rendered = renderCapabilities(
      { "notify.doc": "/n.md", "visual_review.doc": "/v.md" },
      new Map([
        [
          "notify.doc",
          {
            key: "notify.doc",
            path: "/n.md",
            result: "exists",
            lastCheckedAt: CHECKED_AT,
          } as const,
        ],
        [
          "visual_review.doc",
          {
            key: "visual_review.doc",
            path: "/v.md",
            result: "missing",
            lastCheckedAt: CHECKED_AT,
          } as const,
        ],
      ]),
    );

    // A crossed lookup would make a broken capability read as working.
    expect(rendered.find((entry) => entry.key === "notify.doc")?.status).toBe("verified");
    expect(rendered.find((entry) => entry.key === "visual_review.doc")?.status).toBe("missing");
  });

  it("treats a non-string stored value as off rather than trusting it", () => {
    // The registry schema should make this unreachable; if a value ever
    // arrives as something else, "off" fails closed where passing it through
    // would put a non-path into a gate's hands.
    const rendered = renderCapabilities({ "notify.doc": 42 }, new Map());

    expect(rendered.find((entry) => entry.key === "notify.doc")?.status).toBe("off");
  });
});
