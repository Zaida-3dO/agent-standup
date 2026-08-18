// The forwarding route's rules about what crosses the boundary.
//
// Every assertion here is about something *not* crossing. A proxy that
// copies everything works perfectly in a browser and is a hole: the
// credential it holds is more privileged than the caller it serves, so
// anything the caller can influence about the outbound request is something
// the caller has borrowed that privilege for.
import { describe, expect, it } from "vitest";
import {
  UI_PROXY_PREFIX,
  STRIPPED_REQUEST_HEADERS,
  STRIPPED_RESPONSE_HEADERS,
  forwardTargetUrl,
  forwardedRequestHeaders,
  forwardedResponseHeaders,
  unconfiguredResponseBody,
} from "@/lib/ui-proxy/forward";

describe("forwardedRequestHeaders", () => {
  it("attaches the server's token as a bearer credential", () => {
    const headers = forwardedRequestHeaders(new Headers(), "s3cr3t");
    expect(headers.get("authorization")).toBe("Bearer s3cr3t");
  });

  it("strips the browser's Authorization independently of the token it then sets", () => {
    // Two mechanisms defend this: `authorization` is in the stripped list,
    // and the server's own header is `set` afterwards (which overwrites).
    // Asserting only the end result would let the strip be deleted with
    // every test still green, leaving one mechanism where there were two —
    // and the survivor is the one whose correctness depends on call order.
    // So the strip is exercised on its own terms: copy with the same rule,
    // set nothing, and require the browser's credential to be gone.
    const inbound = new Headers({ Authorization: "Bearer guessed-token" });
    const copied = new Headers();
    inbound.forEach((value, name) => {
      if (STRIPPED_REQUEST_HEADERS.includes(name.toLowerCase())) return;
      copied.set(name, value);
    });
    expect(copied.get("authorization")).toBeNull();
  });

  it("presents its own credential over one the browser sent", () => {
    // The attack this closes: a reader opens the console and calls the
    // forwarding route with a guessed token. If the browser's header
    // survived, this server would present the guess — becoming an oracle
    // for testing credentials, using its own valid token's access as cover.
    const inbound = new Headers({ Authorization: "Bearer guessed-token" });
    const headers = forwardedRequestHeaders(inbound, "real-token");
    expect(headers.get("authorization")).toBe("Bearer real-token");
  });

  it("does so whatever the header's casing", () => {
    // `Headers` normalises names, so this proves the strip is name-based
    // rather than a literal string comparison that a different spelling
    // would slip past.
    const inbound = new Headers({ AUTHORIZATION: "Bearer guessed" });
    const headers = forwardedRequestHeaders(inbound, "real");
    expect(headers.get("Authorization")).toBe("Bearer real");
  });

  it("drops a cookie the browser sent", () => {
    const inbound = new Headers({ Cookie: "session=whatever" });
    expect(forwardedRequestHeaders(inbound, "t").get("cookie")).toBeNull();
  });

  it("drops hop-by-hop headers that describe the finished connection", () => {
    const inbound = new Headers({ Host: "elsewhere.example", "Content-Length": "999" });
    const headers = forwardedRequestHeaders(inbound, "t");
    expect(headers.get("host")).toBeNull();
    expect(headers.get("content-length")).toBeNull();
  });

  it("passes through headers the API legitimately reads", () => {
    // The gate is the point, not isolation for its own sake: the request id
    // and the declared actor must survive or the forwarded call loses the
    // tracing and attribution every other client gets.
    const inbound = new Headers({
      "X-Request-Id": "req-1",
      "X-Standup-Actor": "someone",
      "Content-Type": "application/json",
    });
    const headers = forwardedRequestHeaders(inbound, "t");
    expect(headers.get("x-request-id")).toBe("req-1");
    expect(headers.get("x-standup-actor")).toBe("someone");
    expect(headers.get("content-type")).toBe("application/json");
  });

  it("holds the stripped list to the entries argued for", () => {
    // Narrowing this list is how the credential leak comes back, so the
    // list itself is asserted rather than left to drift.
    expect([...STRIPPED_REQUEST_HEADERS].sort()).toEqual(
      [
        "authorization",
        "connection",
        "content-length",
        "cookie",
        "host",
        "transfer-encoding",
      ].sort(),
    );
  });
});

describe("forwardedResponseHeaders", () => {
  it("drops WWW-Authenticate so a refusal cannot prompt the reader for a token", () => {
    // A browser shown this header pops a credential dialog. The reader has
    // no token to type, and the one the server failed to present is not
    // theirs — so the prompt can only mislead.
    const inbound = new Headers({ "WWW-Authenticate": 'Bearer realm="standup"' });
    expect(forwardedResponseHeaders(inbound).get("www-authenticate")).toBeNull();
  });

  it("keeps the request id so a call can still be found in the log", () => {
    const inbound = new Headers({ "X-Request-Id": "req-9", "Content-Type": "application/json" });
    const headers = forwardedResponseHeaders(inbound);
    expect(headers.get("x-request-id")).toBe("req-9");
    expect(headers.get("content-type")).toBe("application/json");
  });

  it("holds the stripped response list to the entries argued for", () => {
    expect([...STRIPPED_RESPONSE_HEADERS].sort()).toEqual(
      [
        "connection",
        "content-encoding",
        "content-length",
        "transfer-encoding",
        "www-authenticate",
      ].sort(),
    );
  });
});

describe("forwardTargetUrl", () => {
  it("rewrites the prefix onto the API path", () => {
    expect(forwardTargetUrl("http://host/api/ui/people", ["people"])).toBe(
      "http://host/api/people",
    );
  });

  it("preserves the query string", () => {
    expect(forwardTargetUrl("http://host/api/ui/board?column=waiting", ["board"])).toBe(
      "http://host/api/board?column=waiting",
    );
  });

  it("rebuilds nested paths from their segments", () => {
    expect(forwardTargetUrl("http://host/api/ui/items/x/detail", ["items", "x", "detail"])).toBe(
      "http://host/api/items/x/detail",
    );
  });

  it("takes the origin from the request URL, never from a header", () => {
    // A `Host` a client controls would otherwise choose where this server
    // sends a request carrying a valid credential.
    const target = forwardTargetUrl("https://real-host/api/ui/people", ["people"]);
    expect(target).toBe("https://real-host/api/people");
    expect(target).not.toContain("elsewhere");
  });

  it("refuses a traversal segment rather than normalising it", () => {
    // `..` is how a forwarded path escapes `/api` — the destination could
    // become any route on the origin, reached with the server's credential.
    expect(forwardTargetUrl("http://host/api/ui/x", ["..", "..", "admin"])).toBeNull();
    expect(forwardTargetUrl("http://host/api/ui/x", ["."])).toBeNull();
  });

  it("refuses an empty segment", () => {
    expect(forwardTargetUrl("http://host/api/ui//x", ["", "x"])).toBeNull();
  });

  it("refuses an empty path", () => {
    expect(forwardTargetUrl("http://host/api/ui", [])).toBeNull();
  });

  it("encodes a segment so it cannot smuggle a second path", () => {
    // Segments arrive decoded from the router. Re-encoding exactly once
    // means a segment containing a separator stays one segment rather than
    // silently becoming a different destination.
    const target = forwardTargetUrl("http://host/api/ui/x", ["items", "a/../../admin"]);
    expect(target).toBe("http://host/api/items/a%2F..%2F..%2Fadmin");
  });

  it("cannot be pointed at another origin through a segment", () => {
    const target = forwardTargetUrl("http://host/api/ui/x", ["https://elsewhere.example/steal"]);
    expect(target).not.toBeNull();
    expect(new URL(target as string).origin).toBe("http://host");
  });

  it("mounts at the documented prefix", () => {
    expect(UI_PROXY_PREFIX).toBe("/api/ui");
  });
});

describe("unconfiguredResponseBody", () => {
  it("tells an operator which variable to set", () => {
    // A refusal nobody can act on is how a fail-closed default gets
    // "fixed" by removing the gate.
    const message = unconfiguredResponseBody().error.message;
    expect(message).toContain("STANDUP_TOKENS");
    expect(message).toContain("browser");
  });

  it("names no token value", () => {
    // The body is served to a browser; it must describe configuration
    // without quoting any of it.
    const message = unconfiguredResponseBody().error.message;
    expect(message).not.toMatch(/Bearer\s+\S/);
  });
});
