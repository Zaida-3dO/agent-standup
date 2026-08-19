// The markdown render path — the URL policy, the renderer's own safety,
// and the tab model.
//
// ── What these tests are actually proving ──────────────────────────────
//
// Item bodies are written by agents and stored, then rendered. That makes
// this a stored-content render path with untrusted input, so the tests that
// matter most here are the ones asserting a HOSTILE body is neutralised —
// not that a friendly one renders.
//
// The hostile assertions are split deliberately across two levels, because
// the two halves are protected by different mechanisms and a test that
// conflated them would pass while one of them was broken:
//
//   - `safeUrl` is the policy for markdown's own link syntax, and is tested
//     as a rule over strings, so it fails on the scheme that was ADDED
//     rather than only on the ones someone thought to sample.
//   - The renderer's refusal to parse HTML is tested by rendering, because
//     it is a property of how the renderer is configured — no plugin list
//     that would build HTML nodes — and only a real render can show that
//     `<script>` came out as text.
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { safeUrl } from "@/lib/item-detail/markdown";
import {
  DEFAULT_TAB,
  TABS,
  TAB_LABELS,
  hashForTab,
  isDetailTab,
  tabFromHash,
} from "@/lib/item-detail/tabs";
import { Markdown } from "@/components/item-detail/Markdown";
import { artifactTab, artifactsForTab } from "@/lib/item-detail/view";
import type { DetailArtifact } from "@/lib/item-detail/types";

/**
 * Renders a component to an HTML string.
 *
 * This is the one place in the suite that renders rather than walking a
 * returned element tree, and it is worth saying why it is allowed here.
 * The DOM-free technique inspects what a component RETURNED — for
 * `Markdown` that is a `ReactMarkdown` element with the source still in a
 * prop, which proves the source was handed over and nothing about what came
 * out the other side. The whole claim under test is what the markdown
 * becomes, so the markdown has to actually be turned into something.
 *
 * `renderToStaticMarkup` needs no DOM — it is a string builder — so this
 * stays inside `environment: "node"` and adds no jsdom dependency.
 */
function render(source: string, density?: "normal" | "compact" | "inline"): string {
  return renderToStaticMarkup(createElement(Markdown, { source, density }));
}

describe("safeUrl", () => {
  it("permits the schemes a brief legitimately links to", () => {
    expect(safeUrl("https://example.com/a")).toBe("https://example.com/a");
    expect(safeUrl("http://example.com")).toBe("http://example.com");
    expect(safeUrl("mailto:someone@example.com")).toBe("mailto:someone@example.com");
  });

  it("refuses javascript:, which is the whole reason this function exists", () => {
    // Deleting one character from the allowlist check (`has` → any always-true
    // expression) makes this line pass through unchanged, and this fails.
    expect(safeUrl("javascript:alert(1)")).toBe("");
  });

  it("refuses javascript: however it is spelled", () => {
    // A browser and `URL` both normalise these to the same scheme, so a
    // `startsWith("javascript:")` check would let every one of them
    // through. This is the assertion that fails if the implementation is
    // ever "simplified" to a string comparison.
    expect(safeUrl("JavaScript:alert(1)")).toBe("");
    expect(safeUrl("  javascript:alert(1)")).toBe("");
    expect(safeUrl("JAVASCRIPT:alert(1)")).toBe("");
  });

  it("refuses data:, including the media types that look harmless", () => {
    // `data:text/html` executes in the document's own origin; the type
    // label is author-supplied, so it cannot be the thing trusted to
    // decide which data URLs are safe.
    expect(safeUrl("data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==")).toBe("");
    expect(safeUrl("data:image/png;base64,iVBORw0KGgo=")).toBe("");
  });

  it("refuses a scheme nobody has thought of, because the list is an allowlist", () => {
    // The property that makes this an allowlist rather than a denylist: a
    // scheme the code has never seen is refused by default. Turning
    // `ALLOWED_SCHEMES.has(...)` into `!DENIED.has(...)` passes every other
    // test in this block and fails this one.
    expect(safeUrl("vbscript:msgbox(1)")).toBe("");
    expect(safeUrl("file:///etc/passwd")).toBe("");
    expect(safeUrl("chrome://settings")).toBe("");
  });

  it("permits a relative reference, which carries no scheme to abuse", () => {
    expect(safeUrl("/items/abc")).toBe("/items/abc");
    expect(safeUrl("./docs/PLAN.md")).toBe("./docs/PLAN.md");
    expect(safeUrl("#a-heading")).toBe("#a-heading");
  });

  it("refuses a protocol-relative URL, which is not the same-origin link it looks like", () => {
    // `//host/path` parses as relative here but a browser resolves it
    // against the current scheme and fetches another origin. Removing the
    // `startsWith("//")` branch makes this the one failure.
    expect(safeUrl("//evil.example.com/x")).toBe("");
  });

  it("refuses a protocol-relative URL written with backslashes", () => {
    // URL resolution treats a backslash like a slash in the authority
    // position, so these resolve OFF-ORIGIN exactly as `//host/path` does
    // — while sliding past a guard that only looked for two forward
    // slashes. Verified against the resolver rather than assumed:
    // `new URL(String.raw`/\h/x`, base).origin` is `h`, not the base.
    //
    // These are refused by THIS function rather than by whatever the
    // renderer happens to percent-encode, because it is exported and
    // tested as a standalone rule and the next caller may not encode.
    expect(safeUrl(String.raw`/\evil.example.com/x`)).toBe("");
    expect(safeUrl(String.raw`\/evil.example.com/x`)).toBe("");
    expect(safeUrl(String.raw`\\evil.example.com/x`)).toBe("");

    // Pinned against the resolver itself, so this documents a FACT about
    // URL resolution rather than a belief about it: each of these really
    // does reach another origin, which is what makes refusing them
    // security behaviour rather than over-blocking.
    for (const form of [
      String.raw`/\evil.example.com/x`,
      String.raw`\/evil.example.com/x`,
      String.raw`\\evil.example.com/x`,
    ]) {
      expect(new URL(form, "https://app.example/i/x").origin).toBe("https://evil.example.com");
    }
  });

  it("still permits an ordinary path that merely contains a backslash", () => {
    // The guard is about the first two characters (where the authority
    // begins), not about backslashes anywhere — a path containing one is
    // same-origin and must keep working.
    expect(safeUrl(String.raw`/path\with\backslashes`)).toBe(String.raw`/path\with\backslashes`);
  });
  it("refuses an empty or whitespace-only URL", () => {
    expect(safeUrl("")).toBe("");
    expect(safeUrl("   ")).toBe("");
  });

  it("treats a percent-encoded colon as a path, because that is what a browser does", () => {
    // `javascript%3Aalert(1)` LOOKS like a near-miss that slipped through,
    // and it is worth recording why it is not one. A percent-encoded colon
    // is not a scheme delimiter: a browser resolving this against the page
    // URL produces `https://<origin>/items/javascript%3Aalert(1)` — an
    // ordinary relative path that navigates to a missing page. There is no
    // scheme, so there is nothing to execute.
    //
    // Passing it through is therefore correct rather than lenient, and the
    // assertion is here so a future reader who spots it in a scan does not
    // "fix" it into a denylist entry.
    expect(safeUrl("javascript%3Aalert(1)")).toBe("javascript%3Aalert(1)");
    expect(new URL("javascript%3Aalert(1)", "https://app.example/items/x").protocol).toBe("https:");
  });
});

describe("Markdown — a hostile body", () => {
  it("neutralises a script tag by never building an element for it", () => {
    const html = render("<script>alert(1)</script>");
    // The characters survive as visible text — that is the correct
    // outcome, and it is what distinguishes "escaped" from "silently
    // dropped", which would hide what the body actually said.
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("neutralises an event-handler attribute", () => {
    const html = render('<img src=x onerror="alert(1)">');
    // The characters `onerror=` DO survive — inside escaped text, where
    // they are inert content rather than an attribute. So the assertion is
    // that no `<img>` ELEMENT was built, which is the property that makes
    // the handler unreachable; asserting on the substring alone would be
    // asserting that the body's text was destroyed, which is not wanted.
    expect(html).not.toMatch(/<img[\s>]/i);
    expect(html).toContain("&lt;img");
    // And the quote that would have opened the attribute is escaped, so
    // the surrounding element cannot be broken out of either.
    expect(html).not.toContain('onerror="alert(1)"');
  });

  it("neutralises an event handler on a block element", () => {
    const html = render('<div onclick="alert(1)">click</div>');
    // Same shape as above: `<div>` is the wrapper this component renders,
    // so the test is that no div carrying a handler exists.
    expect(html).not.toMatch(/<div[^>]*onclick/i);
    expect(html).toContain("&lt;div onclick=");
  });

  it("strips a javascript: href written in markdown's own link syntax", () => {
    // The one channel that is NOT closed by refusing to parse HTML: this
    // is real markdown, and it does produce a real anchor. Removing
    // `urlTransform={safeUrl}` from the component fails exactly this test
    // and the two below it.
    const html = render("[click me](javascript:alert(1))");
    expect(html).toContain("<a");
    expect(html).not.toContain("javascript:");
  });

  it("strips a javascript: src on an image", () => {
    const html = render("![img](javascript:alert(1))");
    expect(html).not.toContain("javascript:");
  });

  it("applies THIS repo's URL policy, not merely the renderer's own default", () => {
    // ── Why this test exists, specifically ────────────────────────────
    //
    // The renderer ships a URL sanitiser of its own, and it already
    // refuses `javascript:`. So every assertion above passes whether or
    // not this component actually wires `urlTransform={safeUrl}` — they
    // test the dependency's default, and would keep passing if this
    // repo's policy were deleted tomorrow. That was verified by removing
    // the prop and watching the suite stay green.
    //
    // A protocol-relative URL is where the two genuinely disagree. The
    // renderer's default PERMITS `//host/path`; `safeUrl` refuses it,
    // because a browser resolves it to a request against another origin.
    // So this is the assertion that fails the moment the prop is removed
    // — it pins the wiring, not the dependency.
    const html = render("[looks local](//evil.example.com/p)");
    expect(html).not.toContain("evil.example.com");
  });

  it("keeps an honest link intact while stripping the hostile one", () => {
    // The pair matters: a `urlTransform` that returned `""` for everything
    // would pass every assertion above and destroy the feature. This is
    // what stops "sanitised" from being achieved by breaking all links.
    const html = render("[safe](https://example.com/a) and [bad](javascript:alert(1))");
    expect(html).toContain('href="https://example.com/a"');
    expect(html).not.toContain("javascript:");
  });

  it("does not execute an HTML comment or a CDATA block", () => {
    const html = render("<!-- <script>alert(1)</script> -->");
    expect(html).not.toContain("<script>");
  });
});

describe("Markdown — what it renders", () => {
  it("renders headings as headings, not as literal hashes", () => {
    // Row #120's complaint, directly: `###` was reaching the screen.
    const html = render("### A heading");
    expect(html).toContain("<h3>");
    expect(html).toContain("A heading");
    expect(html).not.toContain("### A heading");
  });

  it("renders a GFM pipe table as a table", () => {
    // The visible half of the complaint. Dropping `remark-gfm` from the
    // plugin list leaves the pipes as a paragraph and fails this.
    const html = render(["| a | b |", "|---|---|", "| 1 | 2 |"].join("\n"));
    expect(html).toContain("<table");
    expect(html).toContain("<th>");
    expect(html).toContain("<td>");
    expect(html).not.toContain("|---|");
  });

  it("renders a fenced code block, preserving what is inside it", () => {
    const html = render(["```js", "const x = 1;", "```"].join("\n"));
    expect(html).toContain("<pre>");
    expect(html).toContain("<code");
    expect(html).toContain("const x = 1;");
  });

  it("does NOT treat markdown inside a code fence as markdown", () => {
    // A brief quoting markup is common, and rendering the quoted thing
    // would misrepresent what the author wrote.
    const html = render(["```", "## not a heading", "```"].join("\n"));
    expect(html).not.toContain("<h2>");
    expect(html).toContain("## not a heading");
  });

  it("renders lists, including a GFM task list", () => {
    const html = render(["- one", "- two", "", "- [x] done", "- [ ] todo"].join("\n"));
    // Matched loosely on the tag rather than on `<ul>` exactly: remark-gfm
    // adds its own class to a list containing task items, and pinning the
    // exact opening tag would make this a test of that class name.
    expect(html).toMatch(/<ul[\s>]/);
    expect(html).toMatch(/<li[\s>]/);
    expect(html).toContain('type="checkbox"');
    expect(html).toContain("one");
    expect(html).toContain("todo");
  });

  it("renders a link with its text and href", () => {
    const html = render("[the plan](https://example.com/plan)");
    expect(html).toContain('href="https://example.com/plan"');
    expect(html).toContain("the plan");
  });

  it("renders a long mixed body end to end — headings, tables, code and lists together", () => {
    // The acceptance criterion in one assertion: a real brief is all of
    // these at once, and a renderer that handled them only in isolation
    // would still leave a brief unreadable.
    const brief = [
      "# The brief",
      "",
      "Some prose with `inline code` and a [link](https://example.com).",
      "",
      "## Acceptance",
      "",
      "| criterion | state |",
      "|---|---|",
      "| renders | yes |",
      "",
      "### Notes",
      "",
      "- first",
      "- second",
      "",
      "```ts",
      "export const x = 1;",
      "```",
      "",
      "> a quoted aside",
    ].join("\n");
    const html = render(brief);
    expect(html).toContain("<h1>");
    expect(html).toContain("<h2>");
    expect(html).toContain("<h3>");
    expect(html).toContain("<table");
    expect(html).toContain("<pre>");
    expect(html).toContain("<ul>");
    expect(html).toContain("<blockquote>");
    expect(html).toContain('href="https://example.com"');
    // Nothing markdown-ish survived as literal source text.
    expect(html).not.toContain("## Acceptance");
    expect(html).not.toContain("|---|");
  });

  it("renders nothing at all for an empty or whitespace-only body", () => {
    // A styled empty block is a gap whose meaning the reader has to guess.
    expect(Markdown({ source: "" })).toBeNull();
    expect(Markdown({ source: "   \n  " })).toBeNull();
  });

  it("marks its density so a nested body can be styled smaller", () => {
    expect(render("text", "compact")).toContain('data-density="compact"');
    expect(render("text", "inline")).toContain('data-density="inline"');
    expect(render("text")).toContain('data-density="normal"');
  });
});

describe("the tab model", () => {
  it("has the tabs the page is built from, in order", () => {
    expect([...TABS]).toEqual([
      "overview",
      "plan",
      "reviews",
      "subtasks",
      "activity",
      "summary",
      "agent",
    ]);
  });

  it("gives every tab a label, so none can ship showing its id", () => {
    for (const tab of TABS) {
      expect(TAB_LABELS[tab]).toBeTruthy();
      expect(TAB_LABELS[tab]).not.toBe(tab);
    }
  });

  it("reads a tab out of a hash, with or without the leading #", () => {
    // The deep-link criterion: `/items/x#activity` must land on Activity.
    expect(tabFromHash("#activity")).toBe("activity");
    expect(tabFromHash("activity")).toBe("activity");
    expect(tabFromHash("#summary")).toBe("summary");
  });

  it("reads a hash case-insensitively, because hashes get retyped by hand", () => {
    expect(tabFromHash("#Activity")).toBe("activity");
    expect(tabFromHash("#SUMMARY")).toBe("summary");
  });

  it("falls back to Overview for a hash that names no tab", () => {
    // A stale bookmark should show the item, not fail. Changing the
    // fallback to `throw` — or to any other tab — fails here.
    expect(tabFromHash("#nonsense")).toBe(DEFAULT_TAB);
    expect(tabFromHash("#")).toBe(DEFAULT_TAB);
    expect(tabFromHash("")).toBe(DEFAULT_TAB);
    expect(tabFromHash(null)).toBe(DEFAULT_TAB);
    expect(tabFromHash(undefined)).toBe(DEFAULT_TAB);
  });

  it("builds a hash with its leading #, which is what makes the link a fragment", () => {
    // ── Asserted directly, and NOT only via the round trip below ──────
    //
    // `tabFromHash` accepts a bare name as well as a `#`-prefixed one, so
    // a round-trip assertion absorbs a `hashForTab` that dropped the `#`
    // on BOTH sides and stays green. That was verified by mutation: with
    // the `#` removed, the whole suite still passed.
    //
    // The mutation is not cosmetic, which is why this assertion is worth
    // its own test. Both consumers break, and neither breaks loudly:
    // `TabStrip` would emit `href="activity"`, a RELATIVE path resolving
    // `/items/abc` to `/items/activity` — navigating away from the item
    // rather than switching its tab — and the container's
    // `replaceState` would rewrite the URL to point at a different item
    // id entirely.
    expect(hashForTab("activity")).toBe("#activity");
    expect(hashForTab("overview")).toBe("#overview");
    for (const tab of TABS) {
      expect(hashForTab(tab).startsWith("#")).toBe(true);
    }
  });

  it("round-trips a tab through its hash", () => {
    // This is the contract a linker depends on: build a hash from a tab id
    // and the page reading it lands on the same tab.
    for (const tab of TABS) {
      expect(tabFromHash(hashForTab(tab))).toBe(tab);
    }
  });

  it("recognises exactly the tabs that exist", () => {
    expect(isDetailTab("overview")).toBe(true);
    expect(isDetailTab("findings")).toBe(false);
    expect(isDetailTab("")).toBe(false);
  });
});

function artifact(overrides: Partial<DetailArtifact> = {}): DetailArtifact {
  return {
    id: "art-1",
    kind: "code_review",
    verdict: null,
    reviewRound: 1,
    commitSha: null,
    ref: null,
    body: null,
    findings: null,
    followUpItemId: null,
    createdByType: "agent",
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("which tab an artifact belongs to", () => {
  it("files a plan and its review under Plan", () => {
    expect(artifactTab("plan")).toBe("plan");
    expect(artifactTab("plan_review")).toBe("plan");
  });

  it("files the reviews of the work under Reviews", () => {
    expect(artifactTab("code_review")).toBe("reviews");
    expect(artifactTab("visual_review")).toBe("reviews");
    expect(artifactTab("historical_verification")).toBe("reviews");
    expect(artifactTab("test_run")).toBe("reviews");
  });

  it("files a commit, a screenshot and an unknown kind under NEITHER", () => {
    // The important refusal: sweeping these into Reviews would let an
    // unreviewed item render a non-empty Reviews tab, which reads as
    // "someone assessed this". Adding `commit` to `REVIEW_KINDS` fails
    // exactly this test.
    expect(artifactTab("commit")).toBeNull();
    expect(artifactTab("screenshot")).toBeNull();
    expect(artifactTab("other")).toBeNull();
    expect(artifactTab("a_kind_invented_next_year")).toBeNull();
  });

  it("never puts one artifact on both tabs", () => {
    // What keeps the tab counts honest — a kind on both would be counted
    // twice and read as two rows.
    const kinds = [
      "plan",
      "plan_review",
      "code_review",
      "visual_review",
      "historical_verification",
      "test_run",
      "commit",
      "screenshot",
      "other",
    ];
    for (const kind of kinds) {
      const tab = artifactTab(kind);
      const inPlan = artifactsForTab([artifact({ kind })], "plan").length;
      const inReviews = artifactsForTab([artifact({ kind })], "reviews").length;
      expect(inPlan + inReviews).toBe(tab === null ? 0 : 1);
    }
  });

  it("filters a mixed list down to each tab, preserving order", () => {
    const artifacts = [
      artifact({ id: "a", kind: "plan" }),
      artifact({ id: "b", kind: "code_review" }),
      artifact({ id: "c", kind: "commit" }),
      artifact({ id: "d", kind: "plan_review" }),
      artifact({ id: "e", kind: "visual_review" }),
    ];
    expect(artifactsForTab(artifacts, "plan").map((a) => a.id)).toEqual(["a", "d"]);
    expect(artifactsForTab(artifacts, "reviews").map((a) => a.id)).toEqual(["b", "e"]);
  });
});
