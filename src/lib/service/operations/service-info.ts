// `service_info` — what this build exposes and under what limits.
//
// A read every adapter wants a version of: the command line's preflight
// asks it, a client checks it before assuming an operation exists, and the
// conformance harness gets an operation that is genuinely exercised rather
// than a placeholder. It reads the call's settings snapshot and touches no
// table, so it works against an empty database.
import { z } from "zod";
import { InvalidInputError } from "../errors";
import { defineOperation } from "../operation";
import { currentBuildInfo, type BuildInfo } from "@/lib/build-info";
import type { ServiceContext } from "../context";

/** The catalogue entry for one operation, as a caller reads it. */
export interface OperationDescriptor {
  readonly name: string;
  readonly kind: "read" | "write";
  readonly summary: string;
}

export interface ServiceInfo {
  readonly operations: readonly OperationDescriptor[];
  /**
   * What code is actually running — version, git revision and build time.
   *
   * The whole point of carrying it on this read: `service_info` is the one
   * call every adapter already exposes and every client already knows how
   * to make, so putting the running revision here is what makes "what is
   * deployed" answerable in a single tool call, with no shell access to
   * the deploy host. See `src/lib/build-info.ts` for why the values come
   * from the build rather than from a checked-in constant.
   */
  readonly build: BuildInfo;
  /** Settings a caller has to respect to make a valid request. */
  readonly limits: {
    readonly maxDepth: number;
    readonly waitTimeoutSeconds: number;
  };
  /** The settings revision this answer was resolved at. */
  readonly settingsRevision: string;
}

const inputSchema = z
  .object({
    /** Restrict the catalogue to one kind. Omitted returns both. */
    kind: z.enum(["read", "write"]).optional(),
  })
  .strict();

export type ServiceInfoInput = z.infer<typeof inputSchema>;

/**
 * Set by the registry module once it has built the catalogue.
 *
 * The indirection is what breaks an import cycle that would otherwise be
 * real: the registry imports every operation, so an operation cannot import
 * the registry. A function the registry installs lets this operation read
 * the catalogue without depending on the module that contains it.
 */
let catalogue: (() => readonly OperationDescriptor[]) | null = null;

export function provideCatalogue(source: () => readonly OperationDescriptor[]): void {
  catalogue = source;
}

// Stryker disable all : this metadata is a module-level literal, read into
// the registry at import — before any test body runs and never re-evaluated
// — so a mutation here is unkillable by construction, NOT untested.
// `scripts/check-operation-metadata-mutants.mjs` requires this and carries
// the full reasoning, including why moving the assertions into a test body
// does not help.
export const serviceInfo = defineOperation({
  name: "service_info",
  kind: "read",
  summary: "What this build exposes, and the limits a caller has to respect.",
  // Stryker restore all
  input: inputSchema,
  async handler(ctx: ServiceContext, input: ServiceInfoInput): Promise<ServiceInfo> {
    if (!catalogue) {
      // Reachable only if this operation is called without the registry
      // module having loaded, which the registry's own construction
      // prevents. Refused rather than answered with an empty catalogue: a
      // caller that believes the build exposes nothing is worse served
      // than one that is told the question could not be answered.
      throw new InvalidInputError("The operation catalogue is unavailable.", {
        fields: ["kind"],
      });
    }
    const all = catalogue();
    const operations = input.kind ? all.filter((entry) => entry.kind === input.kind) : all;
    return {
      operations,
      // Read per call, not captured at module load — see `currentBuildInfo`.
      build: currentBuildInfo(),
      limits: {
        maxDepth: ctx.settings.values["items.max_depth"],
        waitTimeoutSeconds: ctx.settings.values["crew.wait_timeout_seconds"],
      },
      // A string, because a revision is a bigint and JSON has no bigint —
      // an adapter that serialises the answer would throw on it.
      settingsRevision: ctx.settings.revision.toString(),
    };
  },
});
