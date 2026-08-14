// What the shipped hook script declares about itself (SCHEMA.md §21).
//
// A module of its own rather than a constant on `../../bin/standup-hook.ts`,
// for a reason that is about testability and not tidiness: that file is an
// *entry point*, and its body runs on import — it reads stdin to the end,
// which never returns when nothing is writing to it. So anything exported
// from there cannot be imported by a test, and the CI assertion this row
// ships ("the shipped hook's declared version equals the build constant")
// would have nothing it could read without spawning a process and feeding it
// a payload.
//
// Splitting the declaration out keeps the assertion a value comparison. It
// also mirrors what every other module under `lib/hook/` already does: the
// entry point owns the effects, and everything that can be stated as a value
// is stated as one somewhere it can be reached.

import { SHIPPED_HOOK_PROTOCOL_VERSION, type HookVariant } from "@/lib/build-constants";

/**
 * The protocol version the shipped hook script speaks.
 *
 * Reads the shared constant rather than repeating a literal, so a bump is
 * one edit in one file and the two numbers cannot drift.
 * `tests/hook-protocol-version.test.ts` asserts both the equality and this
 * mechanism — see that file's header for what a green run there does and
 * does not mean.
 */
export const HOOK_PROTOCOL_VERSION = SHIPPED_HOOK_PROTOCOL_VERSION;

/**
 * The variant the shipped hook script implements.
 *
 * `src/bin/standup-hook.ts` reaches the server over `POST /api/hook`
 * (`./ask-http.ts`), which is the HTTP hook protocol. A command-line hook —
 * one shelling out to `standup hook` (MILESTONES.md #88) — is a second
 * script speaking the `cli` protocol, and it declares its own version
 * against the `cli` range rather than sharing this one. Naming the variant
 * here is what lets the version assertion compare against the right half of
 * `HOOK_PROTOCOL` instead of picking one and being right by luck.
 */
export const SHIPPED_HOOK_VARIANT: HookVariant = "http";
