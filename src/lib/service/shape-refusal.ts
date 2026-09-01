// Turning a schema's objections into a refusal a caller can act on.
//
// ── Why this is a module rather than three private functions ────────────
//
// `ServiceRuntime` validates every call's input with `safeParse` and turns
// the issues into an `InvalidInputError` carrying the field paths and one
// finding per objection. That is the honest path, and it is why most
// operations refuse by name.
//
// It is not the only place a schema is applied. A **facade** operation —
// one tool standing in front of several, like `create_work` in front of the
// three creates, or `loop` in front of the six loop verbs — rebuilds an
// input for the operation it dispatches to and applies *that* operation's
// schema itself, below the runtime's parse. The runtime has already
// finished validating by then, so a rule that lives only on the delegate's
// schema is first applied at that inner parse.
//
// Applied with a bare `.parse()`, the inner rule throws a `ZodError`, which
// is not a `ServiceError`, so `toServiceError` classifies it as an
// `InternalError` — and the caller receives
// `{"code":"internal","fields":[],"message":"The operation failed
// unexpectedly."}` for a mistake they could have corrected. The two
// conditionally required rules on the creates (`exactly one of area or
// areas`, and `originPersonId` when `originType` is `person`) reached
// callers exactly that way.
//
// That is the failure worth naming precisely, because it inverts the
// meaning of the two codes. `internal` reads as *transient*, so a caller
// retries — and the retry cannot succeed, because nothing about the input
// changed. One reporter retried three times before adding a field on a
// hunch. `invalid_input` reads as *your move*, which is the truth.
//
// So the conversion lives here, exported, and both the runtime and every
// facade use it. Sharing the code is the point: a caller must not be able
// to tell whether the rule that refused them sat on the tool they called or
// on the operation it delegated to, and two copies of this logic would
// drift into exactly that difference.
import type { z } from "zod";
import { InvalidInputError } from "./errors";
import { invocationWithArgumentFor, surfaceForTransport } from "@/lib/surfaces";

/** One thing wrong with an input, on its own. */
export interface ShapeFinding {
  /** The field path, or `""` for an objection to the input as a whole. */
  readonly field: string;
  readonly message: string;
}

/**
 * Every objection the schema raised, as separate findings.
 *
 * A schema can refuse one call for several unrelated reasons at once, and
 * the reasons are genuinely independent — a value outside an enum and an
 * unrecognised key are two different mistakes that happen to have arrived
 * together. Joining them into one sentence reads as a single confusing
 * complaint, and a caller who fixes the half they understood is refused
 * again on the half they did not. Kept as a list, each is a finding that can
 * be read, and fixed, on its own.
 */
export function findingsFrom(issues: readonly z.ZodIssue[]): readonly ShapeFinding[] {
  return issues.map((issue) => ({
    field: issue.path.map((segment) => String(segment)).join("."),
    message: issue.message,
  }));
}

/**
 * One finding as a line.
 *
 * The field is named ahead of the message because Zod's own text often does
 * not contain it — "Required" and "Unrecognized key" say what is wrong and
 * leave a caller to infer where from a path they cannot see. Prefixing costs
 * a few characters and removes the inference.
 */
function describeFinding(finding: ShapeFinding): string {
  return finding.field.length > 0 ? `\`${finding.field}\`: ${finding.message}` : finding.message;
}

/**
 * The message a caller reads when their input does not match the schema.
 *
 * Two things it does beyond naming the problem, both from MILESTONES.md
 * #111:
 *
 *   - **It numbers multiple faults.** One call really did once fail for two
 *     independent undocumented reasons at once, and the session read one
 *     confusing message instead of two findings. Numbered lines make the
 *     count visible, which is the part that was lost: a caller who can see
 *     there are two problems does not fix one and resubmit.
 *   - **It names the call that would have prevented it.** A caller needs the
 *     contract exactly when a call fails, and that is the moment nothing
 *     otherwise points at it. Worded for the surface the caller is actually
 *     on (`surfaces.ts`) — telling an MCP caller to run a terminal
 *     command is the defect, not the fix.
 *
 * The pointer is appended for every operation, including those declaring no
 * `contract`. A caller who has just been refused cannot know whether the
 * tool they were refused by has conditional rules, so "ask and find there
 * are none" is a cheap answer and "no pointer, work it out" is not.
 */
export function shapeRefusalMessage(
  operation: string,
  issues: readonly z.ZodIssue[],
  transport: string | undefined,
): string {
  const findings = findingsFrom(issues);
  const pointer = invocationWithArgumentFor(
    "describe_tool",
    operation,
    surfaceForTransport(transport),
  );
  const head = `Invalid input for ${operation}`;
  const routing = `Call ${pointer} for the full contract, including the rules the schema cannot state.`;

  if (findings.length === 1) {
    // A single fault reads worse as a numbered list of one than as a
    // sentence, and the count is not information when it is one.
    return `${head}: ${describeFinding(findings[0]!)} ${routing}`;
  }

  const lines = findings.map((finding, index) => `  ${index + 1}. ${describeFinding(finding)}`);
  return `${head} — ${findings.length} problems:\n${lines.join("\n")}\n${routing}`;
}

/**
 * The `InvalidInputError` a set of schema issues deserves.
 *
 * Built here rather than at each call site so the message, the `fields` and
 * the structured findings are always assembled together. A refusal missing
 * any one of the three is a refusal some adapter cannot render — the
 * conformance suite compares codes and offending fields across adapters, so
 * a `fields` left empty is invisible to it in exactly the way a bare
 * `Error` is.
 */
export function invalidInputFromIssues(
  operation: string,
  issues: readonly z.ZodIssue[],
  transport: string | undefined,
): InvalidInputError {
  return new InvalidInputError(shapeRefusalMessage(operation, issues, transport), {
    // The paths the schema objected to, so an adapter can point at
    // the fields without re-parsing the message. Deduplicated
    // because one field can raise several issues, and a caller
    // reading "title, title, title" learns nothing extra.
    fields: [
      ...new Set(issues.map((issue) => issue.path.map((segment) => String(segment)).join("."))),
    ].filter((path) => path.length > 0),
    // The findings, structured, so an adapter can render them as a
    // list rather than an adapter having to split the message back
    // apart on a separator. `fields` above answers "which fields",
    // which is a different question from "what was wrong with each" —
    // a call refused for two unrelated reasons has two entries here
    // and one line per entry in the message.
    details: { findings: findingsFrom(issues) },
  });
}

/**
 * Applies a delegate operation's schema the way the runtime applies the
 * outer one — refusing by name instead of throwing.
 *
 * **The name a refusal carries is the delegate's, not the facade's.** A
 * caller refused for omitting `area` on `create_work` is pointed at
 * `describe_tool("create_task")`, because that is where the rule is written
 * down and where the contract that explains it lives. Naming the facade
 * would point at a contract that does not state the rule, which is the
 * pointer being decorative.
 *
 * @param operation the delegate's registered name, for the message and the pointer
 * @param schema the delegate's input schema
 * @param input the rebuilt input to validate
 * @param transport the caller's transport, so the pointer names a call they can make
 */
export function parseDelegateInput<Schema extends z.ZodTypeAny>(
  operation: string,
  schema: Schema,
  input: unknown,
  transport: string | undefined,
): z.infer<Schema> {
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    throw invalidInputFromIssues(operation, parsed.error.issues, transport);
  }
  return parsed.data as z.infer<Schema>;
}
