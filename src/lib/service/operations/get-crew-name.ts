// `get_crew_name` — SCHEMA.md §9, §18 (`get_crew_name`: "Request a name for
// a new agent"), PLAN.md ("Crew: get me a name."), MILESTONES.md #82.
//
// Thin wrapper around `handOutName` (src/lib/agent-names.ts, MILESTONES.md
// #34) — the atomic "pick any available row, under concurrency" SQL already
// lives there and is not duplicated here. #34 delivered the hand-out/
// assign/retire logic but no service operation and no route, so nothing
// could reach it through the one door every adapter is required to use
// (`CLAUDE.md` "Working in this repo": "no adapter may reach the database
// or a guard directly"). This is that missing operation, following the same
// thin-wrapper shape #29's `claim`/`release`/`heartbeat` use over
// `claims.ts`: input validation against a schema every adapter shares, and
// registration so the command line (`standup crew name`) reaches the same
// atomic hand-out through the same door.
//
// **Only hand-out is exposed here, not assign/retire.** PLAN.md's own scope
// for what an agent needs is exactly "get me a name" — the MCP tool list
// (SCHEMA.md §18) has `get_crew_name` and nothing else naming-shaped, and no
// row in MILESTONES.md's command-line section asks for an administrative
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
