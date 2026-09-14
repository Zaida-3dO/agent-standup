// scripts/lib/sweep-schedule.mjs + scripts/sweep-schedule.mjs — the liveness
// sweep scheduler.
//
// The failure these guard against is not a crash. It is a scheduler that runs
// happily without a usable credential: 401 on every tick, each one logged as
// "continuing", the container `Up` the whole time, and zero sweeps performed.
// So the assertions here are mostly not "does it sweep" — they are "can it
// possibly sweep unauthenticated" (no) and "can it stay alive while failing to
// authenticate" (no).
//
// No DB and no network: `fetch` is injected.
import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_SWEEP_INTERVAL_SECONDS,
  DEFAULT_SWEEP_TIMEOUT_SECONDS,
  describeResult,
  parseIntervalMs,
  resolveConfig,
  runSweepOnce,
  SweepAuthError,
  SweepConfigError,
  SweepRequestError,
  verifyAuth,
} from "../scripts/lib/sweep-schedule.mjs";
import { main } from "../scripts/sweep-schedule.mjs";

const GOOD_ENV = {
  STANDUP_URL: "http://agent-standup:3000",
  STANDUP_TOKEN: "sweeper-token",
};

/**
 * A `fetch` stand-in that records its calls and answers with a fixed response.
 *
 * Typed loosely on purpose: the module under test is plain `.mjs` and takes
 * `fetchImpl` as a duck-typed injection point, so pinning these to the DOM
 * `fetch` signature would be asserting a contract the code does not have.
 */
type StubInit = { method?: string; headers?: Record<string, string>; body?: string };

/** The response shape `runSweepOnce` actually consumes: a status and two readers. */
type StubResponse = {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
  text: () => Promise<string>;
};

function stubFetch(responder: (url: string, init: StubInit) => StubResponse) {
  const calls: { url: string; init: StubInit }[] = [];
  const impl = async (url: string, init: StubInit) => {
    calls.push({ url, init });
    return responder(url, init);
  };
  return { impl, calls };
}

function jsonResponse(status: number, body: unknown): StubResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

const EMPTY_RESULT = {
  moves: [],
  released: [],
  escalated: [],
  exempted: [],
  evictedWhileRunning: [],
};

function silentLog() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

describe("resolveConfig — the token is required to exist at all", () => {
  it("resolves a complete configuration", () => {
    const config = resolveConfig(GOOD_ENV);
    expect(config.endpoint).toBe("http://agent-standup:3000/api/sweep");
    expect(config.token).toBe("sweeper-token");
    expect(config.intervalMs).toBe(DEFAULT_SWEEP_INTERVAL_SECONDS * 1000);
    expect(config.timeoutMs).toBe(DEFAULT_SWEEP_TIMEOUT_SECONDS * 1000);
  });

  // Breaks if the token check is removed or downgraded to a warning:
  // resolveConfig would return a config instead of throwing, which is what
  // makes an unauthenticated tick reachable at all.
  it("refuses to produce a config at all when STANDUP_TOKEN is absent", () => {
    expect(() => resolveConfig({ STANDUP_URL: GOOD_ENV.STANDUP_URL })).toThrow(SweepConfigError);
    expect(() => resolveConfig({ STANDUP_URL: GOOD_ENV.STANDUP_URL })).toThrow(/STANDUP_TOKEN/);
  });

  it.each([
    ["an empty string, which is what an unset ${VAR:-} in Compose yields", ""],
    ["whitespace only", "   "],
  ])("treats a token that is %s as absent rather than sending it", (_label, token) => {
    expect(() => resolveConfig({ ...GOOD_ENV, STANDUP_TOKEN: token })).toThrow(SweepConfigError);
  });

  it("requires STANDUP_URL", () => {
    expect(() => resolveConfig({ STANDUP_TOKEN: "t" })).toThrow(/STANDUP_URL/);
  });

  it("rejects a STANDUP_URL that is not a URL", () => {
    expect(() => resolveConfig({ ...GOOD_ENV, STANDUP_URL: "not a url" })).toThrow(
      SweepConfigError,
    );
  });

  it("builds the endpoint from the base URL, ignoring any path on it", () => {
    const config = resolveConfig({ ...GOOD_ENV, STANDUP_URL: "http://host:8100/" });
    expect(config.endpoint).toBe("http://host:8100/api/sweep");
  });
});

describe("parseIntervalMs", () => {
  it("resolves an absent variable to the default", () => {
    expect(parseIntervalMs({}, "SWEEP_INTERVAL_SECONDS", 300)).toBe(300_000);
  });

  it.each([
    ["empty string", ""],
    ["a unit suffix typo", "5m"],
    ["zero", "0"],
    ["a negative", "-1"],
    ["a value that overflows to Infinity once multiplied by 1000", "1e308"],
  ])("rejects %s rather than silently using the default", (_label, raw) => {
    expect(() => parseIntervalMs({ X: raw }, "X", 300)).toThrow(SweepConfigError);
  });
});

describe("runSweepOnce — every request carries the bearer token", () => {
  // Breaks on a single-character change: dropping the `authorization` line
  // from runSweepOnce.
  it("sends Authorization: Bearer <token>", async () => {
    const { impl, calls } = stubFetch(() => jsonResponse(200, EMPTY_RESULT));
    await runSweepOnce(resolveConfig(GOOD_ENV), { fetchImpl: impl });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.init.headers!.authorization).toBe("Bearer sweeper-token");
  });

  it("POSTs, because a GET that releases other sessions' claims is one a crawler will invoke", async () => {
    const { impl, calls } = stubFetch(() => jsonResponse(200, EMPTY_RESULT));
    await runSweepOnce(resolveConfig(GOOD_ENV), { fetchImpl: impl });
    expect(calls[0]!.init.method).toBe("POST");
  });

  it('sends {"dryRun":true} when asked, and {} when not', async () => {
    const { impl, calls } = stubFetch(() => jsonResponse(200, EMPTY_RESULT));
    const config = resolveConfig(GOOD_ENV);
    await runSweepOnce(config, { fetchImpl: impl, dryRun: true });
    await runSweepOnce(config, { fetchImpl: impl });
    expect(calls[0]!.init.body).toBe('{"dryRun":true}');
    expect(calls[1]!.init.body).toBe("{}");
  });

  it.each([401, 403])("raises a FATAL-class SweepAuthError on %i", async (status) => {
    const { impl } = stubFetch(() => jsonResponse(status, { error: { code: "forbidden" } }));
    await expect(runSweepOnce(resolveConfig(GOOD_ENV), { fetchImpl: impl })).rejects.toBeInstanceOf(
      SweepAuthError,
    );
  });

  // The distinction the whole design rests on: 500 is retryable, 401 is not.
  // Breaks if the status check is widened to `!response.ok`.
  it("raises a RETRYABLE SweepRequestError on 500, not an auth error", async () => {
    const { impl } = stubFetch(() => jsonResponse(500, { error: "boom" }));
    const error = await runSweepOnce(resolveConfig(GOOD_ENV), { fetchImpl: impl }).catch((e) => e);
    expect(error).toBeInstanceOf(SweepRequestError);
    expect(error).not.toBeInstanceOf(SweepAuthError);
  });

  it("raises a retryable error when the connection fails outright", async () => {
    const impl = async () => {
      throw new Error("ECONNREFUSED");
    };
    await expect(runSweepOnce(resolveConfig(GOOD_ENV), { fetchImpl: impl })).rejects.toBeInstanceOf(
      SweepRequestError,
    );
  });

  it("raises a retryable error when a 200 body is not JSON", async () => {
    const { impl } = stubFetch(() => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new Error("Unexpected token <");
      },
      text: async () => "<html>",
    }));
    await expect(runSweepOnce(resolveConfig(GOOD_ENV), { fetchImpl: impl })).rejects.toBeInstanceOf(
      SweepRequestError,
    );
  });

  it("still reports an auth error when the error body cannot be read", async () => {
    const { impl } = stubFetch(() => ({
      ok: false,
      status: 401,
      text: async () => {
        throw new Error("stream already consumed");
      },
      json: async () => ({}),
    }));
    await expect(runSweepOnce(resolveConfig(GOOD_ENV), { fetchImpl: impl })).rejects.toBeInstanceOf(
      SweepAuthError,
    );
  });
});

describe("verifyAuth — the startup preflight", () => {
  // The criterion-2 proof: the scheduler demonstrates it can authenticate
  // before it schedules anything, using a call that writes nothing.
  it("proves auth with a dryRun sweep that writes nothing", async () => {
    const { impl, calls } = stubFetch(() => jsonResponse(200, EMPTY_RESULT));
    await verifyAuth(resolveConfig(GOOD_ENV), { fetchImpl: impl, log: silentLog() });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.init.body).toBe('{"dryRun":true}');
    expect(calls[0]!.init.headers!.authorization).toBe("Bearer sweeper-token");
  });

  // Breaks if the `error instanceof SweepAuthError` rethrow is removed — the
  // call would then retry a 401 until the deadline instead of failing fast.
  it("fails immediately on 401 rather than retrying a credential that will never work", async () => {
    let attempts = 0;
    const impl = async () => {
      attempts += 1;
      return jsonResponse(401, { error: { code: "forbidden" } });
    };
    await expect(
      verifyAuth(resolveConfig(GOOD_ENV), { fetchImpl: impl, log: silentLog() }),
    ).rejects.toBeInstanceOf(SweepAuthError);
    expect(attempts).toBe(1);
  });

  it("retries a transient failure while the app is still booting, then succeeds", async () => {
    let attempts = 0;
    const impl = async () => {
      attempts += 1;
      if (attempts < 3) throw new Error("ECONNREFUSED");
      return jsonResponse(200, EMPTY_RESULT);
    };
    await verifyAuth(resolveConfig(GOOD_ENV), {
      fetchImpl: impl,
      log: silentLog(),
      sleep: async () => {},
    });
    expect(attempts).toBe(3);
  });

  it("gives up with a config error once the retry deadline passes", async () => {
    const impl = async () => {
      throw new Error("ECONNREFUSED");
    };
    let clock = 0;
    await expect(
      verifyAuth(resolveConfig(GOOD_ENV), {
        fetchImpl: impl,
        log: silentLog(),
        sleep: async () => {
          clock += 5000;
        },
        now: () => clock,
        retryForMs: 10_000,
      }),
    ).rejects.toBeInstanceOf(SweepConfigError);
  });
});

describe("main — the boot sequence refuses to run unauthenticated", () => {
  // The headline test: in this scenario the process must exit non-zero rather
  // than print a banner and start ticking.
  it("exits EX_CONFIG without starting when STANDUP_TOKEN is missing", async () => {
    const log = silentLog();
    const code = await main({ env: { STANDUP_URL: GOOD_ENV.STANDUP_URL }, log });
    expect(code).toBe(78);
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining("STANDUP_TOKEN"));
  });

  it("exits EX_CONFIG when STANDUP_URL is missing", async () => {
    const code = await main({ env: { STANDUP_TOKEN: "t" }, log: silentLog() });
    expect(code).toBe(78);
  });

  it("exits EX_CONFIG on an invalid interval rather than ticking at a rate nobody chose", async () => {
    const code = await main({
      env: { ...GOOD_ENV, SWEEP_INTERVAL_SECONDS: "5m" },
      log: silentLog(),
    });
    expect(code).toBe(78);
  });
});

describe("describeResult", () => {
  it("summarises the counts a reader of the logs needs", () => {
    const line = describeResult({
      moves: [1, 2],
      released: [1],
      escalated: [],
      exempted: [1, 2, 3],
      evictedWhileRunning: [],
    });
    expect(line).toBe("Sweep: 2 moved, 1 released, 0 escalated, 3 exempted.");
  });

  it("calls out evictions of sessions that were still marked running", () => {
    const line = describeResult({
      moves: [1],
      released: [1],
      escalated: [],
      exempted: [],
      evictedWhileRunning: [1],
    });
    expect(line).toContain("1 evicted while still marked running");
  });

  it("labels a dry run as one, so a log cannot read as real work that never happened", () => {
    expect(describeResult(EMPTY_RESULT, { dryRun: true })).toMatch(/^Dry run:/);
  });
});
