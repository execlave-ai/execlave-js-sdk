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
  EnforcementHaltError,
  isEnforcementError,
  AgentPausedError,
  PolicyBlockedError,
  ValidatorDeniedError,
  ToolIntegrityError,
  policyBlockedErrorFromViolations,
  PolicyDeniedError,
  ApprovalTimeoutError,
  CertificateMismatchError,
  ApprovalVerificationError,
  EnforcementUnavailableError,
  MetadataContractError,
  QuotaExceededError,
  PlanLimitExceededError,
} from './errors';
export type {
  ExeclaveConfig,
  PrivacyConfig,
  RegisterAgentOptions,
  ReportAgentMetadataOptions,
  ReportToolBaselineOptions,
  ToolDescriptorInput,
  AutonomyLevel,
  TraceOptions,
  DeployPromptOptions,
  PromptVersionData,
  AgentData,
  AgentStatus,
  TraceStatus,
  Environment,
  EnforcePolicyOptions,
  EnforceResult,
  EnforcementBypassEvent,
  EnforcementBypassReason,
  EnforceViolation,
  AuthorizeCallOptions,
  AuthorizeResult,
  DiscoveredAgent,
  UsageBucket,
  UsageStatus,
} from './types';
