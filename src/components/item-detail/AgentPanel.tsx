// The agent view — `orientation` for this item, which is what an agent
// picking the work up would actually be handed.
//
// Every other panel on this page shows what a person can see. This one shows
// what the fleet sees, and those are the two halves of "why did it do that".
// When an agent behaves oddly the highest-value artifact is not its output,
// it is its input — and that input existed only inside a tool response
// nobody could look at afterwards.
//
// ── Bounded, everywhere, on purpose ────────────────────────────────────
//
// The payload's size is not predictable: it embeds the whole item record — a
// single body has been measured at 49,000 characters — plus an unbounded
// event list, and a real response has come back at over 165,000 characters.
// Rendering it whole would recreate exactly the unbounded-height problem the
// tabs were introduced to fix, one tab along.
//
// The bounding happens in `@/lib/item-detail/orientation`, before anything
// reaches this component, and NOT in CSS. A `max-height` with an overflow
// still builds every node and still puts every character into the
// accessibility tree and into a page search — it hides the content without
// removing the cost. Here the long values never enter the tree at all, and
// each one says how much it left out, because a clipped value that does not
// announce itself cannot be told from a complete one.
//
// The raw payload stays reachable in a collapsed block, because diagnosing
// an odd input sometimes needs the exact bytes. It is bounded too, and it
// arrives here already serialised — the panel never holds the payload
// object, only the string that was cut from it.
//
// Hook-free and prop-driven — see `tests/helpers/react-element.ts`. The
// fetching lives in `AgentPanelContainer`.
import type { AgentView, AgentViewLoop, BoundedText } from "@/lib/item-detail/orientation";
import styles from "./ItemDetail.module.css";

export type AgentPanelState =
  | { readonly status: "idle" }
  | { readonly status: "loading" }
  | { readonly status: "error"; readonly message: string }
  | { readonly status: "loaded"; readonly view: AgentView };

export interface AgentPanelProps {
  readonly state: AgentPanelState;
  /** Fetches (or refetches) the orientation. Absent renders the panel read-only. */
  readonly onLoad?: () => void;
}

/**
 * A bounded value, with its clipping stated.
 *
 * The note is part of the value, not a footnote: "600 of 49,214 characters"
 * is the difference between a reader believing they have read the body and
 * knowing they have read the opening of it.
 */
function Bounded({ value, className }: { value: BoundedText; className?: string }) {
  if (value.text === "") return null;
  return (
    <span className={className}>
      {value.text}
      {value.clipped && (
        <span className={styles.clipped}>
          {" "}
          … {value.text.length.toLocaleString("en-GB")} of{" "}
          {value.fullLength.toLocaleString("en-GB")} characters shown
        </span>
      )}
    </span>
  );
}

function LoopList({ loops, label }: { loops: readonly AgentViewLoop[]; label: string }) {
  if (loops.length === 0) return null;
  return (
    <div className={styles.agentGroup} data-loops={label}>
      <h4 className={styles.agentGroupTitle}>
        {label}
        <span className={styles.planCount}>{loops.length}</span>
      </h4>
      <ul className={styles.agentList}>
        {loops.map((loop, index) => (
          <li key={index} className={styles.agentRow}>
            <Bounded value={loop.text} />
            {loop.detail.text !== "" && (
              <Bounded value={loop.detail} className={styles.agentRowDetail} />
            )}
            {loop.itemId !== null && (
              <a className={styles.followUpLink} href={`/items/${encodeURIComponent(loop.itemId)}`}>
                {loop.itemId}
              </a>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

export function AgentPanel({ state, onLoad }: AgentPanelProps) {
  // Idle rather than auto-fetching: this is a diagnostic, wanted by a reader
  // who came looking for it, and `orientation` is the most expensive read
  // the page can make. Paying for it on every visit to an item — including
  // every visit that never opens this tab — would be the page's largest
  // cost spent on its least-used panel.
  if (state.status === "idle") {
    return (
      <section className={styles.section} aria-label="Agent view">
        <p className={styles.agentLead}>
          What an agent picking this item up would be handed — its latest checkpoint, what changed
          since, the open loops, and who is on the crew.
        </p>
        {onLoad && (
          <button type="button" className={styles.agentAction} onClick={onLoad}>
            Load agent view
          </button>
        )}
      </section>
    );
  }

  if (state.status === "loading") {
    return (
      <section className={styles.section} aria-label="Agent view">
        <p className={styles.empty}>Loading the agent view…</p>
      </section>
    );
  }

  if (state.status === "error") {
    return (
      <section className={styles.section} aria-label="Agent view">
        <p className={styles.agentError}>{state.message}</p>
        {onLoad && (
          <button type="button" className={styles.agentAction} onClick={onLoad}>
            Try again
          </button>
        )}
      </section>
    );
  }

  const { view } = state;
  // Already bounded, and already a string: the view builder serialised it
  // at the boundary and dropped the payload object, so nothing here is
  // holding the full response.
  const raw = view.raw;

  return (
    <section className={styles.section} aria-label="Agent view">
      <p className={styles.agentLead}>
        What an agent picking this item up would be handed. Long values are shortened here and say
        how much they left out.
      </p>

      <div className={styles.agentGroup}>
        <h4 className={styles.agentGroupTitle}>Item, as the agent reads it</h4>
        <dl className={styles.agentFields}>
          <dt className={styles.agentKey}>title</dt>
          <dd className={styles.agentValue}>
            <Bounded value={view.itemTitle} />
          </dd>
          <dt className={styles.agentKey}>state</dt>
          <dd className={styles.agentValue}>{view.itemState}</dd>
          {view.itemBody.text !== "" && (
            <>
              <dt className={styles.agentKey}>body</dt>
              <dd className={styles.agentValue}>
                {/* Plain text, not markdown. This panel reports what the
                    agent was given, and rendering it as prose would show a
                    reader something prettier than the string that was
                    actually in the payload — which is the one thing a
                    diagnostic must not do. */}
                <pre className={styles.agentPre}>
                  <Bounded value={view.itemBody} />
                </pre>
              </dd>
            </>
          )}
        </dl>
      </div>

      <div className={styles.agentGroup}>
        <h4 className={styles.agentGroupTitle}>Latest checkpoint</h4>
        {view.checkpoint === null ? (
          <p className={styles.empty}>
            No checkpoint recorded — an agent resuming this item is told nothing about where it was
            left.
          </p>
        ) : (
          <dl className={styles.agentFields}>
            <dt className={styles.agentKey}>at</dt>
            <dd className={styles.agentValue}>{view.checkpoint.ts}</dd>
            <dt className={styles.agentKey}>headline</dt>
            <dd className={styles.agentValue}>
              <Bounded value={view.checkpoint.headline} />
            </dd>
            {view.checkpoint.body.text !== "" && (
              <>
                <dt className={styles.agentKey}>body</dt>
                <dd className={styles.agentValue}>
                  <pre className={styles.agentPre}>
                    <Bounded value={view.checkpoint.body} />
                  </pre>
                </dd>
              </>
            )}
          </dl>
        )}
      </div>

      <div className={styles.agentGroup}>
        <h4 className={styles.agentGroupTitle}>
          What changed
          <span className={styles.planCount}>{view.eventsTotal}</span>
        </h4>
        {view.events.length === 0 ? (
          <p className={styles.empty}>Nothing has changed since that cursor.</p>
        ) : (
          <>
            <ul className={styles.agentList}>
              {view.events.map((event) => (
                <li key={event.id} className={styles.agentRow} data-event-type={event.type}>
                  <span className={styles.historyTs}>
                    {event.ts.slice(0, 16).replace("T", " ")}
                  </span>
                  <span className={styles.historyType}>{event.type.replace(/_/g, " ")}</span>
                  <Bounded value={event.body} className={styles.historyBody} />
                </li>
              ))}
            </ul>
            {/* The cap says so, with the real total beside it — a capped
                list that reads as complete is the failure this panel is
                otherwise built to avoid. */}
            {view.eventsTotal > view.events.length && (
              <p className={styles.truncated}>
                Showing {view.events.length} of {view.eventsTotal} events — the Activity tab has the
                rest.
              </p>
            )}
          </>
        )}
      </div>

      <div className={styles.agentGroup}>
        <h4 className={styles.agentGroupTitle}>Open loops</h4>
        {view.openLoops.notDone.length === 0 &&
        view.openLoops.children.length === 0 &&
        view.openLoops.loops.length === 0 ? (
          <p className={styles.empty}>Nothing outstanding.</p>
        ) : (
          <>
            {/* The three sources stay apart, exactly as the operation
                returns them: what a completed item deliberately left undone,
                unfinished work that is itself an item, and a loose end the
                session is carrying. They call for different responses, and
                flattening them would lose which is which. */}
            <LoopList loops={view.openLoops.notDone} label="Left not done" />
            <LoopList loops={view.openLoops.children} label="Unfinished children" />
            <LoopList loops={view.openLoops.loops} label="Loops still open" />
          </>
        )}
      </div>

      <div className={styles.agentGroup}>
        <h4 className={styles.agentGroupTitle}>
          Crew
          <span className={styles.planCount}>{view.crew.length}</span>
        </h4>
        {view.crew.length === 0 ? (
          <p className={styles.empty}>Nobody holds this item.</p>
        ) : (
          <ul className={styles.agentList}>
            {view.crew.map((member, index) => (
              <li key={index} className={styles.agentRow}>
                <span className={styles.agentKey}>{member.role}</span>
                <span>{member.holder}</span>
                {member.machine !== null && (
                  <span className={styles.agentRowDetail}>{member.machine}</span>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      <details className={styles.agentRawBlock}>
        <summary className={styles.disclosureSummary}>Raw payload</summary>
        <pre className={styles.agentPre} data-raw="">
          {raw.text}
          {raw.clipped && (
            <span className={styles.clipped}>
              {"\n"}… {raw.text.length.toLocaleString("en-GB")} of{" "}
              {raw.fullLength.toLocaleString("en-GB")} characters shown
            </span>
          )}
        </pre>
      </details>
    </section>
  );
}
