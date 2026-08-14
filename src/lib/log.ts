// Structured logging.
//
// This module exists because of a specific failure. `InternalError` keeps the
// underlying cause on `.cause`, deliberately, "for exactly that reader" — the
// operator reading the logs — and never lets it cross an adapter boundary,
// because an unexpected failure's text routinely contains a query, a
// connection string or a stack path. That half is right. The half that was
// missing is that **nothing ever wrote the cause anywhere**, so the reader it
// was preserved for could not read it. A 500 arrived as
// `{"code":"internal"}` with an empty server log, and the only way to learn
// what actually threw was to bisect the input against a local checkout.
//
// So: the redaction boundary stays exactly where it was — the client still
// learns nothing — and the cause now reaches the log, which is the one place
// it was always meant to go.
//
// ── Shape ───────────────────────────────────────────────────────────────
//
// One JSON object per line on stderr, because these lines are read by
// `docker logs` and by whatever ships them onward; a line that is already
// JSON needs no parser written for it. `level`, `msg` and `at` are always
// present, and everything else is caller-supplied context.
//
// Levels are the conventional five, ordered. `LOG_LEVEL` selects the
// threshold; anything below it is not emitted. The default is `info`, so a
// deployment that sets nothing still gets warnings and errors — the two that
// signal something needs a human — without the request-level noise.
//
// ── Why this is not a logging library ───────────────────────────────────
//
// It is ~100 lines against a dependency that would need configuring, wrapping
// and pinning. The one thing a library would buy that matters here is
// redaction, and redaction here is structural rather than pattern-based: the
// error taxonomy already decides what may cross to a client, and this module
// only ever writes server-side.

// ── Request context ─────────────────────────────────────────────────────
//
// A log line answers "what failed"; a request id answers "which call". With
// concurrent callers those are different questions, and without the second
// one an operator reading two interleaved failures cannot tell whether they
// are one request going wrong twice or two requests going wrong once.
//
// The id is minted at the boundary a call arrives through, carried on
// `ServiceContext.caller.requestId` (`service/context.ts`) and stamped onto
// every line written for that call — at the adapter, and at the guard that
// refused deep inside it. It is threaded as a value on a type the layers
// already pass to each other rather than held in ambient storage:
// `AsyncLocalStorage` would work, and would be a second channel a guard can
// read without any signature saying so, which is precisely the coupling
// `ServiceContext` exists to make visible.

/** The context key every layer agrees on, so a line is greppable by it. */
export const REQUEST_ID_KEY = "requestId";

/**
 * Mints a request id.
 *
 * A UUID rather than a counter: the processes writing these lines are
 * replaceable and replicated (the application ships as an image), so a
 * per-process counter would collide across replicas the moment two of them
 * are behind one proxy — and the whole value of the id is that it is
 * unambiguous when two lines land in the same aggregated stream.
 */
export function newRequestId(): string {
  return crypto.randomUUID();
}

/** The conventional five, ordered least to most severe. */
export const LOG_LEVELS = ["debug", "info", "warn", "error", "fatal"] as const;

export type LogLevel = (typeof LOG_LEVELS)[number];

/** Emitted when `LOG_LEVEL` names nothing, or names something unrecognised. */
export const DEFAULT_LOG_LEVEL: LogLevel = "info";

/** The environment variable that selects the threshold. */
export const LOG_LEVEL_ENV_VAR = "LOG_LEVEL";

const LEVEL_RANK: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  fatal: 50,
};

/**
 * The configured threshold.
 *
 * An unrecognised value falls back to the default rather than throwing: a
 * typo in a deployment variable should not take the process down, and the
 * fallback is the safe direction — it logs more than the typo asked for,
 * never less.
 */
export function resolveLogLevel(env: Record<string, string | undefined> = process.env): LogLevel {
  const raw = env[LOG_LEVEL_ENV_VAR]?.trim().toLowerCase();
  return (LOG_LEVELS as readonly string[]).includes(raw ?? "")
    ? (raw as LogLevel)
    : DEFAULT_LOG_LEVEL;
}

/** Whether `level` clears `threshold`. */
export function isLevelEnabled(level: LogLevel, threshold: LogLevel): boolean {
  return LEVEL_RANK[level] >= LEVEL_RANK[threshold];
}

/** Arbitrary structured context. Values are rendered by `JSON.stringify`. */
export type LogContext = Record<string, unknown>;

export interface LogRecord extends LogContext {
  readonly level: LogLevel;
  readonly msg: string;
  readonly at: string;
}

/**
 * An `Error` flattened into something `JSON.stringify` will actually render.
 *
 * `JSON.stringify(new Error("x"))` is `{}` — name, message and stack are all
 * non-enumerable — which is its own way of losing the error. The `cause`
 * chain is walked to the bottom because the interesting error is usually the
 * innermost one: a Prisma failure wrapped in an `InternalError` says nothing
 * useful at the outer layer.
 *
 * The chain is depth-limited. A cause cycle is not something to discover in
 * production by hanging the logger.
 */
export function describeError(value: unknown, maxDepth = 5): unknown {
  if (!(value instanceof Error)) return value;
  const described: Record<string, unknown> = {
    name: value.name,
    message: value.message,
    ...(value.stack !== undefined ? { stack: value.stack } : {}),
  };
  // Prisma puts the interesting part on `code`; it is not part of `Error`.
  const code = (value as { code?: unknown }).code;
  if (code !== undefined) described.code = code;
  if (value.cause !== undefined && maxDepth > 0) {
    described.cause = describeError(value.cause, maxDepth - 1);
  }
  return described;
}

/**
 * Builds the record a `log` call would emit, or `null` when the level is
 * below the threshold.
 *
 * Split from the writing so a test can assert on the record without capturing
 * stderr — the same reason `backfillStartupWarning` returns its line rather
 * than printing it.
 */
export function buildLogRecord(
  level: LogLevel,
  msg: string,
  context: LogContext = {},
  threshold: LogLevel = resolveLogLevel(),
  now: Date = new Date(),
): LogRecord | null {
  if (!isLevelEnabled(level, threshold)) return null;
  const described: LogContext = {};
  for (const [key, value] of Object.entries(context)) {
    described[key] = value instanceof Error ? describeError(value) : value;
  }
  return { level, msg, at: now.toISOString(), ...described };
}

/**
 * Writes one JSON line to stderr.
 *
 * stderr rather than stdout for every level: stdout is where a CLI's actual
 * output goes, and the CLI adapter shares this module. Logs must never be
 * mistaken for a command's result by something parsing it.
 */
function write(record: LogRecord): void {
  process.stderr.write(`${JSON.stringify(record)}\n`);
}

function emit(level: LogLevel, msg: string, context?: LogContext): void {
  const record = buildLogRecord(level, msg, context);
  if (record) write(record);
}

export const log = {
  debug: (msg: string, context?: LogContext) => emit("debug", msg, context),
  info: (msg: string, context?: LogContext) => emit("info", msg, context),
  warn: (msg: string, context?: LogContext) => emit("warn", msg, context),
  error: (msg: string, context?: LogContext) => emit("error", msg, context),
  fatal: (msg: string, context?: LogContext) => emit("fatal", msg, context),
};
