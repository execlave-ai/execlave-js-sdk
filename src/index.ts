/**
 * Execlave JavaScript/TypeScript SDK
 *
 * Official SDK for integrating AI agents with the Execlave governance platform.
 * Provides tracing, prompt management, and governance capabilities.
 */

export { Execlave } from './client';
export { Execlave as ExeclaveClient } from './client'; // backward-compat alias
export { Agent } from './agent';
export { Trace } from './trace';
export { runOpenAIChat, runLangChain } from './connectors';
export {
  ExeclaveError,
  ExeclaveAuthError,
  AgentPausedError,
  PolicyBlockedError,
  ValidatorDeniedError,
  PolicyDeniedError,
  ApprovalTimeoutError,
  EnforcementUnavailableError,
  QuotaExceededError,
  PlanLimitExceededError,
} from './errors';
export type {
  ExeclaveConfig,
  PrivacyConfig,
  RegisterAgentOptions,
  TraceOptions,
  DeployPromptOptions,
  PromptVersionData,
  AgentData,
  AgentStatus,
  TraceStatus,
  Environment,
  EnforcePolicyOptions,
  EnforceResult,
  EnforceViolation,
  AuthorizeCallOptions,
  AuthorizeResult,
  DiscoveredAgent,
  UsageBucket,
  UsageStatus,
} from './types';
