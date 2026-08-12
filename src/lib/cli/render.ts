// Rendering an outcome: `--json` on standard output, human text on standard
// error (SCHEMA.md §20).
//
// **The stream split is the load-bearing part, not the formatting.** §20:
// "one document, one envelope … with all human text on standard error so
// standard output stays parseable." That means a caller can pipe standard
// output into a JSON parser unconditionally — with `--json` it gets exactly
// one document and nothing else, and without it, it gets nothing at all
// rather than prose that fails to parse. A renderer that put a human summary
// on standard output "just for the error case" would break that promise
// exactly when a script is least able to cope.
import type { Envelope } from "./envelope";
import type { RunOutcome } from "./run";

/** Where a rendered run writes. Two sinks, so a test needs no process. */
export interface Streams {
  readonly out: (text: string) => void;
  readonly err: (text: string) => void;
}

/**
 * Writes one outcome.
 *
 * `json` selects the machine surface; the human surface is the default. The
 * envelope is identical either way — the flag chooses which stream it is
 * rendered to and in what shape, never what happened.
 */
export function render(outcome: RunOutcome, streams: Streams, json: boolean): void {
  if (json) {
    streams.out(`${JSON.stringify(outcome.envelope)}\n`);
    return;
  }
  streams.err(`${humanText(outcome.envelope)}\n`);
}

/** The envelope as a person reads it. */
export function humanText(envelope: Envelope): string {
  if (envelope.ok) {
    return typeof envelope.data === "string"
      ? envelope.data
      : JSON.stringify(envelope.data, null, 2);
  }
  const { code, message, fields, guard } = envelope.error;
  const parts = [`${code}: ${message}`];
  if (guard !== undefined) parts.push(`  rule: ${guard}`);
  if (fields.length > 0) parts.push(`  fields: ${fields.join(", ")}`);
  return parts.join("\n");
}
