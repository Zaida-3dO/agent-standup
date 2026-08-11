import { describe, expect, it } from "vitest";
import {
  DEFAULT_CONNECTION_LIMIT,
  DEFAULT_POOL_TIMEOUT_SECONDS,
  withPoolDefaults,
} from "@/lib/db-url";

describe("withPoolDefaults", () => {
  it("adds connection_limit and pool_timeout when neither is set", () => {
    const url = new URL(withPoolDefaults("postgres://user:pass@host:5432/db"));
    expect(url.searchParams.get("connection_limit")).toBe(String(DEFAULT_CONNECTION_LIMIT));
    expect(url.searchParams.get("pool_timeout")).toBe(String(DEFAULT_POOL_TIMEOUT_SECONDS));
  });

  it("leaves an explicit connection_limit alone", () => {
    const url = new URL(withPoolDefaults("postgres://user:pass@host:5432/db?connection_limit=3"));
    expect(url.searchParams.get("connection_limit")).toBe("3");
    // The other default still gets applied — only the one the operator set is preserved.
    expect(url.searchParams.get("pool_timeout")).toBe(String(DEFAULT_POOL_TIMEOUT_SECONDS));
  });

  it("leaves an explicit pool_timeout alone", () => {
    const url = new URL(withPoolDefaults("postgres://user:pass@host:5432/db?pool_timeout=99"));
    expect(url.searchParams.get("pool_timeout")).toBe("99");
    expect(url.searchParams.get("connection_limit")).toBe(String(DEFAULT_CONNECTION_LIMIT));
  });

  it("preserves credentials, host, port, path and unrelated query params", () => {
    const url = new URL(
      withPoolDefaults(
        "postgresql://standup:s3cret@db.internal:5432/standup?schema=public&sslmode=require",
      ),
    );
    expect(url.username).toBe("standup");
    expect(url.password).toBe("s3cret");
    expect(url.hostname).toBe("db.internal");
    expect(url.port).toBe("5432");
    expect(url.pathname).toBe("/standup");
    expect(url.searchParams.get("schema")).toBe("public");
    expect(url.searchParams.get("sslmode")).toBe("require");
  });

  it("accepts custom defaults", () => {
    const url = new URL(
      withPoolDefaults("postgres://user:pass@host:5432/db", {
        connectionLimit: 2,
        poolTimeoutSeconds: 5,
      }),
    );
    expect(url.searchParams.get("connection_limit")).toBe("2");
    expect(url.searchParams.get("pool_timeout")).toBe("5");
  });

  it("throws on an invalid URL rather than silently producing garbage", () => {
    expect(() => withPoolDefaults("not-a-url")).toThrow();
  });

  it("does not re-encode an existing percent-encoded query value (e.g. libpq `options`)", () => {
    // A regression guard: withPoolDefaults used to round-trip the whole URL
    // through URLSearchParams.set() + toString(), which re-serializes every
    // existing param and turns a percent-encoded space (%20, valid in a
    // libpq `options` value) into `+` — silently corrupting it, since a
    // percent-decoder (what Prisma's Rust connector uses) reads `+` as a
    // literal character, not a decoded space.
    const input = "postgres://user:pass@host:5432/db?options=-c%20statement_timeout%3D5000";
    const url = withPoolDefaults(input);

    expect(url).toContain("options=-c%20statement_timeout%3D5000");
    expect(url).not.toContain("+");
    expect(url).toContain(`connection_limit=${DEFAULT_CONNECTION_LIMIT}`);
    expect(url).toContain(`pool_timeout=${DEFAULT_POOL_TIMEOUT_SECONDS}`);
  });

  it("returns the URL unchanged when both params are already set", () => {
    const input = "postgres://user:pass@host:5432/db?connection_limit=5&pool_timeout=7";
    expect(withPoolDefaults(input)).toBe(input);
  });
});
