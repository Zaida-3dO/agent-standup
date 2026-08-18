// End-to-end request-id correlation — MILESTONES.md #129.
//
// Row #97 left two follow-ups it deliberately did not do, and this file is
// the proof of both:
//
//   (a) **The id survives the hop.** The command line's `http` binding
//       already minted an id for its own lines; what was missing was a
//       server that reads it. The test that matters is not "a header is
//       sent" but that the id the *client* logged is the id the *server*
//       logged — anything less is a correlation that looks real in a diff
//       and joins nothing in a log.
//   (b) **The id comes back to the caller.** A bug report that arrives as
//       "I called X and got Y" can only be found in a log if the caller was
//       told which call it made.
//
// The trust rules get their own tests because they are the part with a
// failure mode: the id is caller-supplied and lands in newline-delimited
// JSON log lines, so a value that could forge or corrupt one must not be
// honoured. Those are the assertions that would let a log-injection through
// if they were deleted.
import { describe, expect, it } from "vitest";
import {
  MAX_REQUEST_ID_LENGTH,
  REQUEST_ID_HEADER,
  requestIdForHttpRequest,
} from "@/lib/request-id-header";
import { httpCaller, withRequestId } from "@/app/api/_shared/respond";
import { NextResponse } from "next/server";

describe("the request id a server adopts for an inbound call", () => {
  it("honours a caller's id, which is the whole point of the header", () => {
    expect(requestIdForHttpRequest("a1b2c3d4-0000-4000-8000-000000000000")).toBe(
      "a1b2c3d4-0000-4000-8000-000000000000",
    );
  });

  it("mints one when the caller sent no header", () => {
    // Not `undefined`: every HTTP call gets an id, so no line is unlabelled
    // and no response is missing the header some callers rely on.
    expect(requestIdForHttpRequest(null)).toMatch(/^[0-9a-f-]{36}$/);
    expect(requestIdForHttpRequest(undefined)).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("mints a fresh id per call rather than reusing one", () => {
    // The property the id exists for — two concurrent unlabelled callers
    // must still be tellable apart.
    expect(requestIdForHttpRequest(null)).not.toBe(requestIdForHttpRequest(null));
  });

  it("trims surrounding whitespace rather than rejecting the value", () => {
    expect(requestIdForHttpRequest("  req-42  ")).toBe("req-42");
  });

  describe("refuses a value that could corrupt the log it lands in", () => {
    // These are the assertions worth keeping. The id is written into
    // newline-delimited JSON, so each of these inputs is a way to forge or
    // break a record. Every one falls back to a minted id — never the
    // caller's value, and never a thrown error.
    const minted = /^[0-9a-f-]{36}$/;

    it("a newline, which would forge a second log record", () => {
      expect(requestIdForHttpRequest('x"}\n{"level":"fatal"')).toMatch(minted);
    });

    it("a carriage return", () => {
      expect(requestIdForHttpRequest("x\r\ny")).toMatch(minted);
    });

    it("a tab, which is whitespace inside an otherwise plausible id", () => {
      expect(requestIdForHttpRequest("x\ty")).toMatch(minted);
    });

    it("an interior space", () => {
      expect(requestIdForHttpRequest("two words")).toMatch(minted);
    });

    it("an empty or whitespace-only value", () => {
      expect(requestIdForHttpRequest("")).toMatch(minted);
      expect(requestIdForHttpRequest("   ")).toMatch(minted);
    });

    it("a value longer than the cap, which would inflate every line", () => {
      expect(requestIdForHttpRequest("a".repeat(MAX_REQUEST_ID_LENGTH + 1))).toMatch(minted);
      // The boundary itself is honoured — the cap is a limit, not an
      // off-by-one that quietly rejects the longest legal id.
      expect(requestIdForHttpRequest("a".repeat(MAX_REQUEST_ID_LENGTH))).toBe(
        "a".repeat(MAX_REQUEST_ID_LENGTH),
      );
    });

    it("a non-ASCII value, which is not valid in an HTTP header", () => {
      expect(requestIdForHttpRequest("café")).toMatch(minted);
    });
  });
});

describe("what a route resolves for one inbound call", () => {
  it("reads the caller's id and hands the same value to the service", () => {
    // The join itself: the id logged by the service is the id the caller
    // sent, so the two processes' lines carry one value.
    const request = new Request("http://localhost/api/items", {
      headers: { [REQUEST_ID_HEADER]: "from-the-client" },
    });
    const { requestId, caller } = httpCaller(request);

    expect(requestId).toBe("from-the-client");
    expect(caller.requestId).toBe("from-the-client");
    expect(caller.transport).toBe("http");
  });

  it("still stamps the transport when no id was sent", () => {
    const { requestId, caller } = httpCaller(new Request("http://localhost/api/items"));
    expect(caller.transport).toBe("http");
    expect(caller.requestId).toBe(requestId);
  });

  it("reads the header case-insensitively, as HTTP requires", () => {
    const request = new Request("http://localhost/api/items", {
      headers: { "x-request-id": "lowercased" },
    });
    expect(httpCaller(request).requestId).toBe("lowercased");
  });
});

describe("the id that comes back to the caller", () => {
  it("is stamped on the response", () => {
    const response = withRequestId(NextResponse.json({ ok: true }), "req-99");
    expect(response.headers.get(REQUEST_ID_HEADER)).toBe("req-99");
  });

  it("is absent rather than the string 'undefined' when there is no id", () => {
    // A route that refuses a malformed body before resolving an id must not
    // answer with a header naming nothing.
    const response = withRequestId(NextResponse.json({ ok: true }), undefined);
    expect(response.headers.get(REQUEST_ID_HEADER)).toBeNull();
  });
});
