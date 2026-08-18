// The sweep scheduler (MILESTONES.md #130) — the deployment-level caller the
// operation's own header asks for.
//
// Unit-level, no DB and no network: `runSweepOnce` and `main` both take a
// `fetchImpl`, so every case here drives the real code path with a stub in
// place of the server. What is under test is the scheduler's own decisions —
// which URL it calls, what it treats as a failure, whether a failure stops
// the schedule — not the sweep itself, which is covered against a live
// database in tests/sweep-takeover-operations.test.ts.
import { describe, expect, it, vi } from "vitest";
import { InvalidDurationEnvError } from "../scripts/lib/boot-env.mjs";
import {
  DEFAULT_SWEEP_INTERVAL_SECONDS,
  DEFAULT_SWEEP_TIMEOUT_SECONDS,
  SweepRequestError,
  resolveScheduleConfig,
  runSweepOnce,
  summarizeSweep,
  sweepEndpoint,
} from "../scripts/lib/sweep-schedule.mjs";
import { main } from "../scripts/sweep-schedule.mjs";

function jsonResponse(body: unknown, init: { status?: number } = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "content-type": "application/json" },
  });
}

function silentLog() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

describe("resolveScheduleConfig", () => {
  it("resolves both durations to their defaults when only STANDUP_URL is set", () => {
    const config = resolveScheduleConfig({ STANDUP_URL: "http://app:3000" });

    expect(config.standupUrl).toBe("http://app:3000");
    expect(config.intervalMs).toBe(DEFAULT_SWEEP_INTERVAL_SECONDS * 1000);
    expect(config.timeoutMs).toBe(DEFAULT_SWEEP_TIMEOUT_SECONDS * 1000);
  });

  it("reads an explicit interval and timeout", () => {
    const config = resolveScheduleConfig({
      STANDUP_URL: "http://app:3000",
      SWEEP_INTERVAL_SECONDS: "30",
      SWEEP_TIMEOUT_SECONDS: "5",
    });

    expect(config.intervalMs).toBe(30_000);
    expect(config.timeoutMs).toBe(5_000);
  });

  it.each([
    ["genuinely absent", {}],
    ["set to the empty string, as an unset `${VAR:-}` in Compose yields", { STANDUP_URL: "" }],
    ["set to whitespace only", { STANDUP_URL: "   " }],
  ])("refuses to start when STANDUP_URL is %s", (_label, env) => {
    // There is no default for where the application lives, and guessing one
    // produces a scheduler that runs forever and sweeps nothing — the exact
    // silent failure this row exists to remove.
    expect(() => resolveScheduleConfig(env)).toThrow(InvalidDurationEnvError);
  });

  it.each([
    ["empty string, which would otherwise read as zero and hot-loop", ""],
    ["a duration typo with a unit suffix", "5m"],
    ["zero, explicitly", "0"],
    ["a negative interval", "-30"],
  ])("refuses an interval that is %s (%j)", (_label, raw) => {
    expect(() =>
      resolveScheduleConfig({ STANDUP_URL: "http://app:3000", SWEEP_INTERVAL_SECONDS: raw }),
    ).toThrow(InvalidDurationEnvError);
  });

  it("pins the default interval, so a later edit cannot quietly slow reclamation down", () => {
    // A pinned number rather than a range check: any positive value passes a
    // sanity check, so only the exact value catches an edit that pushes the
    // worst-case block on a stranded claim from five minutes to an hour.
    expect(DEFAULT_SWEEP_INTERVAL_SECONDS).toBe(300);
    // The timeout must stay well under the interval, or a slow sweep's
    // attempts overlap each other instead of one finishing before the next
    // begins.
    expect(DEFAULT_SWEEP_TIMEOUT_SECONDS).toBeLessThan(DEFAULT_SWEEP_INTERVAL_SECONDS);
  });
});

describe("sweepEndpoint", () => {
  it.each([
    ["no trailing slash", "http://app:3000"],
    ["one trailing slash", "http://app:3000/"],
    ["several trailing slashes", "http://app:3000///"],
  ])("appends the sweep path to a base URL with %s", (_label, base) => {
    expect(sweepEndpoint(base)).toBe("http://app:3000/api/sweep");
  });
});

describe("runSweepOnce", () => {
  it("POSTs an empty JSON object to the sweep endpoint and returns the parsed result", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ released: ["a"], moves: [] }));

    const result = await runSweepOnce({
      endpoint: "http://app:3000/api/sweep",
      timeoutMs: 1000,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(result).toEqual({ released: ["a"], moves: [] });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("http://app:3000/api/sweep");
    // `POST`, not `GET`: the route refuses a GET, and the reason it refuses
    // (a mutating endpoint a prefetch could fire) is worth pinning on the
    // caller too, not only on the route.
    expect(init.method).toBe("POST");
    expect(init.body).toBe("{}");
  });

  it("throws when the endpoint answers with a non-2xx status, quoting the body", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(jsonResponse({ error: { code: "INTERNAL" } }, { status: 500 }));

    await expect(
      runSweepOnce({
        endpoint: "http://app:3000/api/sweep",
        timeoutMs: 1000,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/500.*INTERNAL/s);
  });

  it("throws when the connection is refused", async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error("connect ECONNREFUSED"));

    await expect(
      runSweepOnce({
        endpoint: "http://app:3000/api/sweep",
        timeoutMs: 1000,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).rejects.toBeInstanceOf(SweepRequestError);
  });

  it("throws when a 200 carries a body that is not JSON", async () => {
    // A proxy's error page or a login redirect answering with 200 — the
    // failure that looks like success if the body is never parsed.
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response("<html>Sign in</html>", { status: 200 }));

    await expect(
      runSweepOnce({
        endpoint: "http://app:3000/api/sweep",
        timeoutMs: 1000,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/non-JSON body/);
  });

  it("aborts a request that outlives the timeout rather than stalling the schedule", async () => {
    // Without the abort, one wedged request stops every future sweep — the
    // loop is sequential, so a promise that never settles is a scheduler
    // that has silently stopped.
    const fetchImpl = vi.fn(
      (_url: string, init: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          init.signal.addEventListener("abort", () =>
            reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
          );
        }),
    );

    await expect(
      runSweepOnce({
        endpoint: "http://app:3000/api/sweep",
        timeoutMs: 10,
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/timed out/);
  });
});

describe("summarizeSweep", () => {
  it("counts each list the sweep returns", () => {
    expect(summarizeSweep({ moves: [1, 2], released: [1], escalated: [], capabilityChecks: [1] })) //
      .toBe("moves=2 released=1 escalated=0 capabilityChecks=1");
  });

  it("reports zero for a key the result does not carry, rather than throwing", () => {
    expect(summarizeSweep({})).toBe("moves=0 released=0 escalated=0 capabilityChecks=0");
  });
});

describe("the scheduler loop", () => {
  it("sweeps once per tick and waits the configured interval between them", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ released: [] }));
    const sleepImpl = vi.fn().mockResolvedValue(undefined);

    const code = await main({
      env: { STANDUP_URL: "http://app:3000", SWEEP_INTERVAL_SECONDS: "30" },
      log: silentLog(),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleepImpl,
      maxTicks: 3,
    });

    expect(code).toBe(0);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(sleepImpl).toHaveBeenCalledTimes(3);
    expect(sleepImpl).toHaveBeenCalledWith(30_000);
  });

  it("keeps sweeping after a failed tick", async () => {
    // The load-bearing case. The app restarting is both the most likely
    // cause of a failed sweep and the moment claims are most likely to be
    // stranded, so a scheduler that gave up on the first failure would stop
    // exactly when it is needed.
    const fetchImpl = vi
      .fn()
      .mockRejectedValueOnce(new Error("connect ECONNREFUSED"))
      .mockResolvedValue(jsonResponse({ released: [] }));
    const log = silentLog();

    const code = await main({
      env: { STANDUP_URL: "http://app:3000" },
      log,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleepImpl: vi.fn().mockResolvedValue(undefined),
      maxTicks: 2,
    });

    expect(code).toBe(0);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(log.warn).toHaveBeenCalledTimes(1);
  });

  it("refuses to start, without sweeping, when STANDUP_URL is missing", async () => {
    // The other side of the same judgement: a bad tick is transient and a
    // bad configuration is not, so this one exits instead of looping.
    const fetchImpl = vi.fn();
    const log = silentLog();

    const code = await main({
      env: {},
      log,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleepImpl: vi.fn().mockResolvedValue(undefined),
      maxTicks: 5,
    });

    expect(code).toBe(1);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining("STANDUP_URL"));
  });

  it("refuses to start when the interval is set to something that is not a duration", async () => {
    const fetchImpl = vi.fn();

    const code = await main({
      env: { STANDUP_URL: "http://app:3000", SWEEP_INTERVAL_SECONDS: "5m" },
      log: silentLog(),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleepImpl: vi.fn().mockResolvedValue(undefined),
      maxTicks: 5,
    });

    expect(code).toBe(1);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
