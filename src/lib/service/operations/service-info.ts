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
import type { ServiceContext } from "../context";

/** The catalogue entry for one operation, as a caller reads it. */
export interface OperationDescriptor {
  readonly name: string;
  readonly kind: "read" | "write";
  readonly summary: string;
}

export interface ServiceInfo {
  readonly operations: readonly OperationDescriptor[];
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

export const serviceInfo = defineOperation({
  name: "service_info",
  kind: "read",
  summary: "What this build exposes, and the limits a caller has to respect.",
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
