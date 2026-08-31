// The two questions the progress report asks about a recorded pull request:
// is it still open, and is its URL something we are willing to render as a
// link. Both answers decide whether a reader gets a link or a branch name, so
// both are pinned here.
//
// Pure module, no database: this file never skips.
import { describe, expect, it } from "vitest";
import {
  DEFAULT_PULL_REQUEST_STATUS,
  PULL_REQUEST_STATUSES,
  isLinkableUrl,
  isPullRequestStatus,
  pullRequestStatusOf,
} from "@/lib/pull-requests";

describe("the status vocabulary", () => {
  it("is exactly open and closed", () => {
    // A literal, not a loop over the constant — deriving the expectation
    // from the thing under test makes the assertion shrink with it. A third
    // status added without thought fails here, which is the point: the
    // report branches on this list, and a value it does not know would be
    // read as `open` and render a link.
    expect([...PULL_REQUEST_STATUSES]).toEqual(["open", "closed"]);
  });

  it("accepts the two it knows and rejects everything else", () => {
    expect(isPullRequestStatus("open")).toBe(true);
    expect(isPullRequestStatus("closed")).toBe(true);
    // `merged` is the near-miss most likely to be sent by a caller reasoning
    // from a forge's vocabulary rather than this one.
    for (const value of ["merged", "OPEN", "", "draft", null, undefined, 3]) {
      expect(isPullRequestStatus(value), String(value)).toBe(false);
    }
  });

  it("treats a PR with no recorded status as open", () => {
    // Recording a PR is something a caller does when it opens one, so `open`
    // is the honest default. Fails if the default flips — every PR recorded
    // without an explicit status would stop rendering its link.
    expect(DEFAULT_PULL_REQUEST_STATUS).toBe("open");
    expect(pullRequestStatusOf(null)).toBe("open");
    expect(pullRequestStatusOf(undefined)).toBe("open");
  });

  it("reads a recorded closure as closed", () => {
    // The whole point of the read: a closed PR must stop being linked.
    expect(pullRequestStatusOf("closed")).toBe("closed");
    // Surrounding whitespace is a storage artefact, not a different status.
    expect(pullRequestStatusOf("  closed  ")).toBe("closed");
  });

  it("reads unrecognised prose as open, matching the write path's default", () => {
    // Deliberately forgiving, and only reachable for rows written before this
    // vocabulary existed — `record_artifact` refuses unrecognised prose
    // outright. Fails if the read ever starts throwing, which would make a
    // legacy row break the whole report rather than one row's link.
    expect(pullRequestStatusOf("some old note")).toBe("open");
    expect(pullRequestStatusOf("")).toBe("open");
  });
});

describe("which URLs the report is willing to link", () => {
  it("links plain http and https addresses", () => {
    expect(isLinkableUrl("https://example.com/org/repo/pull/1")).toBe(true);
    expect(isLinkableUrl("http://example.com/org/repo/pull/1")).toBe(true);
    // Surrounding whitespace is a storage artefact, not a different URL.
    expect(isLinkableUrl("  https://example.com/p/1  ")).toBe(true);
  });

  it("refuses a scheme that would be an injection rather than a link", () => {
    // The report emits markdown, so its link target reaches whatever renders
    // it — an MCP client's chat pane, the web UI — from a string that
    // arrived over the API. Fails if the scheme check is widened to "parses
    // as a URL", which `javascript:` and `data:` both do.
    for (const url of ["javascript:alert(1)", "data:text/html,<script>", "file:///etc/passwd"]) {
      expect(isLinkableUrl(url), url).toBe(false);
    }
  });

  it("refuses a URL that would close the markdown link and open another", () => {
    // The scheme check above cannot catch this: the string below is a
    // perfectly valid https URL. But the report renders `[label](ref)`, and a
    // markdown renderer ends the link at the FIRST `)` — so everything after
    // it becomes literal markdown that the caller wrote. The value here
    // renders as two links, the second one entirely attacker-controlled,
    // which is the exact injection the scheme check exists to prevent.
    //
    // Fails if the `)`/whitespace refusal is dropped and only the protocol
    // check remains.
    expect(isLinkableUrl("https://example.com/p/1) [CLICK ME](https://evil.example.com")).toBe(
      false,
    );
    expect(isLinkableUrl("https://example.com/p/1)")).toBe(false);
    expect(isLinkableUrl("https://example.com/a b")).toBe(false);
    // Still true for the shape every real forge actually emits.
    expect(isLinkableUrl("https://github.com/owner/repo/pull/223")).toBe(true);
  });

  it("refuses anything that is not a URL at all", () => {
    // `ref` is a generic column shared with screenshots, so a path, a bare
    // PR number or a sentence are realistic values rather than defensive
    // impossibilities.
    for (const value of ["/org/repo/pull/9", "42", "not a url", "", null, undefined]) {
      expect(isLinkableUrl(value), String(value)).toBe(false);
    }
  });
});

// ── The closed side's tolerance, and why it is one-directional ──────────
//
// `pullRequestStatusOf` used to test `body.trim() === "closed"`, which made
// the leniency one-sided in the direction that costs something. The rows it
// exists to be forgiving about are the *unvalidated* ones — written before
// this vocabulary existed, or around the operation — and those are exactly
// the rows likely to say `"Closed"` or `"closed — superseded by #340"`.
// Every one of them fell through the exact-equality test and was reported
// **open**, so `progress_report` rendered a live markdown link to a dead
// pull request: the single failure this module's header says the whole
// design exists to prevent.
//
// The write path is unchanged and still refuses everything but the two exact
// words — see the `record_artifact` guard, which these tests deliberately do
// not soften.
describe("a legacy row that plainly says closed is not read as open", () => {
  it("reads a differently-cased closure as closed", () => {
    // The literal defect. Fails if the match goes back to case-sensitive
    // equality, which is how a dead PR kept rendering as a live link.
    expect(pullRequestStatusOf("Closed")).toBe("closed");
    expect(pullRequestStatusOf("CLOSED")).toBe("closed");
  });

  it("reads a closure carrying punctuation or an explanation as closed", () => {
    // The realistic legacy shapes: a human wrote a sentence, not a token.
    expect(pullRequestStatusOf("closed.")).toBe("closed");
    expect(pullRequestStatusOf("closed - superseded by a later PR")).toBe("closed");
    expect(pullRequestStatusOf("Closed: replaced by the follow-up")).toBe("closed");
  });

  // ── The boundaries, which are what keep this from over-matching ────────

  it("does not read a longer word beginning with `closed` as a closure", () => {
    // The `\b` in the pattern. Without it, any word with the prefix would
    // silently close a live PR's link — the opposite error, and one that
    // hides a PR a reader needs.
    expect(pullRequestStatusOf("closedown of the release branch")).toBe("open");
    expect(pullRequestStatusOf("closedness")).toBe("open");
  });

  it("does not read prose that merely mentions closure as a closure", () => {
    // The `^` anchor. This body is a note about an OPEN PR, and reading it as
    // closed would drop the link to a PR that still needs review — so the
    // word has to lead the body, not appear in it.
    expect(pullRequestStatusOf("keeping this open until the sibling PR is closed")).toBe("open");
    expect(pullRequestStatusOf("not closed yet")).toBe("open");
  });

  it("does NOT widen what counts as open — the dangerous direction stays shut", () => {
    // The asymmetry is the safety property, so it gets its own assertion
    // rather than being left implicit in the tests above. A body that
    // merely leads with "open" must not be able to reopen a closed PR's
    // link, and unrecognised prose must still fall through to open rather
    // than throwing.
    expect(pullRequestStatusOf("open")).toBe("open");
    expect(pullRequestStatusOf("opened, then closed")).toBe("open");
    expect(pullRequestStatusOf("some old note")).toBe("open");
  });

  it("keeps the WRITE path strict — this tolerance is for history, not the contract", () => {
    // The load-bearing pairing. Every spelling the read path now forgives is
    // still refused at the write, so none of them can be produced through
    // the product from here on. Fails if someone "makes them consistent" by
    // loosening the guard, which would let prose be stored as a status.
    for (const spelling of ["Closed", "CLOSED", "closed.", "closed - superseded by a later PR"]) {
      expect(isPullRequestStatus(spelling.trim())).toBe(false);
    }
    // And the two real statuses are still the two the writer accepts.
    expect(isPullRequestStatus("closed")).toBe(true);
    expect(isPullRequestStatus("open")).toBe(true);
  });
});
