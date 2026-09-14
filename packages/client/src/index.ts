export { AgentDockClient } from './client.js';
export type {
  AgentDockClientOptions,
  AttachmentContentV2,
  HealthResponse,
  SessionEventHistoryV2Options,
  SessionEventsOptions,
  SessionListV2Options,
  SessionRequestOptions,
} from './client.js';
export {
  AgentDockClientError,
  AttachmentNotFoundError,
  DaemonError,
  DaemonUnavailableError,
  ProtocolMismatchError,
  ProviderUnavailableError,
  SessionNotFoundError,
  UnauthorizedError,
  ValidationError,
} from './errors.js';
