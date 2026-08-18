// Fetching the agent view — the pure half of the orientation panel's
// loading, split out for the same reason `state.ts` is: this repo's harness
// runs `environment: "node"` with no DOM, so the fetch shaping and the
// error messages are only directly testable as plain functions.
import { uiApiPath } from "@/lib/ui-proxy/path";
import { agentViewFrom, type AgentView } from "./orientation";

/**
 * One item's orientation from `GET /api/items/{id}/orientation`, already
 * bounded into an `AgentView`.
 *
 * Throws a message fit to show directly — never a raw `Response` or a
 * JSON-parse error — matching `fetchItemDetail` and `fetchBoard`.
 *
 * **The bounding happens here rather than in the component.** The whole
 * point is that the oversized value never reaches the render tree, so the
 * boundary it is applied at should be the one the payload enters through.
 * A component that received the raw payload and bounded it on the way out
 * would already be holding the 165,000-character string it exists to avoid.
 */
export async function fetchAgentView(
  id: string,
  fetchImpl: typeof fetch = fetch,
): Promise<AgentView> {
  const response = await fetchImpl(uiApiPath(`/api/items/${encodeURIComponent(id)}/orientation`));
  if (!response.ok) {
    if (response.status === 404) {
      throw new Error(`No such item: ${id}.`);
    }
    throw new Error(
      `Could not load the agent view (GET /api/items/${id}/orientation returned ${response.status}).`,
    );
  }
  return agentViewFrom(await response.json());
}

/** Turns a caught value into the message the panel's error state shows. */
export function agentViewErrorMessageFrom(err: unknown): string {
  return err instanceof Error ? err.message : "Could not load the agent view.";
}
