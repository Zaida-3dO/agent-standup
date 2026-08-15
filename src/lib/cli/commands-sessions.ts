// Row #43's own command: the registration handshake (SCHEMA.md §21).
//
// A separate module from `commands.ts` and `commands-ownership.ts` for the
// reason both of their headers give: several rows add entries to the same
// command table concurrently on their own branches, so `commands.ts` gets
// one appended import and one appended spread rather than a rewrite.
//
// **The noun is `session`**, which `commands-ownership.ts` already
// established for every verb whose operation requires a `sessionId`.
// `register` is one of those. By default `session claim` does not require it
// to have run first — `hook.require_registration_to_claim` is off — but
// turning that setting on makes it the verb that must run before the rest of
// them, because `session claim` then refuses a session this command has not
// been run for.
//
// ── What this command deliberately does not send ───────────────────────
//
// Not the transport. §21 makes it a capability signal precisely because the
// adapter stamps it; a `--transport` flag would turn it into something the
// person typing the command asserts about their own installation, which
// proves nothing. Which of `cli-direct` and `cli-http` this registration
// records is decided by which binding the dispatcher selected, and the
// person choosing that with `--direct` or `--url` is choosing a real
// property of the call rather than a label on it.
import { malformed, type ErrorEnvelope } from "./envelope";
import { stringFlag, type ParsedArgs } from "./args";
import type { CommandSpec, InputResult } from "./commands";

/** The flags the dispatcher handles itself, never part of an operation's input. */
const GLOBAL_FLAGS = new Set(["json", "direct", "as", "session", "url", "help"]);

/**
 * Builds `register_session`'s input.
 *
 * `--session` is the global identity flag every session-scoped command reads
 * (`commands-ownership.ts`'s `withSessionId`), so it maps to `sessionId`
 * here the same way. It is **required** rather than optional: a registration
 * with no session to register is not a partial call, it is a call with no
 * subject, and refusing it here names the missing flag instead of letting
 * the operation's schema report a missing field the person never typed.
 *
 * `--hook-version` is converted to a number, because a flag is always a
 * string and the operation's schema takes an integer. A value that is not a
 * number is refused here rather than passed through: `z.number()` would
 * reject `"abc"` with a type message about a field the person spelled
 * differently, and the useful sentence names the flag they typed.
 */
function buildRegisterInput(_rest: readonly string[], flags: ParsedArgs["flags"]): InputResult {
  const session = stringFlag(flags, "session");
  if (!session.ok) return session;
  if (session.value === undefined) {
    return {
      ok: false,
      envelope: malformed("`standup session register` needs --session.", ["sessionId"]),
    };
  }

  const hookVersion = numericFlag(flags, "hook-version");
  if (!hookVersion.ok) return hookVersion;

  const input: Record<string, unknown> = { sessionId: session.value };
  for (const [name, value] of Object.entries(flags)) {
    if (GLOBAL_FLAGS.has(name)) continue;
    if (name === "hook-version") continue;
    if (value === true) {
      return { ok: false, envelope: malformed(`--${name} needs a value.`, [name]) };
    }
    // `--hook-variant` is spelled with a hyphen on the command line and
    // camelCase in the schema, which is the one place the two vocabularies
    // differ. Every other flag passes through under its own name, so an
    // unrecognised one is refused by the operation's `.strict()` schema
    // rather than silently dropped here.
    input[name === "hook-variant" ? "hookVariant" : name] = value;
  }

  if (hookVersion.value !== undefined) input.hookVersion = hookVersion.value;

  return { ok: true, input };
}

function numericFlag(
  flags: ParsedArgs["flags"],
  name: string,
): { ok: true; value?: number } | { ok: false; envelope: ErrorEnvelope } {
  const raw = stringFlag(flags, name);
  if (!raw.ok) return raw;
  if (raw.value === undefined) return { ok: true };
  // Trimmed and checked for emptiness before `Number`, because `Number("")`
  // and `Number("  ")` are both `0` — an integer, and one this schema
  // accepts. Without this, `--hook-version ""` would register a session as
  // speaking protocol version zero rather than being told the flag was
  // empty, which is a silently wrong registration instead of a refusal.
  const text = raw.value.trim();
  const parsed = text === "" ? Number.NaN : Number(text);
  if (!Number.isInteger(parsed)) {
    return { ok: false, envelope: malformed(`--${name} must be a whole number.`, [name]) };
  }
  return { ok: true, value: parsed };
}

export const SESSION_COMMANDS: readonly CommandSpec[] = Object.freeze([
  {
    noun: "session",
    verb: "register",
    operation: "register_session",
    summary:
      "Registers this session and reports which hook to install, and whether it may claim (`hook.require_registration_to_claim`, off by default, is what decides this — the protocol version alone does not).",
    buildInput: buildRegisterInput,
  },
]);
