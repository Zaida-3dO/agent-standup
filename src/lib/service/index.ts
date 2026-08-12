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
