// `ownership` — taking, giving up and displacing a claim, behind one tool.
//
// ── Why these three ─────────────────────────────────────────────────────
//
// An MCP tool list is sent to the model **on every session**, so every
// registered tool spends context whether or not it is ever called. These
// three are the whole lifecycle of one thing: who holds this item. A caller
// reaching for any of them has already decided it is changing ownership;
// the only remaining question is which direction, which is exactly what an
// `action` states.
//
// They also refer to each other constantly, which is the practical
// argument. `claim`'s `claims.one_crew_per_item` refusal ends "Take it over
// through supersession rather than claiming alongside it", and the
// operation that performs that is `takeover`. `release`'s own contract says
// that to end somebody else's claim you want `takeover`, "which is a
// different operation with its own guards". Three tools that spend their
// documentation pointing at each other are one tool with three verbs.
//
// ── All three are kept, and waived off MCP only ─────────────────────────
//
// They stay registered, stay reachable over HTTP (`api/claims`,
// `api/claims/release`, `api/claims/takeover`) and on the command line, and
// keep their own tests. Each action dispatches to the operation that
// already performs it, through the same `ctx`.
//
// ── §22 and a guard-carrying verb ───────────────────────────────────────
//
// `claim` can be refused by `claims.one_crew_per_item`, and §22 forbids
// waiving an operation a registered guard can reject off an adapter that
// exposes writes. **A fold loses no guard coverage**, which is what that
// bound protects: the delegate runs through `parseDelegateInput` and its own
// handler in the same `ctx`, throwing the *same refusal object* — same
// `code`, same `guard` id, same `fields`. The refusal reaches an MCP caller
// through this tool unchanged, which `tests/ownership-fold.test.ts`
// observes rather than assumes.
//
// The machine check is narrower still and independently satisfied:
// `tests/adapter-waivers.test.ts` derives the operations that reach
// `runGuards` through the state machine, and `claim` is not among them — so
// the waiver is legal mechanically as well as by argument.
//
// ── `sessionId` means three different things, so it is three fields ─────
//
// A `claim` is made BY a session. A `release` is made BY a session, of its
// own row. A `takeover` names the session being displaced AND the session
// doing the displacing. Collapsing those onto one `sessionId` would make
// the most consequential field on the tool mean whatever the action
// happened to be — so `takeover` keeps `fromSessionId` and `bySessionId`
// under their own names, and the contract rule below says which is which.
import { z } from "zod";

import { InvalidInputError } from "../errors";
import { defineOperation } from "../operation";
import type { ServiceContext } from "../context";
import { parseDelegateInput } from "../shape-refusal";
import { claim } from "./claim";
import { release } from "./release";
import { takeover } from "./takeover";

/** The verbs this tool folds. */
export const OWNERSHIP_ACTIONS = ["claim", "release", "takeover"] as const;

export type OwnershipAction = (typeof OWNERSHIP_ACTIONS)[number];

/**
 * The fields each action cannot run without.
 *
 * One list, used both to refuse and to build the sentence the refusal is
 * made from, so a required field and the sentence naming it cannot
 * disagree. `describe_tool` reads this same table.
 *
 * `rootSessionId` is deliberately NOT here even though omitting it is
 * almost always wrong for a dispatched agent: it is optional in `claim`'s
 * schema, where omitting it means "this session is the root of its own
 * crew", and making it required here would refuse a legitimate root claim.
 * The contract rule below says when to pass it instead.
 */
export const OWNERSHIP_ACTION_FIELDS: Readonly<
  Record<OwnershipAction, { readonly required: readonly string[] }>
> = Object.freeze({
  // `holderType`, `holderId` and `sessionId` left OUT deliberately since the
  // lease key: they are carried inside `leaseKey`, so requiring them here
  // would refuse a correct key-only claim before `claim` ever sees it. The
  // delegate's `resolveLease` refuses a call that states neither a key nor
  // that whole set, which is the check this list cannot express — it can
  // only ask "is this field present", and the real rule is "is EITHER shape
  // complete". `itemId` and `role` stay, because no shape supplies them.
  claim: { required: ["itemId", "role"] },
  release: { required: ["itemId", "sessionId"] },
  takeover: {
    required: ["itemId", "fromSessionId", "bySessionId", "holderType", "holderId"],
  },
});

const inputSchema = z
  .object({
    /** Which direction. The one field that decides what the rest means. */
    action: z.enum(OWNERSHIP_ACTIONS),
    /** The item whose ownership is changing. Required by every action. */
    itemId: z.string().min(1).optional(),

    // ── `claim` and `release` ──────────────────────────────────────────
    /**
     * On `claim`, the session doing the claiming. On `release`, the session
     * giving up its OWN row — a session can only release what it holds, and
     * ending someone else's claim is `takeover`.
     *
     * Not accepted on `takeover`, which names both sides explicitly.
     */
    sessionId: z.string().min(1).optional(),

    // ── `claim` ────────────────────────────────────────────────────────
    /**
     * Left loose here and parsed by `claim`'s own schema, which is where the
     * role vocabulary lives. Restating the enum would put one list in two
     * places, and the delegate's `.strict()` parse refuses an unknown role
     * by name before any handler runs.
     */
    role: z.string().min(1).optional(),
    /** Required when the role is `custom` — enforced by the delegate. */
    roleCustom: z.string().min(1).nullable().optional(),
    /**
     * **The one field carrying who is claiming** on action `claim` —
     * `rootSessionId`, `sessionId`, `holderType` and `holderId` are all
     * implicit in it (`src/lib/lease-key.ts`). Issued by `session` with
     * action register, and returned on every claim response.
     *
     * A claim stating neither this nor the full legacy set is refused by
     * the delegate rather than defaulted, which is the point of the field.
     */
    leaseKey: z.string().min(1).nullable().optional(),
    /**
     * The crew this claim belongs to. **Deprecated in favour of
     * `leaseKey`,** which carries it.
     *
     * Still accepted, and on that legacy path it still **defaults to the
     * caller's own `sessionId` when omitted**, which declares this session
     * the root of a new crew. That default is right for an orchestrator and
     * wrong for a dispatched agent — see the contract rule below, which is
     * where a caller reading the tool will find it.
     */
    rootSessionId: z.string().min(1).nullable().optional(),
    parentSessionId: z.string().min(1).nullable().optional(),
    machine: z.string().min(1).optional(),
    pid: z.number().int().nullable().optional(),
    branch: z.string().min(1).nullable().optional(),
    worktree: z.string().min(1).nullable().optional(),
    model: z.string().min(1).nullable().optional(),
    effort: z.string().min(1).nullable().optional(),

    // ── `claim` and `takeover` ─────────────────────────────────────────
    /** Whether a person or an agent holds it. Vocabulary owned by the delegates. */
    holderType: z.string().min(1).optional(),
    holderId: z.string().min(1).optional(),

    // ── `takeover` ─────────────────────────────────────────────────────
    /**
     * The session being displaced.
     *
     * Required, and not because the server cannot look it up — it can. It
     * is the caller confirming it knows *who it is displacing*, which is
     * the same family as `reason` and `force` below: a takeover does not
     * stop the displaced session, so the confirmation is worth its field.
     */
    fromSessionId: z.string().min(1).optional(),
    /** The session taking over. */
    bySessionId: z.string().min(1).optional(),
    /** Why. Required by the delegate when the holder may still be alive. */
    reason: z.string().min(1).nullable().optional(),
    /** Acknowledges the warning. Only meaningful when the holder may be alive. */
    force: z.boolean().optional(),
  })
  .strict();

export type OwnershipInput = z.infer<typeof inputSchema>;

/**
 * Fields that mean something to one action and nothing to the others.
 *
 * The fold's schema is ONE object shared by all three actions, so a field
 * only `claim` uses is structurally acceptable on `release` — and because
 * the `release` branch does not forward it, the delegate's own `.strict()`
 * parse never sees it either. Without this table such a field is accepted
 * and silently dropped, which is the one outcome the strict schema exists
 * to prevent: a caller that believed it was releasing a particular lease
 * would get no signal that the field did nothing.
 */
const ACTION_ONLY_FIELDS: Readonly<Record<string, OwnershipAction>> = Object.freeze({
  leaseKey: "claim",
  rootSessionId: "claim",
  parentSessionId: "claim",
  role: "claim",
  roleCustom: "claim",
});

/** Refuses a field that belongs to a different action than the one asked for. */
function rejectForeignFields(input: OwnershipInput): void {
  const foreign = Object.entries(ACTION_ONLY_FIELDS)
    .filter(
      ([field, owner]) =>
        owner !== input.action && input[field as keyof OwnershipInput] !== undefined,
    )
    .map(([field]) => field);

  if (foreign.length === 0) return;
  const list = foreign.map((field) => `\`${field}\``).join(" and ");
  throw new InvalidInputError(
    `ownership action "${input.action}" does not accept ${list}, which ${
      foreign.length === 1 ? "belongs" : "belong"
    } to action "claim". Remove ${list}, or use the action that takes ${
      foreign.length === 1 ? "it" : "them"
    }.`,
    { fields: foreign },
  );
}

/** Refuses an action that is missing a field it cannot run without. */
function requireFields(input: OwnershipInput): void {
  const missing = OWNERSHIP_ACTION_FIELDS[input.action].required.filter(
    (field) => input[field as keyof OwnershipInput] === undefined,
  );
  if (missing.length === 0) return;
  const list = missing.map((field) => `\`${field}\``).join(" and ");
  throw new InvalidInputError(
    `ownership action "${input.action}" requires ${list}, which ${
      missing.length === 1 ? "was" : "were"
    } not supplied. Resend the call with ${list} set.`,
    { fields: missing },
  );
}

// Stryker disable all : this metadata is a module-level literal, read into
// the registry at import — before any test body runs and never re-evaluated
// — so a mutation here is unkillable by construction, NOT untested.
// `scripts/check-operation-metadata-mutants.mjs` requires this and carries
// the full reasoning, including why moving the assertions into a test body
// does not help.
export const ownership = defineOperation({
  name: "ownership",
  kind: "write",
  summary:
    "Changes who holds an item — say which way with action. claim takes it, in a role, for a holder. release gives up YOUR OWN row and cannot end anybody else's. takeover displaces the current holder, naming both the session being displaced and the one taking over, and does not stop the displaced session — so it needs a reason when that holder may still be alive.",
  contract: {
    rules: [
      {
        fields: ["action", "sessionId", "fromSessionId", "bySessionId"],
        rule: 'Three actions, three meanings of "which session". On claim, sessionId is the session claiming. On release it is the session giving up its OWN live row — a session can only release what it holds, so to end somebody else\'s claim use takeover instead. takeover takes neither: it names fromSessionId (being displaced) and bySessionId (taking over) separately, because a call that gets those the wrong way round must be refusable rather than silently correct.',
      },
      {
        fields: ["leaseKey", "rootSessionId"],
        rule: "On action claim, leaseKey carries the crew and the holder together and a call stating neither it nor the full legacy set — sessionId, holderType and holderId — is REFUSED rather than defaulted. If you were dispatched, ask the agent that dispatched you for its key. The legacy fields still work meanwhile: on that path an omitted rootSessionId still DEFAULTS TO YOUR OWN sessionId, declaring this session the root of a new crew, which is right for an orchestrator and wrong for a dispatched agent claiming alongside one. parentSessionId is a separate field for the spawn tree and does NOT satisfy this.",
      },
      {
        fields: ["action", "reason", "force"],
        rule: "On action takeover, reason is REQUIRED when the holder may still be alive, and force acknowledges the warning. Whether that applies depends on how quiet the holder has been, which is a fact about the database rather than the input — so the schema accepts both as optional and the operation refuses the case that matters.",
      },
    ],
  },
  // Stryker restore all
  input: inputSchema,
  async handler(ctx: ServiceContext, input: OwnershipInput): Promise<unknown> {
    rejectForeignFields(input);
    requireFields(input);

    // Each branch forwards only the fields its operation's `.strict()`
    // schema accepts, and forwards each as it arrived — absent stays
    // absent, so every default belongs to the operation that declares it.
    // A field this tool accepts that the chosen delegate does not is
    // refused by that delegate's own parse, naming itself.
    switch (input.action) {
      case "claim":
        return claim.handler(
          ctx,
          parseDelegateInput(
            claim.name,
            claim.input,
            {
              itemId: input.itemId,
              role: input.role,
              ...(input.holderType === undefined ? {} : { holderType: input.holderType }),
              ...(input.holderId === undefined ? {} : { holderId: input.holderId }),
              ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
              ...(input.leaseKey === undefined ? {} : { leaseKey: input.leaseKey }),
              ...(input.roleCustom === undefined ? {} : { roleCustom: input.roleCustom }),
              ...(input.rootSessionId === undefined ? {} : { rootSessionId: input.rootSessionId }),
              ...(input.parentSessionId === undefined
                ? {}
                : { parentSessionId: input.parentSessionId }),
              ...(input.machine === undefined ? {} : { machine: input.machine }),
              ...(input.pid === undefined ? {} : { pid: input.pid }),
              ...(input.branch === undefined ? {} : { branch: input.branch }),
              ...(input.worktree === undefined ? {} : { worktree: input.worktree }),
              ...(input.model === undefined ? {} : { model: input.model }),
              ...(input.effort === undefined ? {} : { effort: input.effort }),
            },
            ctx.caller.transport,
          ),
        );
      case "release":
        return release.handler(
          ctx,
          parseDelegateInput(
            release.name,
            release.input,
            { itemId: input.itemId, sessionId: input.sessionId },
            ctx.caller.transport,
          ),
        );
      case "takeover":
        return takeover.handler(
          ctx,
          parseDelegateInput(
            takeover.name,
            takeover.input,
            {
              itemId: input.itemId,
              fromSessionId: input.fromSessionId,
              bySessionId: input.bySessionId,
              holderType: input.holderType,
              holderId: input.holderId,
              ...(input.reason === undefined ? {} : { reason: input.reason }),
              ...(input.force === undefined ? {} : { force: input.force }),
            },
            ctx.caller.transport,
          ),
        );
    }
  },
});
