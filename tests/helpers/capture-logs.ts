// Capturing what the logger actually wrote, and to which stream.
//
// `src/lib/log.ts` writes with `process.stderr.write` rather than through an
// injectable sink, deliberately — a logger every layer can reach without
// being handed one is the whole point of it being a module-level `log`. So a
// test that wants to assert on a line has to capture the stream.
//
// **Both streams are captured, not just stderr.** The claim #97 makes is not
// "a line was written" but "a line was written *to stderr*" — stdout is where
// a command's actual output goes, and a log line landing there would be
// parsed as a result by anything downstream of a pipe. A helper that only
// watched stderr could not tell a correct line from one that was also, or
// instead, on stdout, so `stdout` below is asserted to stay empty by every
// test that uses this.
import { vi, type MockInstance } from "vitest";

export interface CapturedLogs {
  /** Every JSON line written to stderr, parsed. */
  readonly stderr: () => Record<string, unknown>[];
  /** Every raw chunk written to stdout. Expected to be empty. */
  readonly stdout: () => string[];
  /** Restores both streams. */
  readonly restore: () => void;
}

/**
 * Starts capturing both standard streams.
 *
 * Non-JSON lines on stderr are skipped rather than throwing: the suite runs
 * other code that may legitimately write prose there, and a helper that
 * exploded on it would couple every test using it to everything else in the
 * process.
 */
export function captureLogs(): CapturedLogs {
  const errChunks: string[] = [];
  const outChunks: string[] = [];

  const spies: MockInstance[] = [
    vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => {
      errChunks.push(String(chunk));
      return true;
    }),
    vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
      outChunks.push(String(chunk));
      return true;
    }),
  ];

  return {
    stderr: () =>
      errChunks
        .join("")
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .flatMap((line) => {
          try {
            const parsed: unknown = JSON.parse(line);
            return typeof parsed === "object" && parsed !== null
              ? [parsed as Record<string, unknown>]
              : [];
          } catch {
            return [];
          }
        }),
    stdout: () => [...outChunks],
    restore: () => {
      for (const spy of spies) spy.mockRestore();
    },
  };
}

/** The one record at `level` with `msg`, or `undefined`. Fails loudly on more than one. */
export function oneRecord(
  records: readonly Record<string, unknown>[],
  msg: string,
): Record<string, unknown> | undefined {
  const matches = records.filter((record) => record.msg === msg);
  if (matches.length > 1) {
    throw new Error(`Expected at most one "${msg}" line, found ${matches.length}.`);
  }
  return matches[0];
}
