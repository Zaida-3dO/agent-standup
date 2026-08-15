// `get_crew_name` — SCHEMA.md §9, §18, PLAN.md ("Crew: get me a name."),
// MILESTONES.md #82.
//
// **Not how an agent gets named.** An agent's name is assigned as a side
// effect of `register_session` and `claim` (`ensureNameForSession`,
// `@/lib/agent-names`) — the two calls a session already makes to register
// itself and to take ownership of an item — so an agent never calls this
// operation at all, and it is waived out of both MCP adapters
// (`@/lib/adapters/waivers.ts`) for exactly that reason: nothing an agent
// does should name it in a tool list.
//
// **What this operation is for, and why it stays registered.** A direct
// "hand me any available name, right now, with no other side effect" is
// occasionally useful outside the agent path — an operator pre-warming a
// name before a session exists, a script auditing the pool — and HTTP/the
// command line cost nothing to keep it reachable for that
// (`@/lib/adapters/waivers.ts`'s own reasoning for `backfill` applies
// equally here: no registered guard can reject this operation, so waiving
// it from the MCP tool list only loses a call nothing needs to make, not
// guard coverage). A thin wrapper over `handOutName` (src/lib/agent-names.ts,
// MILESTONES.md #34) — the atomic "pick any available row, under
// concurrency" SQL lives there and is not duplicated here.
//
// **Only hand-out is exposed here, not assign/retire.** No row in
// MILESTONES.md's command-line section asks for an administrative
// assign/retire surface. Those two stay reachable only through
// `agent-names.ts` directly (e.g. a seed script) until a row actually needs
// them from an adapter — adding operations nothing calls would be exactly
// the surface §22's registry-driven completeness assertion is designed to
// keep honest.
import { z } from "zod";
import { ConflictError } from "../errors";
import { defineOperation } from "../operation";
import type { ServiceContext } from "../context";
import { handOutName, type AgentNameRow } from "@/lib/agent-names";

const inputSchema = z
  .object({
    sessionId: z.string().min(1),
  })
  .strict();

export type GetCrewNameInput = z.infer<typeof inputSchema>;

export const getCrewName = defineOperation({
  name: "get_crew_name",
  kind: "write",
  summary: "Requests a name for a new agent. Hands out one available name, atomically.",
  input: inputSchema,
  async handler(ctx: ServiceContext, input: GetCrewNameInput): Promise<AgentNameRow> {
    const name = await handOutName(ctx.db, input.sessionId);
    if (!name) {
      // The roster is exhausted — every name is retired or already held.
      // Not the caller's fault, and not `not_found` (nothing named was
      // looked up): the installation cannot satisfy the request right now,
      // the same posture `assignName`'s "already held" refusal takes
      // (agent-names.ts) toward a row that exists but cannot be had.
      throw new ConflictError("No crew name is available — every name is retired or held.", {
        fields: [],
      });
    }
    return name;
  },
});
