// The operation registry — the canonical index of service operations.
// See docs/plans/SCHEMA.md §22.
//
// This is the module the conformance harness iterates to decide what every
// adapter must expose, so it has to be genuinely canonical rather than
// documentation that happens to be in TypeScript. Two properties make it
// so, and both are structural:
//
//   1. `callOperation` dispatches by looking a name up *here*. An operation
//      absent from this index is not merely undocumented — it is
//      unreachable through the service layer, so an adapter cannot expose
//      it and the harness cannot miss it.
//   2. `OperationName` is derived from this object's keys, so a map typed
//      by it (an adapter's handler table, a driver map) does not compile
//      while an operation is missing. That is the compile-time half of
//      §22's completeness assertion, paid once here rather than per
//      adapter.
//
// The list is written out rather than assembled by scanning the directory
// at runtime. A glob would make "every operation is registered" true by
// construction and untestable, and it does not survive bundling — the
// application ships as a Next.js bundle where the operations directory does
// not exist as a directory at run time. Written out, forgetting an entry is
// a mistake a test can catch; that test is `tests/service-registry.test.ts`,
// which reads the directory from source and asserts every operation
// declared there appears here.
import type { AnyOperation, Operation, OperationKind } from "./operation";
import { provideCatalogue, serviceInfo, type OperationDescriptor } from "./operations/service-info";
// Tool documentation on demand (MILESTONES.md #111). Registered like any
// other operation, so every adapter exposes it without per-adapter work and
// a refusal on any surface can point at a call the caller actually has.
import { describeTool, provideToolIndex } from "./operations/describe-tool";
import { createItem } from "./operations/create-item";
// The three explicit creates. One operation per kind, so a caller states
// which of project/task/subtask it wants rather than having it inferred from
// whether a parent pointer happened to be supplied — `create_item` above is
// the deprecated shim that inferred it.
import { createProject } from "./operations/create-project";
import { createTask } from "./operations/create-task";
import { createSubtask } from "./operations/create-subtask";
// The three explicit creates behind one tool, chosen with a required `type`.
// Not a return to `create_item`'s inference — `type` is stated by the caller
// and a combination that cannot produce it is refused by name. Registered
// alongside the three, which stay reachable over HTTP and the command line.
import { createWork } from "./operations/create-work";
import { getItem } from "./operations/get-item";
import { updateItem } from "./operations/update-item";
// Correcting an item's *position* in the tree. `kind` is derived from
// parentage and stored, so a parent set at create and never again left an
// item's kind — and therefore whether it has a state at all — permanently
// wrong. These three make position writable: one general move, one narrower
// move whose refusals match a caller that knows it is holding a task, and
// one scan that finds the rows already in that condition.
import { reparentItem } from "./operations/reparent-item";
import { retypeToTask } from "./operations/retype-to-task";
import { repairStuckProjects } from "./operations/repair-stuck-projects";
// Removing an item from every read (MILESTONES.md #137). Registered like any
// other write, and deliberately not waived on any adapter: §22 bounds
// waivers to operations no guard can reject, and this one refuses four ways.
import { deleteItem } from "./operations/delete-item";
import { restoreItem } from "./operations/restore-item";
import { listItems } from "./operations/list-items";
// Finding one item by what it is about (MILESTONES.md #105) — the call the
// bounded reads' notices name for "a specific item", which no filtered list
// read can answer for a caller that knows a phrase rather than an id.
import { search } from "./operations/search";
import { getBoard } from "./operations/get-board";
// Projects with their subtrees rolled up (MILESTONES.md #74) — the grouping
// a store outgrows one flat column of cards, and the only level at which
// progress is a meaningful ratio.
import { getProjects } from "./operations/get-projects";
// Every live assignment in the installation, full detail, in one read — the
// fleet page (M10 T16): "who is doing what right now, and is anything
// wedged?"
import { getFleet } from "./operations/get-fleet";
import { getProjectDetail } from "./operations/get-project-detail";
// Since your last visit (MILESTONES.md #38): the ledger slice, and the
// per-profile read state that decides what in it is new to you.
import { getEvents } from "./operations/get-events";
// The fleet-wide timeline (T19): the same ledger, scrolled *backwards* and
// filtered. A sibling of `get_events` rather than a flag on it — the two
// page in opposite directions, and that operation's header says why.
import { getActivity } from "./operations/get-activity";
import { markEventSeen } from "./operations/mark-event-seen";
// The detail read behind the item view (MILESTONES.md #72) — one item's
// subtask tree, artifacts, history and summary in a single consistent read.
import { getItemDetail } from "./operations/get-item-detail";
// The ledger past `get_item_detail`'s cap, paged server-side (T24). Its own
// read with its own snapshot rather than an offset threaded through the
// detail payload — see its header for why that trade is the right one.
import { getItemHistory } from "./operations/get-item-history";
// `body` past what `get_item`/`get_item_detail` can return whole (row
// 977dc07e): a body over the response-size cap had no read that reached it
// at all, only ones that returned the slim record it was already refused
// from. Paged by character offset rather than a keyset, for the reason its
// own header gives — `body` is one scalar on one row, not a growing set.
import { getItemBody } from "./operations/get-item-body";
// "What needs this person", in one call (T24) — the union three separate
// `list_items` reads used to assemble in the browser.
import { getNeedsYou } from "./operations/get-needs-you";
import { getSettings } from "./operations/get-settings";
import { getSetting } from "./operations/get-setting";
import { patchSettings } from "./operations/patch-settings";
import { putSetting } from "./operations/put-setting";
import { deleteSetting } from "./operations/delete-setting";
import { removeUnrecognisedSetting } from "./operations/remove-unrecognised-setting";
import { claim } from "./operations/claim";
import { release } from "./operations/release";
// Reclamation (MILESTONES.md #99): the liveness ladder's trigger, and the
// takeover that displaces a holder the ladder is not going to release.
import { sweep } from "./operations/sweep";
import { takeover } from "./operations/takeover";
import { heartbeat } from "./operations/heartbeat";
import { checkpoint } from "./operations/checkpoint";
import { note } from "./operations/note";
import { recordArtifact, requestReview } from "./operations/record-artifact";
import { loopAdd, loopClose } from "./operations/open-loops";
// The read half of open loops, and the rest of their lifecycle. Loops could
// be written one at a time and only ever read in bulk, as a side effect of a
// whole-context read — on a long-lived item that overflowed the response
// ceiling, so its loops could not be read at all.
import { loopGet, loopList } from "./operations/loop-reads";
import { loopDelete, loopEdit } from "./operations/loop-lifecycle";
// The six loop verbs behind one tool, chosen with `action`. All seven are
// registered: the six stay reachable over HTTP and the command line, and are
// waived off the MCP adapters only, where a tool list costs context on every
// session (`@/lib/adapters/waivers`).
import { loop } from "./operations/loop";
import { orientation } from "./operations/orientation";
import { myWork } from "./operations/my-work";
// The progress report (MILESTONES.md #136) — session-scoped, and shaped by
// the server so two reports a week apart can be read side by side.
import { progressReport } from "./operations/progress-report";
import { transitionItem } from "./operations/transition-item";
import { completeItem } from "./operations/complete-item";
// Admin — installation-owned entities (MILESTONES.md #92, SCHEMA.md §23).
import { listRepos } from "./operations/list-repos";
import { getRepo } from "./operations/get-repo";
import { createRepo } from "./operations/create-repo";
import { updateRepo } from "./operations/update-repo";
import { listAreas } from "./operations/list-areas";
import { getArea } from "./operations/get-area";
import { createArea } from "./operations/create-area";
import { updateArea } from "./operations/update-area";
// De-duplicating merge (split from row `6b2fb637`) — folds one area's
// membership into another without colliding on `ItemArea`'s composite key
// for an item that already holds both. See that file's header for why this
// is not `update_area` with a flag.
import { mergeAreas } from "./operations/merge-areas";
import { listMachines } from "./operations/list-machines";
import { readiness } from "./operations/readiness";
import { getMachine } from "./operations/get-machine";
import { updateMachine } from "./operations/update-machine";
import { listAccounts } from "./operations/list-accounts";
import { getAccount } from "./operations/get-account";
import { updateAccount } from "./operations/update-account";
import { getCrewName } from "./operations/get-crew-name";
import { listPeople } from "./operations/list-people";
// The `people` write path (MILESTONES.md #116). `list_people` read a table
// nothing could populate until this row; see the operation's header for the
// three capabilities that were dead as a result.
import { updatePerson } from "./operations/update-person";
import { deleteRepo, deleteArea, deletePerson } from "./operations/delete-reference-row";
import { hookDecision } from "./operations/hook-decision";
// The evidence loop for the intervention catalogue (`docs/plans/INTERVENTIONS.md`).
// The guard surface only ever grew, because nothing recorded whether an entry
// earned its cost: `record_intervention` captures a firing, `score_intervention`
// records what a session thought of it, and `get_intervention_scores` is the
// report that names the entries worth removing.
import { recordIntervention } from "./operations/record-intervention";
import { scoreIntervention } from "./operations/score-intervention";
import { getInterventionScores } from "./operations/get-intervention-scores";
// Scoring how a RUN went, as opposed to how an intervention performed
// (MILESTONES.md #66, #67). Two scores per facet, the agent's frozen once
// written and a person's beside it, because the delta between them is the
// measurement. `get_run_scores` keeps the distribution rather than reducing
// to a mean, so a single unusable run is not averaged away by nine good ones.
import { scoreRun } from "./operations/score-run";
import { acceptRunScore } from "./operations/accept-run-score";
import { getRunScores } from "./operations/get-run-scores";
// The capture seam (MILESTONES.md #67): the writer that turns a run's
// review history into a score. Without a caller, a scoring table stays
// empty forever however good its schema is.
import { deriveRunScore } from "./operations/derive-run-score";
// The process registry and the ownership check it exists to feed
// (MILESTONES.md #45). `kill_guard` is the consumer; the other three are
// how the registry gets its contents and how a refusal is explained.
import { registerProcess } from "./operations/register-process";
import { endProcess } from "./operations/end-process";
import { listProcesses } from "./operations/list-processes";
import { killGuard } from "./operations/kill-guard";
// Telemetry (MILESTONES.md #50): the hook's tool-call ingest, and the
// foundation every later M7 row reads. The ingest also maintains `runs`
// (#51) and their recomputed cost (#52); `get_costs` (#53) is the read over
// what it writes.
import { recordToolCalls } from "./operations/record-tool-calls";
// The heartbeat's machine-facing call (MILESTONES.md #58): a machine
// reports its sessions, its usage and what it has waiting to be minted,
// and is told how long to wait, which sources to scan and which budget
// band each of its accounts is in. Every judgement in that answer is made
// here, which is what keeps the machine side a poller rather than a
// scheduler.
import { poll } from "./operations/poll";
// Session shape (MILESTONES.md #54): the read side of the same rows — how a
// session's recent work is going, as opposed to what it cost.
import { getSessionShape } from "./operations/get-session-shape";
// One session end to end (T19): the record of what an agent did, as opposed
// to #54's judgement of how it is behaving. Reuses `get_costs`' arithmetic
// for its spend figure rather than computing a second one.
import { getSessionDetail } from "./operations/get-session-detail";
// Cost (MILESTONES.md #53): the other read over those rows — what the work
// cost, totalled per item, per session and per stage.
import { getCosts } from "./operations/get-costs";
// The registration handshake (MILESTONES.md #43, SCHEMA.md §21). Registered
// like any other operation, so every adapter reaches it through the same
// door and stamps its own transport on the way in.
import { registerSession } from "./operations/register-session";
// Backfill — the one-time bulk load (docs/plans/BACKFILL.md). Registered
// like any other operation so it is reachable and countable; whether it
// answers is decided by `ENABLE_BACKFILL`, and which adapters expose it is
// decided by `../adapters/waivers.ts`.
import { backfill } from "./operations/backfill";

/**
 * Every service operation, by name.
 *
 * `as const satisfies` rather than an annotated type: the annotation would
 * widen every value to `AnyOperation` and lose the per-operation input and
 * output types that make `callOperation` typed at its call sites.
 */
export const OPERATION_REGISTRY = {
  [serviceInfo.name]: serviceInfo,
  [describeTool.name]: describeTool,
  [createItem.name]: createItem,
  [createProject.name]: createProject,
  [createTask.name]: createTask,
  [createSubtask.name]: createSubtask,
  [createWork.name]: createWork,
  [getItem.name]: getItem,
  [updateItem.name]: updateItem,
  [reparentItem.name]: reparentItem,
  [retypeToTask.name]: retypeToTask,
  [repairStuckProjects.name]: repairStuckProjects,
  [deleteItem.name]: deleteItem,
  [restoreItem.name]: restoreItem,
  [listItems.name]: listItems,
  [search.name]: search,
  [getBoard.name]: getBoard,
  [getProjects.name]: getProjects,
  [getProjectDetail.name]: getProjectDetail,
  [getFleet.name]: getFleet,
  [getEvents.name]: getEvents,
  [getActivity.name]: getActivity,
  [markEventSeen.name]: markEventSeen,
  [getItemDetail.name]: getItemDetail,
  [getItemHistory.name]: getItemHistory,
  [getItemBody.name]: getItemBody,
  [getNeedsYou.name]: getNeedsYou,
  [getSettings.name]: getSettings,
  [getSetting.name]: getSetting,
  [patchSettings.name]: patchSettings,
  [putSetting.name]: putSetting,
  [deleteSetting.name]: deleteSetting,
  [removeUnrecognisedSetting.name]: removeUnrecognisedSetting,
  [claim.name]: claim,
  [release.name]: release,
  [sweep.name]: sweep,
  [takeover.name]: takeover,
  [heartbeat.name]: heartbeat,
  [checkpoint.name]: checkpoint,
  [note.name]: note,
  [recordArtifact.name]: recordArtifact,
  [requestReview.name]: requestReview,
  [loopAdd.name]: loopAdd,
  [loopClose.name]: loopClose,
  [loopEdit.name]: loopEdit,
  [loopDelete.name]: loopDelete,
  [loopList.name]: loopList,
  [loopGet.name]: loopGet,
  [loop.name]: loop,
  [orientation.name]: orientation,
  [myWork.name]: myWork,
  [progressReport.name]: progressReport,
  [transitionItem.name]: transitionItem,
  [completeItem.name]: completeItem,
  [listRepos.name]: listRepos,
  [getRepo.name]: getRepo,
  [createRepo.name]: createRepo,
  [updateRepo.name]: updateRepo,
  [deleteRepo.name]: deleteRepo,
  [listAreas.name]: listAreas,
  [getArea.name]: getArea,
  [createArea.name]: createArea,
  [updateArea.name]: updateArea,
  [mergeAreas.name]: mergeAreas,
  [deleteArea.name]: deleteArea,
  [listMachines.name]: listMachines,
  [readiness.name]: readiness,
  [getMachine.name]: getMachine,
  [updateMachine.name]: updateMachine,
  [listAccounts.name]: listAccounts,
  [getAccount.name]: getAccount,
  [updateAccount.name]: updateAccount,
  [getCrewName.name]: getCrewName,
  [listPeople.name]: listPeople,
  [updatePerson.name]: updatePerson,
  [deletePerson.name]: deletePerson,
  [hookDecision.name]: hookDecision,
  [recordIntervention.name]: recordIntervention,
  [scoreIntervention.name]: scoreIntervention,
  [scoreRun.name]: scoreRun,
  [acceptRunScore.name]: acceptRunScore,
  [getRunScores.name]: getRunScores,
  [deriveRunScore.name]: deriveRunScore,
  [getInterventionScores.name]: getInterventionScores,
  [registerProcess.name]: registerProcess,
  [endProcess.name]: endProcess,
  [listProcesses.name]: listProcesses,
  [killGuard.name]: killGuard,
  [recordToolCalls.name]: recordToolCalls,
  [poll.name]: poll,
  [getSessionShape.name]: getSessionShape,
  [getCosts.name]: getCosts,
  [getSessionDetail.name]: getSessionDetail,
  [registerSession.name]: registerSession,
  [backfill.name]: backfill,
} as const satisfies Record<string, AnyOperation>;

export type OperationRegistry = typeof OPERATION_REGISTRY;

/** The name of every registered operation. An adapter map keys on this. */
export type OperationName = keyof OperationRegistry & string;

/** The input type of one operation, so a caller is checked against its schema. */
export type OperationInput<N extends OperationName> =
  OperationRegistry[N] extends Operation<string, infer I, unknown> ? I : never;

/** The output type of one operation. */
export type OperationOutput<N extends OperationName> = OperationRegistry[N] extends {
  handler: (...args: never[]) => Promise<infer O>;
}
  ? O
  : never;

/**
 * Every operation name, enumerable and stable.
 *
 * Sorted so the harness's report and any snapshot of it does not reorder
 * when an entry is added in the middle of the object above.
 */
export const OPERATION_NAMES: readonly OperationName[] = Object.freeze(
  (Object.keys(OPERATION_REGISTRY) as OperationName[]).sort(),
);

/** Whether a string names a registered operation. */
export function isOperationName(value: string): value is OperationName {
  return Object.prototype.hasOwnProperty.call(OPERATION_REGISTRY, value);
}

/**
 * One operation by name, with its types erased.
 *
 * Returns `undefined` rather than throwing, because the caller that needs
 * this is an adapter handling a name that arrived over the wire — a name a
 * user typed is not an exceptional condition, it is an input to validate.
 */
export function getOperation(name: string): AnyOperation | undefined {
  return isOperationName(name) ? (OPERATION_REGISTRY[name] as unknown as AnyOperation) : undefined;
}

/** Every registered operation, in `OPERATION_NAMES` order. */
export function listOperations(): readonly AnyOperation[] {
  return OPERATION_NAMES.map((name) => OPERATION_REGISTRY[name] as unknown as AnyOperation);
}

/** The catalogue as a caller reads it: name, kind and one-line summary. */
export function describeOperations(): readonly OperationDescriptor[] {
  return listOperations().map(({ name, kind, summary }) => ({ name, kind, summary }));
}

/** Every operation of one kind. §22's waiver rule asks this question. */
export function operationsOfKind(kind: OperationKind): readonly AnyOperation[] {
  return listOperations().filter((operation) => operation.kind === kind);
}

// `service_info` answers with the catalogue, and the catalogue is this
// module — installed rather than imported, because the registry imports
// every operation and an operation importing the registry back would be a
// cycle.
provideCatalogue(describeOperations);

// `describe_tool` reads the same index, installed the same way and for the
// same reason. It is given the lookup rather than a snapshot of the
// operations so that what it describes is what is registered — a copied list
// would be the second source of truth the operation exists to avoid.
provideToolIndex({ lookup: getOperation, names: () => OPERATION_NAMES });
