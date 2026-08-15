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
import { getItem } from "./operations/get-item";
import { updateItem } from "./operations/update-item";
import { listItems } from "./operations/list-items";
import { getBoard } from "./operations/get-board";
// Since your last visit (MILESTONES.md #38): the ledger slice, and the
// per-profile read state that decides what in it is new to you.
import { getEvents } from "./operations/get-events";
import { markEventSeen } from "./operations/mark-event-seen";
// The detail read behind the item view (MILESTONES.md #72) — one item's
// subtask tree, artifacts, history and summary in a single consistent read.
import { getItemDetail } from "./operations/get-item-detail";
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
import { orientation } from "./operations/orientation";
import { myWork } from "./operations/my-work";
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
import { listMachines } from "./operations/list-machines";
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
import { hookDecision } from "./operations/hook-decision";
// The process registry and the ownership check it exists to feed
// (MILESTONES.md #45). `kill_guard` is the consumer; the other three are
// how the registry gets its contents and how a refusal is explained.
import { registerProcess } from "./operations/register-process";
import { endProcess } from "./operations/end-process";
import { listProcesses } from "./operations/list-processes";
import { killGuard } from "./operations/kill-guard";
// Telemetry (MILESTONES.md #50): the hook's tool-call ingest, and the
// foundation every later M7 row reads.
import { recordToolCalls } from "./operations/record-tool-calls";
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
  [getItem.name]: getItem,
  [updateItem.name]: updateItem,
  [listItems.name]: listItems,
  [getBoard.name]: getBoard,
  [getEvents.name]: getEvents,
  [markEventSeen.name]: markEventSeen,
  [getItemDetail.name]: getItemDetail,
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
  [orientation.name]: orientation,
  [myWork.name]: myWork,
  [transitionItem.name]: transitionItem,
  [completeItem.name]: completeItem,
  [listRepos.name]: listRepos,
  [getRepo.name]: getRepo,
  [createRepo.name]: createRepo,
  [updateRepo.name]: updateRepo,
  [listAreas.name]: listAreas,
  [getArea.name]: getArea,
  [createArea.name]: createArea,
  [updateArea.name]: updateArea,
  [listMachines.name]: listMachines,
  [getMachine.name]: getMachine,
  [updateMachine.name]: updateMachine,
  [listAccounts.name]: listAccounts,
  [getAccount.name]: getAccount,
  [updateAccount.name]: updateAccount,
  [getCrewName.name]: getCrewName,
  [listPeople.name]: listPeople,
  [updatePerson.name]: updatePerson,
  [hookDecision.name]: hookDecision,
  [registerProcess.name]: registerProcess,
  [endProcess.name]: endProcess,
  [listProcesses.name]: listProcesses,
  [killGuard.name]: killGuard,
  [recordToolCalls.name]: recordToolCalls,
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
