// The join itself, proven through a real route against a real database —
// MILESTONES.md #129.
//
// `tests/request-id-header.test.ts` proves the pieces as values: the header
// is read, an unsafe value is refused, a response carries the id back. That
// split is not merely convenient — some of those values cannot reach this
// file at all, because `new Request` refuses to construct a header carrying
// a newline, so the forged-log-record case is only reachable as a value.
// What the value tests cannot show is the property the row is actually about — that
// **the id a caller sends is the id the server writes into its own log
// lines, and the id it hands back**. That spans a route, the service
// runtime and the logger, and it is exactly the kind of claim that stays
// true in three separate unit tests while being false end to end, because
// each layer is asserted against a value the test itself supplied.
//
// So this file sends one request with a known id and then reads the
// server's own log output looking for that string. If any layer in between
// mints a fresh id instead of threading the caller's through, the line
// carries a UUID this test never chose and the assertion fails.
//
// Driven as a route handler in-process (SCHEMA.md §22: "run in-process
// wherever the process boundary is not the thing being tested") against a
// real Postgres, the same shape as `tests/hook-route.test.ts` — the service
// call has to genuinely execute for the runtime to log anything at all.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { REQUEST_ID_HEADER } from "@/lib/request-id-header";
import { LOG_LEVEL_ENV_VAR } from "@/lib/log";
import { captureLogs, type CapturedLogs } from "./helpers/capture-logs";
import {
  createMigratedScratchDatabase,
  dropScratchDatabase,
  scratchDatabaseName,
} from "./helpers/scratch-db";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const describeIfDb = testDatabaseUrl ? describe : describe.skip;

describeIfDb("a request id survives the hop and comes back", () => {
  const dbName = scratchDatabaseName("request_id_e2e");
  let scratchUrl: string;
  let hookRoute: typeof import("@/app/api/hook/route");
  let logs: CapturedLogs;
  let previousLevel: string | undefined;

  beforeAll(async () => {
    scratchUrl = (await createMigratedScratchDatabase(testDatabaseUrl!, dbName)).url;
    // Same ordering constraint every other route test documents: point
    // DATABASE_URL at the scratch database before importing anything that
    // reaches service/live.ts's process-global singleton.
    process.env.DATABASE_URL = scratchUrl;
    hookRoute = await import("@/app/api/hook/route");
  }, 60_000);

  afterAll(async () => {
    await dropScratchDatabase(testDatabaseUrl!, dbName);
  }, 60_000);

  beforeEach(() => {
    // "Service call started." is `debug` — one line per call is the
    // highest-volume thing this application logs, so the `info` default
    // leaves it out. It is also the line that carries the request id, which
    // is the whole subject of this file.
    previousLevel = process.env[LOG_LEVEL_ENV_VAR];
    process.env[LOG_LEVEL_ENV_VAR] = "debug";
    logs = captureLogs();
  });

  afterEach(() => {
    logs.restore();
    if (previousLevel === undefined) delete process.env[LOG_LEVEL_ENV_VAR];
    else process.env[LOG_LEVEL_ENV_VAR] = previousLevel;
  });

  /** A `POST /hook` body the operation accepts — the route is incidental here. */
  function hookRequest(headers: Record<string, string>): Request {
    return new Request("http://localhost/api/hook", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({
        eventType: "PreToolUse",
        sessionId: "s-request-id",
        tool: "Bash",
        command: "git status",
      }),
    });
  }

  it("writes the caller's id on the server's own log lines", async () => {
    const sent = "e2e-caller-chosen-id";
    const response = await hookRoute.POST(hookRequest({ [REQUEST_ID_HEADER]: sent }));
    expect(response.status).toBe(200);

    // The assertion that fails if any layer mints its own id instead of
    // threading the caller's: this string was chosen here, so it cannot
    // appear in a line the server labelled independently.
    const started = logs
      .stderr()
      .find((line) => line.msg === "Service call started." && line.requestId === sent);
    expect(started).toBeDefined();
    expect(started?.operation).toBe("hook_decision");
    expect(started?.transport).toBe("http");
  });

  it("hands the same id back to the caller on the response", async () => {
    const sent = "e2e-echoed-id";
    const response = await hookRoute.POST(hookRequest({ [REQUEST_ID_HEADER]: sent }));

    // The half that makes "I called X and got Y" answerable: the reporter
    // holds the exact value that finds the call in the log above.
    expect(response.headers.get(REQUEST_ID_HEADER)).toBe(sent);
  });

  it("labels and echoes a call that arrived without an id", async () => {
    const response = await hookRoute.POST(hookRequest({}));
    const echoed = response.headers.get(REQUEST_ID_HEADER);

    // A caller that sends nothing is still given an id it can quote, and
    // that id is the one the server logged — otherwise the header would name
    // a call absent from the log.
    expect(echoed).toMatch(/^[0-9a-f-]{36}$/);
    expect(
      logs
        .stderr()
        .some((line) => line.msg === "Service call started." && line.requestId === echoed),
    ).toBe(true);
  });

  it("ignores an unsafe id rather than writing it into a log line", async () => {
    // **A newline cannot be tested here, and that is worth stating rather
    // than working around.** `new Request` refuses to construct a header
    // whose value contains one, so the platform rejects it before any code
    // in this repository runs — the guard against a forged log record is
    // therefore proven where it is reachable, as a value, in
    // `tests/request-id-header.test.ts`.
    //
    // What *is* reachable over a real request is a value HTTP permits but
    // this application will not label a log line with. An interior space is
    // that case: legal in a header, useless as a greppable id.
    const unusable = "two words";
    const response = await hookRoute.POST(hookRequest({ [REQUEST_ID_HEADER]: unusable }));

    // The call still succeeds — a bad log label is never a failed operation
    // — but the server labels it with an id of its own, and that is what
    // comes back and what appears in the log.
    expect(response.status).toBe(200);
    const echoed = response.headers.get(REQUEST_ID_HEADER);
    expect(echoed).toMatch(/^[0-9a-f-]{36}$/);
    expect(echoed).not.toBe(unusable);
    expect(
      logs
        .stderr()
        .some((line) => line.msg === "Service call started." && line.requestId === echoed),
    ).toBe(true);
    expect(logs.stderr().some((line) => line.requestId === unusable)).toBe(false);
  });
});
