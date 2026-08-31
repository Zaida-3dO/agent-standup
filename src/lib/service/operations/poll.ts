// `poll` — SCHEMA.md §19 `POST /poll`, §15, §17.7. MILESTONES.md #58.
//
// The machine-facing call, and the design constraint the milestone states as
// its end condition: "each machine runs nothing but a ~30-line poller on a
// scheduled task, and every decision it acts on was made server-side."
//
// So this operation is deliberately lopsided. The machine reports facts it
// alone can see — how many sessions it has running, what its agent tool says
// about usage, which of its source files have changed — and the server
// answers with everything the poller would otherwise have had to work out.
// Nothing here asks the machine to decide anything, and nothing returned
// asks it to compute anything: the globs it should scan are resolved here
// against its own override, the band it is in is decided here, and the
// interval it should wait is read from configuration here.
//
// Three facts a caller reports, and why each is worth a column:
//
//   - `liveSessions` is a hint, not truth (§15). It is stale between polls,
//     but it knows about sessions that launched and have not yet made a tool
//     call, which the server cannot see. Treat it as a floor.
//   - the usage snapshot goes through the same promotion path the hook uses
//     (`budget/promote.ts`), because where a reading goes and what makes it
//     trustworthy do not depend on which door it arrived through.
//   - `pendingSources` is carried but not yet acted on. Minting is #63 and
//     is deliberately not built here; the field exists so the poller's shape
//     does not change when it lands.
//
// **Dispatches are always empty, and that is not a stub.** A dispatch is a
// planner's output (#59) with a server-composed prompt (#60), and neither
// exists. Returning the field as an empty list rather than omitting it is
// what lets a poller be written once: it reads `dispatches`, finds none, and
// sleeps — which is exactly what it will do on a quiet server after the
// planner ships. Omitting the field would make every poller need a version
// check the moment it appeared.
import { z } from "zod";
import { defineOperation } from "../operation";
import type { ServiceContext } from "../context";
import { resolveMachine } from "../machine-identity";
import { effectiveSourceGlobs, readMachineSourceGlobs } from "@/lib/settings/overrides";
import { promoteUsage } from "@/lib/budget/promote";
import { resolveReading } from "@/lib/budget/reading";
import { decideBand, type BandDecision } from "@/lib/budget/bands";
import { effectiveBudgetWindows } from "@/lib/settings/overrides";

/**
 * A usage figure as a machine reports it.
 *
 * Bounded 0–1000 rather than 0–100: over-spend past a limit is real and a
 * reading of 104% is information, while a figure in the thousands is a unit
 * error (a token count where a percentage was meant) and is refused rather
 * than stored as a number every band comparison would then read as `stop`.
 */
const usageFigure = z.number().finite().min(0).max(1000);

const inputSchema = z
  .object({
    /**
     * Which machine is asking. Reconciled against the machine the transport
     * proved, per `machine-identity.ts` — a caller authenticated as one
     * machine cannot poll as another.
     */
    machine: z.string().min(1),
    /** How many sessions it believes are running. A floor, never truth (§15). */
    liveSessions: z.number().int().min(0).default(0),
    usage5h: usageFigure.optional(),
    usageWeekly: usageFigure.optional(),
    /**
     * When the machine took that snapshot. Optional: a poller with no usage
     * to report has no time to report either. Defaults to the moment the
     * poll is handled when usage is present without one, which is the
     * closest honest value the server can supply for a reading that has just
     * arrived.
     */
    usageAt: z.coerce.date().optional(),
    /**
     * Hashes of the sources the machine has waiting to be minted. Carried
     * for #63; recorded in the response count and otherwise unused.
     */
    pendingSources: z.array(z.string().min(1)).max(1000).default([]),
    /**
     * How far into each budget window this machine's account is, keyed by
     * window name. Supplied by the caller for the same reason
     * `bands.ts` takes it as a parameter: where a vendor's window starts is
     * that vendor's billing calendar, not something this build derives.
     */
    elapsedHours: z.record(z.string().min(1), z.number().finite().min(0)).default({}),
  })
  .strict();

export type PollInput = z.infer<typeof inputSchema>;

export interface PollOutput {
  /** The machine the poll was recorded against — the proved one, where one was proved. */
  readonly machine: string;
  /** The declared machine, where it contradicted the proved one and was discarded. */
  readonly overrodeMachine: string | null;
  /** Seconds to wait before polling again. Configuration, resolved here. */
  readonly intervalSeconds: number;
  /** The globs this machine should scan: its own override, or the setting. */
  readonly sourceGlobs: readonly string[];
  /** How many pending source hashes were reported. Minting itself is #63. */
  readonly pendingSourceCount: number;
  /** What promoting the usage snapshot did. */
  readonly usage: { readonly status: string; readonly accountIds?: readonly string[] };
  /** The band governing each of this machine's accounts, keyed by account id. */
  readonly bands: Readonly<Record<string, BandDecision>>;
  /** Always empty until the planner (#59) and prompt composition (#60) land. */
  readonly dispatches: readonly never[];
}

// Stryker disable all : this metadata is a module-level literal, read into
// the registry at import — before any test body runs and never re-evaluated
// — so a mutation here is unkillable by construction, NOT untested.
// `scripts/check-operation-metadata-mutants.mjs` requires this and carries
// the full reasoning, including why moving the assertions into a test body
// does not help.
export const poll = defineOperation({
  name: "poll",
  kind: "write",
  summary:
    "A machine reports its sessions and usage, and is told what to do: how long to wait, " +
    "which sources to scan, and which budget band each of its accounts is in.",
  // Stryker restore all
  input: inputSchema,
  contract: {
    rules: [
      {
        fields: ["machine"],
        rule:
          "The machine a per-machine token authenticated as wins over the one named here, and " +
          "the declared value is reported back as overrodeMachine rather than refused. A " +
          "transport that proves no machine (the direct binding) stores what is declared.",
      },
      {
        fields: ["usage5h", "usageWeekly", "usageAt"],
        rule:
          "A snapshot is only stored when it is newer than the one the account already holds, " +
          "so two machines polling one account cannot overwrite a fresh reading with a stale " +
          "one. A poll carrying neither figure leaves the stored reading and its timestamp " +
          "entirely alone.",
      },
      {
        fields: ["elapsedHours"],
        rule:
          "A window with no elapsed figure is not evaluated, because where a vendor's window " +
          "starts is that vendor's billing calendar rather than something this build derives. " +
          "Its account is reported unbanded with a reason, never defaulted to the start of " +
          "the window.",
      },
    ],
    example: {
      machine: "desktop",
      liveSessions: 2,
      usage5h: 41.5,
      usageAt: "2026-08-31T12:00:00.000Z",
      elapsedHours: { fiveHour: 1.5 },
    },
  },
  async handler(ctx: ServiceContext, input: PollInput): Promise<PollOutput> {
    const resolved = resolveMachine(ctx.caller, input.machine);
    const machine = resolved.machine;
    // A poll is the first thing a new machine does, and §19 gives it no
    // creation verb of its own, so the row is created here. `sourceGlobs`
    // is left at its default on creation — a machine that has never been
    // configured inherits the setting, which is what a NULL means. Only the
    // two poll-owned columns are written on conflict, so a poll can never
    // clobber an override an operator set through `update_machine`.
    await ctx.db.$executeRawUnsafe(
      `INSERT INTO "Machine" ("name", "lastPollAt", "liveSessions")
       VALUES ($1, CURRENT_TIMESTAMP, $2)
       ON CONFLICT ("name") DO UPDATE
         SET "lastPollAt" = CURRENT_TIMESTAMP,
             "liveSessions" = $2`,
      machine,
      input.liveSessions,
    );

    const promotion = await promoteUsage(ctx.db, machine, {
      usage5h: input.usage5h ?? null,
      usageWeekly: input.usageWeekly ?? null,
      // A reading that arrives without its own time is stamped now rather
      // than refused: the poll is the moment it was reported, which is at
      // most one round trip from when it was taken. Ageing it from here is
      // conservative — it can only ever make a reading look older.
      takenAt: input.usageAt ?? new Date(),
    });

    const overrides = await readMachineSourceGlobs(ctx.db, machine);
    const sourceGlobs = effectiveSourceGlobs(overrides, ctx.settings);

    const bands = await bandsForMachine(ctx, machine, input.elapsedHours);

    return {
      machine,
      overrodeMachine: resolved.overrode,
      intervalSeconds: ctx.settings.values["poll.interval_seconds"],
      sourceGlobs,
      pendingSourceCount: input.pendingSources.length,
      usage:
        promotion.status === "written"
          ? { status: promotion.status, accountIds: promotion.accountIds }
          : { status: promotion.status },
      bands,
      dispatches: [],
    };
  },
});

/**
 * The band governing each account this machine can dispatch against.
 *
 * Read after the promotion above, deliberately: the poll that carries a
 * reading is banded against that reading rather than against the previous
 * one, which is what makes a poller's answer current on the same round trip
 * that reported it.
 *
 * The two per-entity overrides §17.7 permits both apply here, and both are
 * resolved through the shared helpers rather than re-implemented — an
 * account's `budget_windows` through `effectiveBudgetWindows`, a machine's
 * `source_globs` through `effectiveSourceGlobs` in the handler above. A
 * stored override that fails validation falls back to the global value and
 * does not fail the poll, matching §17.3's rule for a setting whose schema
 * has tightened.
 */
async function bandsForMachine(
  ctx: ServiceContext,
  machine: string,
  elapsedHours: Readonly<Record<string, number>>,
): Promise<Record<string, BandDecision>> {
  const rows = await ctx.db.$queryRawUnsafe<
    {
      id: string;
      usage5h: unknown;
      usageAt: Date | string | null;
      budgetWindows: unknown;
    }[]
  >(
    `SELECT a."id",
            a."usage5h",
            a."usageAt",
            a."budget_windows" AS "budgetWindows"
       FROM "Account" a
       JOIN "MachineAccount" ma ON ma."accountId" = a."id"
      WHERE ma."machineName" = $1
      ORDER BY a."id" ASC`,
    machine,
  );

  const staleAfter = ctx.settings.values["budget.reading_stale_after_seconds"];
  const budgetEnabled = ctx.settings.values["budget.enabled"];
  const now = new Date();

  const bands: Record<string, BandDecision> = {};
  for (const row of rows) {
    const reading = resolveReading(
      { value: row.usage5h as string | number | null, takenAt: row.usageAt },
      now,
      staleAfter,
    );
    const { windows } = effectiveBudgetWindows(row.budgetWindows, ctx.settings);
    bands[row.id] = decideBand({ windows, reading, elapsedHours }, budgetEnabled);
  }
  return bands;
}
