// The service layer: the only way into the rules. See docs/plans/SCHEMA.md §22.
//
// Adapters import from here and from nowhere deeper. `live.ts` is
// deliberately *not* re-exported: it is the composition root and reaching
// the database client happens there, so an adapter that wants the running
// service imports it by name and a reviewer sees that in the diff.
export {
  ConflictError,
  ForbiddenError,
  GuardRejectedError,
  InternalError,
  InvalidInputError,
  NotFoundError,
  NotImplementedError,
  SERVICE_ERROR_CODES,
  ServiceError,
  isServiceError,
  toServiceError,
  type Rejection,
  type ServiceErrorCode,
  type ServiceErrorOptions,
} from "./errors";

export {
  defineOperation,
  type AnyOperation,
  type Operation,
  type OperationKind,
  type ParsesInput,
} from "./operation";

export type { Caller, ServiceContext, TransactionHandle } from "./context";

export {
  OPERATION_NAMES,
  OPERATION_REGISTRY,
  describeOperations,
  getOperation,
  isOperationName,
  listOperations,
  operationsOfKind,
  type OperationInput,
  type OperationName,
  type OperationOutput,
  type OperationRegistry,
} from "./registry";

export {
  ServiceRuntime,
  prismaTransactionRunner,
  type CallOptions,
  type ServiceRuntimeOptions,
  type TransactionCapableClient,
} from "./runtime";

export type { OperationDescriptor, ServiceInfo, ServiceInfoInput } from "./operations/service-info";

// Hand-written guards (MILESTONES.md #16-#19, #21). Importing `ALL_GUARDS`
// from here is what registers them into `guardRegistry` — see
// `guards/index.ts`'s header for why that is a deliberate side effect of the
// import rather than a separate wiring step.
export { ALL_GUARDS, hierarchyGuard } from "./guards";

// The state machine (MILESTONES.md #15). Rows #16-#19 and #21 import
// `guardRegistry` from here to register their guards; row #27 imports
// `rehearseTransition`/`applyTransition` to build the routed operation.
export {
  ITEM_STATES,
  GuardRegistry,
  ProjectHasNoStateError,
  allStatePairs,
  applyTransition,
  guardOk,
  guardRegistry,
  guardRejected,
  isItemState,
  loadItemForTransition,
  rehearseTransition,
  runGuards,
  type AppliedTransition,
  type Guard,
  type GuardInput,
  type GuardResult,
  type GuardableItem,
  type ItemStateValue,
  type TransitionOutcome,
  type TransitionRequest,
} from "./state-machine";

export type { ItemRecord } from "./items/row";
export type { CreateItemInput } from "./operations/create-item";
export type { GetItemInput } from "./operations/get-item";
export type { UpdateItemInput } from "./operations/update-item";
export type { ListItemsInput, ListItemsOutput } from "./operations/list-items";
