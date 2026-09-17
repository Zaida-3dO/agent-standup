// The link URL validator — the security boundary, tested directly.
//
// This is the one module in the links feature whose failure is a
// vulnerability rather than a bug: its value is rendered as a clickable
// `href`, so a scheme that gets past it executes on whoever opens the item.
// So the rejections are the substance of this file, and each one names,
// above it, the single source change that would make it pass wrongly. A
// guard that never refuses anything passes a happy-path suite and protects
// nothing.
//
// No database: everything here is pure.
import { describe, expect, it } from "vitest";
import {
  LINK_URL_MAX_CHARS,
  REFUSED_URL_SCHEMES,
  refuseLinkUrl,
  schemeOf,
} from "@/lib/service/items/link-url";

describe("schemeOf", () => {
  it("reads the scheme up to the first colon", () => {
    expect(schemeOf("https://example.test/a")).toBe("https");
    expect(schemeOf("coda://docs/d1/rows/r1")).toBe("coda");
    expect(schemeOf("mailto:someone@example.test")).toBe("mailto");
  });

  // Would pass wrongly if `indexOf(":")` became `lastIndexOf(":")`: the
  // scheme would then be read as `https://example.test` for this value,
  // which matches nothing on the denylist — so a `javascript:` URL carrying
  // a later colon would be waved through.
  it("uses the FIRST colon, so a later one does not extend the scheme", () => {
    expect(schemeOf("https://example.test:8443/a")).toBe("https");
    expect(schemeOf("javascript:void(0):x")).toBe("javascript");
  });

  it("lowercases, so case cannot spell around the denylist", () => {
    expect(schemeOf("JavaScript:alert(1)")).toBe("javascript");
    expect(schemeOf("JAVASCRIPT:alert(1)")).toBe("javascript");
  });

  // Browsers strip these characters when resolving a URL, so each of these
  // navigates exactly as `javascript:` does — a raw string comparison sees
  // `java\tscript` instead, finds it absent from the denylist, and stores a
  // live XSS vector while reporting success.
  it("strips the whitespace and control characters a URL parser ignores", () => {
    expect(schemeOf("java\tscript:alert(1)")).toBe("javascript");
    expect(schemeOf("java\nscript:alert(1)")).toBe("javascript");
    expect(schemeOf("java\rscript:alert(1)")).toBe("javascript");
    expect(schemeOf(" javascript:alert(1)")).toBe("javascript");
    expect(schemeOf("java\u0000script:alert(1)")).toBe("javascript");
  });

  // **This case is why the strip happens BEFORE the decode as well as
  // after, and it is the only one that proves it.**
  //
  // Hand-mutation found that deleting the pre-decode strip left every case
  // above still passing: the post-decode strip removes a bare control
  // character just as well, so those cases exercise a redundant path and
  // cannot tell the two strips apart. A test that cannot fail is not
  // coverage, so the discriminating input is pinned here instead.
  //
  // Splitting a percent escape with an ignored character is a real evasion:
  // `%<tab>73` is not a valid escape and survives `decodeURIComponent`
  // untouched, so a post-decode strip alone yields `java%73cript` and finds
  // nothing on the denylist. Stripping first rejoins it into `%73`, which
  // decodes to `s` and reveals `javascript`. Remove the pre-decode strip
  // and this assertion fails, which is exactly what it is here for.
  it("rejoins a percent escape that an ignored character was used to split", () => {
    expect(schemeOf("java%	73cript:alert(1)")).toBe("javascript");
    expect(refuseLinkUrl("java%	73cript:alert(1)")).not.toBeNull();
  });

  // Would pass wrongly if the `decodeURIComponent` step were removed.
  it("percent-decodes the scheme before comparing", () => {
    expect(schemeOf("java%73cript:alert(1)")).toBe("javascript");
    // A percent escape that itself encodes an ignored character — which is
    // why the strip is applied again AFTER decoding rather than only before.
    expect(schemeOf("java%09script:alert(1)")).toBe("javascript");
  });

  it("returns null when there is no scheme at all", () => {
    expect(schemeOf("/items/abc")).toBeNull();
    expect(schemeOf("just some prose")).toBeNull();
    expect(schemeOf("")).toBeNull();
  });

  // A malformed escape makes `decodeURIComponent` throw. The guarded decode
  // is what turns that into a value this still judges, rather than a crash.
  it("does not throw on a malformed percent escape", () => {
    expect(() => schemeOf("ht%zztp://example.test")).not.toThrow();
    expect(schemeOf("ht%zztp://example.test")).toBe("ht%zztp");
  });
});

describe("refuseLinkUrl — what it refuses", () => {
  // The whole point of the module. Each of these would pass wrongly if
  // `REFUSED_URL_SCHEMES.includes(scheme)` were inverted or removed.
  it("refuses every executable scheme, however it is spelled", () => {
    const attacks = [
      "javascript:alert(1)",
      "JavaScript:alert(1)",
      "JAVASCRIPT:alert(document.cookie)",
      " javascript:alert(1)",
      "java\tscript:alert(1)",
      "java\nscript:alert(1)",
      "java%73cript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "DATA:text/html;base64,PHNjcmlwdD4=",
      "vbscript:msgbox(1)",
      "VBScript:msgbox(1)",
    ];
    for (const url of attacks) {
      expect(refuseLinkUrl(url), `expected to refuse: ${url}`).not.toBeNull();
    }
  });

  it("names the scheme it refused, so the caller knows which rule bit", () => {
    expect(refuseLinkUrl("javascript:alert(1)")).toContain("javascript");
    expect(refuseLinkUrl("data:text/html,x")).toContain("data");
  });

  // Would pass wrongly if the scheme-present check were dropped: a relative
  // reference would then be stored and rendered as an href resolving against
  // the board's own origin, which points at the wrong thing entirely.
  it("refuses a value with no scheme", () => {
    expect(refuseLinkUrl("/items/abc")).not.toBeNull();
    expect(refuseLinkUrl("example.test/a")).not.toBeNull();
    expect(refuseLinkUrl("just some prose")).not.toBeNull();
  });

  it("refuses an empty or whitespace-only value", () => {
    expect(refuseLinkUrl("")).not.toBeNull();
    expect(refuseLinkUrl("   ")).not.toBeNull();
  });

  it("refuses a scheme with nothing after it", () => {
    expect(refuseLinkUrl("https:")).not.toBeNull();
    expect(refuseLinkUrl("coda:  ")).not.toBeNull();
  });

  // Would pass wrongly if the length check were removed or its comparison
  // flipped — the boundary is asserted on both sides so an off-by-one is
  // visible rather than absorbed.
  it("refuses a URL longer than the bound, and accepts one exactly at it", () => {
    const atLimit = `https://example.test/${"a".repeat(LINK_URL_MAX_CHARS - 21)}`;
    expect(atLimit).toHaveLength(LINK_URL_MAX_CHARS);
    expect(refuseLinkUrl(atLimit)).toBeNull();
    expect(refuseLinkUrl(`${atLimit}a`)).not.toBeNull();
  });
});

describe("refuseLinkUrl — what it must NOT refuse", () => {
  // The measured reason this is a denylist rather than an allowlist. An
  // http(s) rule rejects 30 of 35 document references in the motivating
  // corpus, which are `coda://` resource URIs — the feature would refuse
  // the majority of the links it exists to hold.
  //
  // This case would fail the moment anyone "hardens" the module into an
  // allowlist, which is exactly the regression it is here to catch.
  it("accepts a non-http resource URI", () => {
    expect(refuseLinkUrl("coda://docs/doc-1/rows/row-1")).toBeNull();
    expect(refuseLinkUrl("coda://docs/doc-1/tables/t1/rows/r1")).toBeNull();
  });

  it("accepts the ordinary web schemes", () => {
    expect(refuseLinkUrl("https://example.test/a/b?c=d#e")).toBeNull();
    expect(refuseLinkUrl("http://example.test/a")).toBeNull();
  });

  // An installation's own handler cannot be enumerated in advance, which is
  // the second half of the allowlist argument.
  it("accepts application and custom schemes", () => {
    for (const url of [
      "mailto:someone@example.test",
      "slack://channel?team=T1&id=C1",
      "vscode://file/a/b",
      "obsidian://open?vault=v&file=f",
      "notion://page/abc",
      "ftp://example.test/a",
      "some-internal-handler://a/b",
    ]) {
      expect(refuseLinkUrl(url), `expected to accept: ${url}`).toBeNull();
    }
  });
});

describe("REFUSED_URL_SCHEMES", () => {
  // The list is the security policy, so it is asserted directly rather than
  // only through behaviour — a list is the kind of thing that gets "tidied"
  // by someone who does not know why `vbscript` is on it.
  it("is exactly the executable schemes, and is frozen", () => {
    expect([...REFUSED_URL_SCHEMES].sort()).toEqual(["data", "javascript", "vbscript"]);
    expect(Object.isFrozen(REFUSED_URL_SCHEMES)).toBe(true);
  });
});
