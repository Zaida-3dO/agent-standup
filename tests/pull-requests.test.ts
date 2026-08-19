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
