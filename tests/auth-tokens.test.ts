import { describe, expect, it } from "vitest";
import {
  AUTH_TOKENS_ENV_VAR,
  parseTokenTable,
  hasConfiguredTokens,
  bearerToken,
  machineForToken,
  authenticate,
} from "@/lib/auth";

/** Builds an environment holding just the token variable. */
function env(value: string | undefined): Record<string, string | undefined> {
  return value === undefined ? {} : { [AUTH_TOKENS_ENV_VAR]: value };
}

/** A request-shaped object carrying one header. */
function requestWith(authorization: string | undefined) {
  return {
    headers: {
      get(name: string): string | null {
        return name.toLowerCase() === "authorization" && authorization !== undefined
          ? authorization
          : null;
      },
    },
  };
}

describe("parseTokenTable", () => {
  it("maps each token to its machine", () => {
    const table = parseTokenTable(env("laptop:token-a,desktop:token-b"));

    expect(table.get("token-a")).toBe("laptop");
    expect(table.get("token-b")).toBe("desktop");
    expect(table.size).toBe(2);
  });

  it("is empty when the variable is unset", () => {
    expect(parseTokenTable({}).size).toBe(0);
  });

  it("tolerates surrounding whitespace around each pair and each half", () => {
    const table = parseTokenTable(env("  laptop : token-a , desktop:token-b  "));

    expect(table.get("token-a")).toBe("laptop");
    expect(table.get("token-b")).toBe("desktop");
  });

  it("keeps a token that itself contains a colon, splitting only on the first", () => {
    // A token is opaque; splitting on every colon would truncate it and
    // refuse a machine whose configuration is correct.
    const table = parseTokenTable(env("laptop:abc:def:ghi"));

    expect(table.get("abc:def:ghi")).toBe("laptop");
    expect(table.size).toBe(1);
  });

  it.each([
    ["no separator", "laptoptoken"],
    ["an empty machine", ":token-a"],
    ["an empty token", "laptop:"],
    ["a whitespace-only token", "laptop:   "],
  ])("drops an entry with %s", (_label, entry) => {
    expect(parseTokenTable(env(entry)).size).toBe(0);
  });

  it("keeps the good entries when one entry is malformed", () => {
    const table = parseTokenTable(env("laptop:token-a,broken,desktop:token-b"));

    expect(table.size).toBe(2);
    expect(table.get("token-a")).toBe("laptop");
  });

  it("drops BOTH machines when two share one token", () => {
    // Picking a winner would attribute one machine's writes to the other,
    // which defeats the attribution per-machine tokens exist to give.
    const table = parseTokenTable(env("laptop:same,desktop:same"));

    expect(table.size).toBe(0);
    expect(table.get("same")).toBeUndefined();
  });

  it("keeps other machines when a different pair is duplicated", () => {
    const table = parseTokenTable(env("laptop:same,desktop:same,server:unique"));

    expect(table.size).toBe(1);
    expect(table.get("unique")).toBe("server");
  });
});

describe("hasConfiguredTokens", () => {
  it("is true when at least one valid pair is configured", () => {
    expect(hasConfiguredTokens(env("laptop:token-a"))).toBe(true);
  });

  it("is false when the variable is unset", () => {
    expect(hasConfiguredTokens({})).toBe(false);
  });

  it("is false when every configured entry is malformed", () => {
    expect(hasConfiguredTokens(env("broken,:also-broken"))).toBe(false);
  });
});

describe("bearerToken", () => {
  it("reads the token out of a well-formed header", () => {
    expect(bearerToken("Bearer token-a")).toBe("token-a");
  });

  it("accepts the scheme in any case, per RFC 7235", () => {
    expect(bearerToken("bearer token-a")).toBe("token-a");
    expect(bearerToken("BEARER token-a")).toBe("token-a");
  });

  it.each([
    ["a missing header", undefined],
    ["a null header", null],
    ["an empty header", ""],
    ["a scheme with no credential", "Bearer"],
    ["a scheme with only whitespace after it", "Bearer    "],
    ["a different scheme", "Basic dXNlcjpwYXNz"],
    ["a bare token with no scheme", "token-a"],
  ])("returns null for %s", (_label, header) => {
    expect(bearerToken(header)).toBeNull();
  });
});

describe("machineForToken", () => {
  const table = parseTokenTable(env("laptop:token-a,desktop:token-b"));

  it("finds the machine holding a configured token", () => {
    expect(machineForToken("token-a", table)).toBe("laptop");
    expect(machineForToken("token-b", table)).toBe("desktop");
  });

  it("returns null for a token that is not configured", () => {
    expect(machineForToken("token-c", table)).toBeNull();
  });

  it("returns null for a token that is a prefix of a configured one", () => {
    // Length is checked before the comparison; a prefix must not match.
    expect(machineForToken("token-", table)).toBeNull();
  });

  it("returns null for a token that extends a configured one", () => {
    expect(machineForToken("token-a-extra", table)).toBeNull();
  });

  it("is case-sensitive", () => {
    expect(machineForToken("TOKEN-A", table)).toBeNull();
  });

  it("returns null against an empty table", () => {
    expect(machineForToken("token-a", new Map())).toBeNull();
  });
});

describe("authenticate", () => {
  const configured = env("laptop:token-a");

  it("authenticates a valid token as its machine", () => {
    const result = authenticate(requestWith("Bearer token-a"), configured);

    expect(result).toEqual({ ok: true, machine: { machine: "laptop" } });
  });

  it("refuses a request with no Authorization header as `missing`", () => {
    const result = authenticate(requestWith(undefined), configured);

    expect(result).toEqual({ ok: false, reason: "missing" });
  });

  it("refuses a malformed credential as `missing`, not `invalid`", () => {
    // Nothing was presented that could be checked, which is the same
    // situation as sending no header at all.
    const result = authenticate(requestWith("Basic dXNlcjpwYXNz"), configured);

    expect(result).toEqual({ ok: false, reason: "missing" });
  });

  it("refuses an unrecognised token as `invalid`", () => {
    const result = authenticate(requestWith("Bearer wrong"), configured);

    expect(result).toEqual({ ok: false, reason: "invalid" });
  });

  it("FAILS CLOSED when no tokens are configured — a valid-looking token is refused", () => {
    // The point of the module: a gate that switched itself off when its
    // configuration was missing would protect nothing exactly when the
    // deployment had gone wrong.
    const result = authenticate(requestWith("Bearer token-a"), {});

    expect(result).toEqual({ ok: false, reason: "invalid" });
  });

  it("FAILS CLOSED when the configured entry is malformed", () => {
    const result = authenticate(requestWith("Bearer token-a"), env("laptop-token-a"));

    expect(result).toEqual({ ok: false, reason: "invalid" });
  });

  it("refuses a token whose machine was dropped for being duplicated", () => {
    const result = authenticate(requestWith("Bearer same"), env("laptop:same,desktop:same"));

    expect(result).toEqual({ ok: false, reason: "invalid" });
  });
});
