/**
 * Type definitions for the Execlave SDK.
 */

export type Environment = 'development' | 'staging' | 'production';

export type AgentStatus = 'active' | 'paused' | 'inactive' | 'archived' | 'error';

export type TraceStatus =
  | 'success'
  | 'error'
  | 'timeout'
  | 'policy_blocked'
  | 'limit_exceeded'
  | 'flagged_for_review';

export type AgentType =
  | 'autonomous'
  | 'conversational'
  | 'workflow'
  | 'data_processing'
  | 'monitoring'
  | 'chatbot'
  | 'copilot'
  | 'other';

export type AgentPlatform =
  | 'openai'
  | 'openai_assistants'
  | 'azure_openai'
  | 'anthropic'
  | 'langchain'
  | 'autogen'
  | 'crewai'
  | 'google'
  | 'aws'
  | 'azure'
  | 'huggingface'
  | 'custom'
  | 'other';

export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'deployed';

export interface ExeclaveConfig {
  /** API key (exe_xxx). Falls back to EXECLAVE_API_KEY env var. */
  apiKey?: string;
  /** Base URL of the Execlave API. Defaults to http://localhost:4000 */
  baseUrl?: string;
  /** API version prefix (e.g. 'v1'). Defaults to 'v1'. Set to empty string or undefined for legacy /api paths. */
  apiVersion?: string;
  /** Deployment environment. Defaults to 'production'. */
  environment?: Environment;
  /** Buffer traces and flush in background. Defaults to true. */
  asyncMode?: boolean;
  /** Max traces in a single flush batch. Defaults to 100. */
  batchSize?: number;
  /** Background flush interval in ms. Defaults to 10000. */
  flushIntervalMs?: number;
  /** Enable debug logging. Defaults to false. */
  debug?: boolean;
  /** Enable background agent status polling. Defaults to true. */
  enableControlChannel?: boolean;
  /** Status poll interval in ms. Defaults to 15000. */
  pollIntervalMs?: number;
  /** Client-side PII scrubbing configuration. */
  privacy?: PrivacyConfig;
  /** Enable client-side prompt injection scanning. Defaults to true. */
  enableInjectionScan?: boolean;
  /** Transport mode: 'native' (REST API) or 'otlp' (OpenTelemetry). Default: 'native' */
  mode?: 'native' | 'otlp';
  /** OTLP exporter endpoint (required when mode is 'otlp'). Example: 'http://localhost:4317' */
  otlpEndpoint?: string;
  /** Behaviour when enforcement endpoint is unreachable. Default: 'fail_open'. */
  enforcementOnOutage?: 'fail_open' | 'fail_closed';
  /** Behaviour when a plan limit (402) is hit. Default: 'fail_open'.
   *  fail_open: log warning and allow execution to continue unmonitored.
   *  fail_closed: throw PlanLimitExceededError and block execution. */
  planLimitBehavior?: 'fail_open' | 'fail_closed';
  /** Heartbeat ping interval in ms. Default: 600_000 (10 min). */
  heartbeatIntervalMs?: number;
  /** TTL for cached policy decisions in ms. Default: 60_000 (60s). */
  policyCacheTtlMs?: number;
}

export interface PrivacyConfig {
  /** Enable PII detection and scrubbing. Defaults to false. */
  enabled: boolean;
  /** Fields to scrub. Defaults to ['input', 'output']. */
  scrubFields?: string[];
  /** Include SHA-256 hashes of PII in metadata. Defaults to true. */
  hashPii?: boolean;
}

export interface RegisterAgentOptions {
  agentId: string;
  name: string;
  type?: string;
  platform?: string;
  environment?: Environment;
  description?: string;
  ownerEmail?: string;
  allowedDataSources?: string[];
  allowedActions?: string[];
  requiresHumanApprovalFor?: string[];
  tags?: string[];
  metadata?: Record<string, unknown>;
}

export interface TraceOptions {
  /** An explicit trace ID. Auto-generated if omitted. */
  traceId?: string;
  /** Session grouping ID. */
  sessionId?: string;
  /** End-user identifier. */
  userId?: string;
  /** Override agent to attribute this trace to. */
  agentId?: string;
  /** Additional metadata. */
  metadata?: Record<string, unknown>;
  /** Free-form tags for filtering / grouping. */
  tags?: string[];
  /** Override the environment for this single trace. Defaults to client environment. */
  environment?: Environment;
  /** Parent trace ID — links this trace as a child of another (multi-step / agent-to-agent). */
  parentTraceId?: string;
  /** Span type (e.g. 'llm', 'tool', 'retrieval'). */
  spanType?: string;
}

export interface DeployPromptOptions {
  promptTemplate: string;
  systemMessage?: string;
  modelName?: string;
  modelParameters?: Record<string, unknown>;
  changeType?: 'major' | 'minor' | 'patch';
  changeDescription?: string;
  versionTag?: string;
  environment?: Environment;
  requireApproval?: boolean;
}

export interface PromptVersionData {
  id: string;
  agentId: string;
  versionNumber: number;
  versionTag?: string;
  promptContent: string;
  systemPrompt?: string;
  modelName?: string;
  modelParameters?: Record<string, unknown>;
  approvalStatus: ApprovalStatus;
  isDeployed: boolean;
  deployedAt?: string;
  createdAt: string;
}

export interface AgentData {
  id: string;
  agentId: string;
  name: string;
  environment: string;
  status: AgentStatus;
  [key: string]: unknown;
}

export interface TracePayload {
  traceId: string;
  agentId?: string;
  sessionId?: string;
  userId?: string;
  timestamp: string;
  durationMs: number;
  status: TraceStatus;
  input?: unknown;
  output?: unknown;
  errorMessage?: string;
  errorType?: string;
  modelName?: string;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  costUsd?: number;
  environment?: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
  parentTraceId?: string;
  spanType?: string;
}

// ---------------------------------------------------------------------------
// Pre-Execution Policy Enforcement
// ---------------------------------------------------------------------------

export interface EnforcePolicyOptions {
  /** Registered external agentId (for example, "my-bot") or internal agent UUID. */
  agentId: string;
  /** The user/system input to evaluate. */
  input: string;
  /** Environment context. */
  environment?: Environment;
  /** Optional metadata for richer policy evaluation. */
  metadata?: Record<string, unknown>;
  /** Estimated cost of the execution (for budget policies). */
  estimatedCost?: number;
  /** List of tool names the agent intends to use (for action_approval policies). */
  tools?: string[];
}

export interface EnforceViolation {
  policyId: string;
  policyName: string;
  policyType: string;
  message: string;
  enforcementMode: string;
}

export interface EnforceResult {
  allowed: boolean;
  violations?: EnforceViolation[];
  warnings?: EnforceViolation[];
  requiresApproval?: boolean;
  approvalRequestId?: string;
  semanticCheck?: {
    intent_safe: boolean;
    confidence: number;
    reasoning: string;
    injection_signals: string[];
    data_scope_anomaly: boolean;
    goal_alignment_score: number;
  };
}

// ---------------------------------------------------------------------------
// Agent-to-Agent Authorization
// ---------------------------------------------------------------------------

export interface AuthorizeCallOptions {
  callerAgentId: string;
  calleeAgentId: string;
  action: string;
}

export interface AuthorizeResult {
  authorized: boolean;
  grant?: {
    id: string;
    callerAgentId: string;
    calleeAgentId: string;
    allowedActions: string[];
  };
}

export interface DiscoveredAgent {
  id: string;
  agentId: string;
  name: string;
  capabilities: string[];
}

export interface UsageBucket {
  current: number;
  max: number;
}

export interface UsageStatus {
  plan: string;
  agents: UsageBucket;
  traces: UsageBucket;
  users: UsageBucket;
  policies: UsageBucket;
  upgradeUrl: string;
}
