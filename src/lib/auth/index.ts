// The auth module's public surface.
//
// Adapters import from here rather than reaching into the two files
// beneath, so that "what authentication offers the rest of the app" is one
// list in one place — the same property the service registry gives
// operations.
export {
  AUTH_TOKENS_ENV_VAR,
  parseTokenTable,
  hasConfiguredTokens,
  type AuthenticatedMachine,
  type TokenTable,
} from "./tokens";
export {
  AUTHORIZATION_HEADER,
  authenticate,
  bearerToken,
  machineForToken,
  type AuthFailureReason,
  type AuthResult,
} from "./authenticate";
