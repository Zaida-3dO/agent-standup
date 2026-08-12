// The capability-document schema (`notify.doc`, `visual_review.doc`) —
// SCHEMA.md §17.5: "Well-formed — absolute path or valid URL, no traversal
// | On write | Refuse. Provable from the value alone."
//
// A validator only tested on accepted values proves nothing — every test
// here is a pair, one direction accepted and its opposite refused, so each
// property (absolute-vs-relative, URL-vs-not, traversal-vs-clean) is
// actually exercised on both sides rather than just shown once.
import { describe, expect, it } from "vitest";
import { capabilityDocSchema } from "@/lib/settings/capability-doc";
import { SETTINGS_REGISTRY } from "@/lib/settings/registry";
import { validateSetting } from "@/lib/settings/validate";

describe("capabilityDocSchema — accepted values", () => {
  it("accepts null — the capability is off (§17.2, §17.5)", () => {
    expect(capabilityDocSchema.safeParse(null).success).toBe(true);
  });

  it("accepts a well-formed absolute path", () => {
    const result = capabilityDocSchema.safeParse("/docs/notify.md");
    expect(result.success).toBe(true);
  });

  it("accepts a well-formed URL", () => {
    const result = capabilityDocSchema.safeParse("https://example.com/notify.md");
    expect(result.success).toBe(true);
  });

  it("accepts a URL with a non-http scheme too — the rule is scheme://, not a fixed allowlist", () => {
    expect(capabilityDocSchema.safeParse("s3://bucket/notify.md").success).toBe(true);
  });
});

describe("capabilityDocSchema — refused values, each the opposite of an accepted case above", () => {
  it("refuses a relative path — the opposite of the absolute-path accept case", () => {
    const result = capabilityDocSchema.safeParse("docs/notify.md");
    expect(result.success).toBe(false);
  });

  it('refuses a path containing a ".." traversal segment', () => {
    const result = capabilityDocSchema.safeParse("/docs/../etc/passwd");
    expect(result.success).toBe(false);
  });

  it("refuses a traversal segment even when it does not visibly escape the path", () => {
    // "/a/b/../c" resolves to "/a/c" — still refused, because §17.5 asks for
    // the segment to be absent, not for the resolved path to be safe. A
    // check that normalised first (path.posix.normalize) would silently
    // erase this case rather than catch it.
    expect(capabilityDocSchema.safeParse("/a/b/../c").success).toBe(false);
  });

  it("refuses an empty-but-non-null string — the opposite of the null accept case", () => {
    const result = capabilityDocSchema.safeParse("");
    expect(result.success).toBe(false);
  });

  it("refuses a whitespace-only string", () => {
    expect(capabilityDocSchema.safeParse("   ").success).toBe(false);
  });

  it("refuses a bare scheme-colon string that is not a real URL (e.g. a Windows drive path)", () => {
    // "C:\notes\doc.md" is not absolute-POSIX (does not start with "/") and
    // is not a well-formed "scheme://" URL — it must not be misclassified
    // as either. This is the one JS's own `new URL()` gets wrong on its
    // own (it happily parses "C:\notes" as scheme "c"), which is exactly
    // why isWellFormedUrl requires the "://" rather than trusting `new URL`
    // alone.
    expect(capabilityDocSchema.safeParse("C:\\notes\\doc.md").success).toBe(false);
  });

  it("refuses a string that is neither an absolute path nor a URL at all", () => {
    expect(capabilityDocSchema.safeParse("just some text").success).toBe(false);
  });
});

describe("wired into the registry — notify.doc and visual_review.doc both use this schema", () => {
  it("notify.doc's own schema rejects a relative path via the registry validator", () => {
    const result = validateSetting("notify.doc", "relative/path.md");
    expect(result.ok).toBe(false);
  });

  it("notify.doc's own schema accepts a well-formed absolute path via the registry validator", () => {
    const result = validateSetting("notify.doc", "/docs/notify.md");
    expect(result.ok).toBe(true);
  });

  it("visual_review.doc's own schema rejects a traversal segment via the registry validator", () => {
    const result = validateSetting("visual_review.doc", "/docs/../secrets");
    expect(result.ok).toBe(false);
  });

  it("visual_review.doc's own schema accepts a well-formed URL via the registry validator", () => {
    const result = validateSetting("visual_review.doc", "https://example.com/visual.md");
    expect(result.ok).toBe(true);
  });

  it("both registry entries reference the same schema object — one validator, not two copies", () => {
    // Row #77's whole premise is a single validator per key; this asserts
    // there is exactly one capability-doc schema, reused, rather than two
    // definitions that could independently drift into disagreeing.
    expect(SETTINGS_REGISTRY["notify.doc"].schema).toBe(capabilityDocSchema);
    expect(SETTINGS_REGISTRY["visual_review.doc"].schema).toBe(capabilityDocSchema);
  });
});
