/**
 * Execlave SDK — Main client.
 *
 * Provides the Execlave class for agent registration, tracing, and governance.
 * Implements non-blocking trace ingestion with an in-memory circular buffer
 * and a background flush interval.
 */

import { request } from './http';
import { Agent } from './agent';
import { Trace } from './trace';
import {
  ExeclaveError,
  AgentPausedError,
  PolicyBlockedError,
  policyBlockedErrorFromViolations,
  PolicyDeniedError,
  ApprovalTimeoutError,
  CertificateMismatchError,
  ApprovalVerificationError,
  EnforcementUnavailableError,
  QuotaExceededError,
  PlanLimitExceededError,
} from './errors';
import type {
  ExeclaveConfig,
  PrivacyConfig,
  RegisterAgentOptions,
  ReportAgentMetadataOptions,
  AgentCredential,
  ReportToolBaselineOptions,
  TraceOptions,
  TracePayload,
  AgentData,
  EnforcePolicyOptions,
  EnforceResult,
  ConversationTurn,
  ToolOutput,
  AuthorizeCallOptions,
  AuthorizeResult,
  DiscoveredAgent,
  UsageStatus,
  EnforcementBypassEvent,
} from './types';
import { createHash } from 'crypto';

type SdkState = 'INITIALIZING' | 'ACTIVE' | 'PAUSED' | 'SHUTDOWN';

const MAX_BUFFER_SIZE = 10_000;

/**
 * Deterministic JSON serialization with recursively sorted object keys, so the
 * SHA-256 descriptor hash is stable regardless of key order in the source tool
 * definition. Arrays preserve order (order is semantically meaningful there).
 */
/**
 * Resolve `%s` placeholders in a developer-authored debug message.
 *
 * The message is always a literal in this file; only the ARGUMENTS can carry
 * external text. Substitution is a single left-to-right pass that never
 * re-scans what it inserted, so a `%s` appearing inside a substituted value is
 * left alone rather than consuming the following argument. Arguments with no
 * matching placeholder are appended, so nothing is silently dropped.
 */
export function formatLogMessage(msg: string, args: unknown[]): string {
  if (args.length === 0) return msg;

  const render = (value: unknown): string => {
    if (typeof value === 'string') return value;
    if (value instanceof Error) return value.message;
    try {
      return JSON.stringify(value) ?? String(value);
    } catch {
      return String(value);
    }
  };

  let next = 0;
  const out: string[] = [];
  let i = 0;
  while (i < msg.length) {
    if (msg[i] === '%' && msg[i + 1] === 's' && next < args.length) {
      out.push(render(args[next++]));
      i += 2;
      continue;
    }
    out.push(msg[i]);
    i += 1;
  }

  const composed = out.join('');
  const leftovers = args.slice(next).map(render);
  return leftovers.length > 0 ? `${composed} ${leftovers.join(' ')}` : composed;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value as Record<string, unknown>).sort();
  const entries = keys.map(
    (k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`
  );
  return `{${entries.join(',')}}`;
}

function normalizeBaseUrl(baseUrl: string): string {
  const normalized = baseUrl.replace(/\/+$/, '');
  try {
    const url = new URL(normalized);
    if (url.protocol === 'http:' && url.hostname.toLowerCase() === 'api.execlave.com') {
      url.protocol = 'https:';
      return url.toString().replace(/\/+$/, '');
    }
  } catch {
    // Preserve existing validation behavior for relative or non-URL test endpoints.
  }
  return normalized;
}

// ---------------------------------------------------------------------------
// PII Patterns (mirrors processing service)
// ---------------------------------------------------------------------------
const PII_PATTERNS: Record<string, RegExp> = {
  email: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/gi,
  ssn: /\b\d{3}-\d{2}-\d{4}\b/g,
  credit_card: /\b(?:\d{4}[- ]?){3}\d{4}\b/g,
  phone_us: /\b(?:\+1[-.\s]?)?\(?[2-9]\d{2}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/g,
  ip_address: /\b(?:\d{1,3}\.){3}\d{1,3}\b/g,
  api_key: /\b(?:sk|pk|ag)_[a-zA-Z0-9]{20,}\b/g,
};

// ---------------------------------------------------------------------------
// Injection Patterns (common prompt-injection signatures)
// ---------------------------------------------------------------------------
const INJECTION_PATTERNS: RegExp[] = [
  /ignore\s+(all\s+)?previous\s+instructions/i,
  /ignore\s+(all\s+)?above\s+instructions/i,
  /disregard\s+(all\s+)?previous/i,
  /you\s+are\s+now\s+(?:a\s+)?(?:DAN|evil|unrestricted)/i,
  /forget\s+(all\s+)?(?:previous|earlier|your)\s+(?:instructions|rules|guidelines)/i,
  /system\s*:\s*you\s+are/i,
  /\[SYSTEM\]|\[INST\]|\[\/INST\]/i,
  /<\|(?:system|im_start|im_end)\|>/i,
  /(?:reveal|show|display|print|output)\s+(?:your\s+)?(?:system\s+)?(?:prompt|instructions|rules)/i,
  /(?:act|behave|respond)\s+as\s+(?:if|though)\s+(?:you\s+(?:are|were|have))/i,
  /do\s+anything\s+now/i,
  /jailbreak/i,
  /bypass\s+(?:your\s+)?(?:filters?|restrictions?|safety|guidelines?)/i,
];

/**
 * Main entry point for the Execlave JavaScript SDK.
 *
 * @example
 * ```ts
 * const exe = new Execlave({ apiKey: 'exe_prod_xxx', environment: 'production' });
 * const agent = await exe.registerAgent({ agentId: 'my-bot', name: 'My Bot' });
 *
 * const trace = exe.startTrace({ agentId: 'my-bot' });
 * trace.setInput(question);
 * const answer = await llm.call(question);
 * trace.setOutput(answer).setModel('gpt-4').setTokens(100, 200);
 * trace.finish();
 *
 * // Before process exit
 * await exe.shutdown();
 * ```
 */
export class Execlave {
  private _apiKey: string;
  private _baseUrl: string;
  private _apiVersion: string | undefined;
  private _environment: string;
  private _asyncMode: boolean;
  private _batchSize: number;
  private _flushIntervalMs: number;
  private _debug: boolean;
  private _enableControlChannel: boolean;
  private _pollIntervalMs: number;
  private _privacy: PrivacyConfig;
  private _enableInjectionScan: boolean;
  private _signRequests: boolean;
  private _mode: 'native' | 'otlp';
  private _otlpEndpoint?: string;
  private _otelExporter: import('./otel').OTelExporter | null = null;
  private _otelReady: Promise<void> | null = null;

  private _state: SdkState = 'INITIALIZING';
  private _buffer: TracePayload[] = [];
  private _agents: Map<string, Agent> = new Map();
  private _agentCredentialCache: Map<string, AgentCredential> = new Map();

  private _flushTimer: ReturnType<typeof setInterval> | null = null;
  private _pollTimer: ReturnType<typeof setInterval> | null = null;
  private _heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private _socket: any = null;

  // Circuit breaker state
  private _cbFailures = 0;
  private _cbThreshold = 3;
  private _cbOpen = false;
  private _cbOpenAt = 0;
  private _cbResetAfterMs = 60_000;
  private _cbLastError?: string;

  // Policy cache
  private _policyCache = new Map<string, { response: EnforceResult; expiresAt: number }>();
  private _policyCacheTtlMs: number = 60_000;

  // Trace quota-exhausted cache (fail fast for 60 seconds)
  private _quotaExceeded: { error: QuotaExceededError; expiresAt: number } | null = null;
  private _quotaCacheTtlMs = 60_000;

  // Enforcement outage behaviour
  private _enforcementOnOutage: 'fail_open' | 'fail_closed' = 'fail_open';
  // Plan limit behaviour
  private _planLimitBehavior: 'fail_open' | 'fail_closed' = 'fail_open';
  private _onEnforcementBypassed?: (event: EnforcementBypassEvent) => void;
  private _heartbeatIntervalMs: number = 600_000;
  // p3 — attach a signed agent credential to each trace on ingest when enabled.
  private _stampIdentity = false;

  constructor(config: ExeclaveConfig = {}) {
    this._apiKey = config.apiKey ?? process.env.EXECLAVE_API_KEY ?? '';
    if (!this._apiKey) {
      throw new Error('apiKey must be provided or EXECLAVE_API_KEY env var must be set');
    }

    this._baseUrl = normalizeBaseUrl(
      config.baseUrl ?? process.env.EXECLAVE_BASE_URL ?? 'https://api.execlave.com',
    );
    this._apiVersion = config.apiVersion !== undefined ? config.apiVersion || undefined : 'v1';
    this._environment = config.environment ?? 'production';
    this._asyncMode = config.asyncMode ?? true;
    this._batchSize = config.batchSize ?? 100;
    this._flushIntervalMs = config.flushIntervalMs ?? 10_000;
    this._debug = config.debug ?? false;
    this._enableControlChannel = config.enableControlChannel ?? true;
    this._pollIntervalMs = config.pollIntervalMs ?? 15_000;
    this._privacy = config.privacy ?? { enabled: false };
    this._enableInjectionScan = config.enableInjectionScan ?? true;
    this._signRequests = config.signRequests ?? false;
    this._mode = config.mode ?? 'native';
    this._otlpEndpoint = config.otlpEndpoint;
    this._enforcementOnOutage = config.enforcementOnOutage ?? 'fail_open';
    this._planLimitBehavior = config.planLimitBehavior ?? 'fail_open';
    this._onEnforcementBypassed = config.onEnforcementBypassed;
    this._heartbeatIntervalMs = config.heartbeatIntervalMs ?? 600_000;
    this._policyCacheTtlMs = config.policyCacheTtlMs ?? 60_000;
    this._stampIdentity = config.stampIdentity ?? false;

    // Initialise OTel exporter when running in OTLP mode
    if (this._mode === 'otlp') {
      if (!this._otlpEndpoint) {
        throw new Error('otlpEndpoint is required when mode is "otlp"');
      }
      this._otelReady = import('./otel')
        .then(({ OTelExporter }) =>
          OTelExporter.create(this._otlpEndpoint!, this._apiKey, `Execlave-${this._environment}`),
        )
        .then((exp) => {
          this._otelExporter = exp;
        });
    }

    // Start background flush
    if (this._asyncMode) {
      this._flushTimer = setInterval(() => {
        this._doFlush().catch(this._logError.bind(this));
      }, this._flushIntervalMs);
      // Unref so the timer doesn't prevent process exit
      if (this._flushTimer && typeof this._flushTimer === 'object' && 'unref' in this._flushTimer) {
        (this._flushTimer as NodeJS.Timeout).unref();
      }
    }

    // Start background status polling
    if (this._enableControlChannel) {
      this._pollTimer = setInterval(() => {
        this._statusPoll().catch(this._logError.bind(this));
      }, this._pollIntervalMs);
      if (this._pollTimer && typeof this._pollTimer === 'object' && 'unref' in this._pollTimer) {
        (this._pollTimer as NodeJS.Timeout).unref();
      }

      // Attempt WebSocket connection for real-time control (<500ms latency)
      this._connectWebSocket();

      // Heartbeat timer
      this._heartbeatTimer = setInterval(() => {
        this._sendHeartbeats().catch(this._logError.bind(this));
      }, this._heartbeatIntervalMs);
      if (this._heartbeatTimer && typeof this._heartbeatTimer === 'object' && 'unref' in this._heartbeatTimer) {
        (this._heartbeatTimer as NodeJS.Timeout).unref();
      }
    }

    this._state = 'ACTIVE';
    this._log('Execlave SDK initialized (env=%s, async=%s)', this._environment, this._asyncMode);

    // Register graceful shutdown handlers for SIGTERM/SIGINT
    const gracefulShutdown = (): void => {
      this.shutdown().catch(() => {}).finally(() => process.exit(0));
    };
    process.once('SIGTERM', gracefulShutdown);
    process.once('SIGINT', gracefulShutdown);
  }

  // ========================================================================
  // API path helper
  // ========================================================================

  /**
   * Build a versioned API path.
   *
   * If `apiVersion` is set (e.g. `'v1'`), returns `/api/v1${path}`.
   * Otherwise falls back to the legacy `/api${path}` format.
   */
  private apiPath(path: string): string {
    if (this._apiVersion) {
      return `/api/${this._apiVersion}${path}`;
    }
    return `/api${path}`;
  }

  // ========================================================================
  // Public API
  // ========================================================================

  /** Check if the Execlave API is reachable. */
  async ping(): Promise<boolean> {
    try {
      // Use unversioned /health (the versioned /api/v1/health doesn't exist)
      const resp = await request({
        method: 'GET',
        url: `${this._baseUrl}/health`,
        headers: { Authorization: `Bearer ${this._apiKey}` },
        timeout: 5_000,
      });
      return resp.status === 200;
    } catch {
      return false;
    }
  }

  /**
   * Register (or re-register) an AI agent. Idempotent — call on startup.
   *
   * @returns An Agent object with prompt management methods.
   */
  async registerAgent(opts: RegisterAgentOptions): Promise<Agent> {
    const environment = opts.environment ?? this._environment;
    const payload: Record<string, unknown> = {
      agentId: opts.agentId,
      name: opts.name,
      type: opts.type ?? 'chatbot',
      platform: opts.platform ?? 'custom',
      environment,
    };
    if (opts.description) payload.description = opts.description;
    if (opts.ownerEmail) payload.ownerEmail = opts.ownerEmail;
    if (opts.allowedDataSources) payload.allowedDataSources = opts.allowedDataSources;
    if (opts.allowedActions) payload.allowedActions = opts.allowedActions;
    if (opts.requiresHumanApprovalFor) payload.requiresHumanApprovalFor = opts.requiresHumanApprovalFor;
    if (opts.tags) payload.tags = opts.tags;
    if (opts.metadata) payload.metadata = opts.metadata;
    if (opts.autonomyLevel) payload.autonomyLevel = opts.autonomyLevel;

    try {
      const resp = await this._request('POST', this.apiPath('/agents'), payload);
      const data = this._extractAgentPayload(resp, opts.agentId, environment);
      const agent = new Agent(this, data);
      this._agents.set(opts.agentId, agent);
      return agent;
    } catch (err) {
      // If agent already exists, try to fetch it
      if (err instanceof ExeclaveError && err.message.includes('already exists')) {
        const listResp = await this._request('GET', `${this.apiPath('/agents')}?search=${encodeURIComponent(opts.agentId)}`);
        const data = this._extractAgentPayload(listResp, opts.agentId, environment);
        const agent = new Agent(this, data);
        this._agents.set(opts.agentId, agent);
        return agent;
      }
      throw err;
    }
  }

  /**
   * Get a short-lived cryptographic identity credential for an agent.
   * Results are cached per agent until 60 seconds before expiry.
   */
  async getAgentCredential(agentId: string): Promise<AgentCredential> {
    this._ensureNotShutdown();

    const cached = this._agentCredentialCache.get(agentId);
    if (cached && new Date(cached.expiresAt).getTime() - Date.now() > 60_000) {
      return cached;
    }

    const agentUuid = this._resolveAgentId(agentId);
    const resp = await this._request('POST', this.apiPath(`/agents/${agentUuid}/credential`));
    const credential = (resp.data ?? resp) as AgentCredential;
    this._agentCredentialCache.set(agentId, credential);
    return credential;
  }

  /**
   * Report deployment metadata for an agent, creating a new version snapshot in
   * the agent registry (Phase 2.1). Optional and additive — call from your
   * deploy pipeline on each release to build a version history. Requires the
   * server to have the agent registry enabled.
   *
   * @returns The created version record.
   */
  async reportAgentMetadata(opts: ReportAgentMetadataOptions): Promise<unknown> {
    this._ensureNotShutdown();

    // Resolve the agent UUID from the local cache, or look it up by external id.
    let agentUuid = this._agents.get(opts.agentId)?.id;
    if (!agentUuid) {
      const listResp = await this._request(
        'GET',
        `${this.apiPath('/agents')}?search=${encodeURIComponent(opts.agentId)}`
      );
      const data = this._extractAgentPayload(listResp, opts.agentId, this._environment);
      agentUuid = data.id;
    }
    if (!agentUuid) {
      throw new ExeclaveError(`Unknown agent '${opts.agentId}'; call registerAgent() first`);
    }

    const metadata: Record<string, unknown> = {};
    if (opts.gitCommit !== undefined) metadata.gitCommit = opts.gitCommit;
    if (opts.deployedAt !== undefined) {
      metadata.deployedAt =
        opts.deployedAt instanceof Date ? opts.deployedAt.toISOString() : String(opts.deployedAt);
    }

    const payload: Record<string, unknown> = { activate: opts.activate ?? false };
    if (opts.versionLabel !== undefined) payload.versionLabel = opts.versionLabel;
    if (opts.notes !== undefined) payload.notes = opts.notes;
    if (Object.keys(metadata).length > 0) payload.metadata = metadata;

    return this._request('POST', this.apiPath(`/agents/${agentUuid}/versions`), payload);
  }

  /**
   * Compute the SHA-256 descriptor hash for an MCP tool definition. Pass the
   * raw tool object (name + description + inputSchema, etc.); the hash is stable
   * across key order. Use the result in {@link EnforcePolicyOptions.toolDescriptors}
   * and {@link reportToolBaseline}.
   */
  toolDescriptor(opts: {
    server: string;
    tool: string;
    descriptor: unknown;
    description?: string;
  }): { server: string; tool: string; descriptorHash: string; description?: string } {
    const descriptorHash = createHash('sha256')
      .update(stableStringify(opts.descriptor))
      .digest('hex');
    return {
      server: opts.server,
      tool: opts.tool,
      descriptorHash,
      ...(opts.description !== undefined ? { description: opts.description } : {}),
    };
  }

  /**
   * Pin the approved set of MCP tool descriptors for an agent (the
   * `tool_integrity` baseline that future `enforcePolicy` calls are diffed
   * against). Call after a reviewed deploy; re-pin with `reason: 'baseline_update'`
   * after a legitimate tool update. Requires the server to have tool integrity
   * governance enabled.
   */
  async reportToolBaseline(opts: ReportToolBaselineOptions): Promise<unknown> {
    this._ensureNotShutdown();
    const agentUuid = this._resolveAgentId(opts.agentId);
    return this._request(
      'POST',
      this.apiPath(`/tool-integrity/agents/${agentUuid}/baseline`),
      { descriptors: opts.descriptors, reason: opts.reason ?? 'manual' }
    );
  }

  async verifyApproval(
    approvalId: string,
    actionContext: Record<string, unknown>,
  ): Promise<{
    valid: boolean;
    reason?: string;
    certificate?: Record<string, unknown>;
    verifiedAt?: string;
  }> {
    this._ensureNotShutdown();
    const resp = await this._request(
      'POST',
      this.apiPath(`/approvals/${approvalId}/verify`),
      { actionContext },
    );
    return (resp.data ?? resp) as {
      valid: boolean;
      reason?: string;
      certificate?: Record<string, unknown>;
      verifiedAt?: string;
    };
  }

  /**
   * Start a manual trace. Call `trace.finish()` when done.
   *
   * @returns A Trace handle with chainable setters.
   */
  startTrace(opts: TraceOptions = {}): Trace {
    this._ensureNotShutdown();

    const resolvedAgentId = opts.agentId ?? this._firstAgentId();

    if (this._state === 'PAUSED') {
      throw new AgentPausedError(resolvedAgentId ?? 'unknown');
    }

    return new Trace(this, {
      agentId: resolvedAgentId,
      traceId: opts.traceId,
      sessionId: opts.sessionId,
      userId: opts.userId,
      metadata: opts.metadata,
      tags: opts.tags,
      environment: opts.environment ?? this._environment,
      parentTraceId: opts.parentTraceId,
      spanType: opts.spanType,
    });
  }

  /**
   * Wrap an async function with automatic tracing.
   *
   * @example
   * ```ts
   * const tracedAnswer = exe.wrap(async (question: string) => {
   *   return await llm.call(question);
   * }, { agentId: 'my-bot' });
   *
   * const answer = await tracedAnswer('Hello?');
   * ```
   */
  wrap<TArgs extends unknown[], TReturn>(
    fn: (...args: TArgs) => Promise<TReturn>,
    opts: TraceOptions = {},
  ): (...args: TArgs) => Promise<TReturn> {
    return async (...args: TArgs): Promise<TReturn> => {
      const trace = this.startTrace(opts);
      trace.setInput(args.length === 1 ? args[0] : args);
      try {
        const result = await fn(...args);
        trace.setOutput(result);
        trace.finish('success');
        return result;
      } catch (err) {
        const error = err as Error;
        trace.finish('error', error.message, error.name);
        throw err;
      }
    };
  }

  /**
   * Check the current status of a registered agent.
   *
   * @returns 'active', 'paused', or 'error'.
   */
  async checkAgentStatus(agentId?: string): Promise<string> {
    const agent = agentId ? this._agents.get(agentId) : this._firstAgent();
    if (!agent) return 'unknown';

    try {
      const resp = await this._request('GET', this.apiPath(`/agents/${agent.id}/status-poll`));
      const status = resp.data?.status ?? 'active';
      agent.status = status;
      return status;
    } catch {
      return 'error';
    }
  }

  /** Flush all buffered traces to the API. */
  async flush(): Promise<void> {
    await this._doFlush();
  }

  /**
   * Pre-execution policy enforcement.
   *
   * Call this **before** running the LLM to check whether policies allow execution.
   * Throws `PolicyBlockedError` if any policy with `enforcement_mode='block'` is violated.
   * Returns warnings for `warn`-mode violations.
   *
   * @example
   * ```ts
   * try {
   *   const result = await exe.enforcePolicy({
   *     agentId: agent.id,
   *     input: userQuestion,
   *     tools: ['web_search'],
   *   });
   *   if (result.warnings?.length) console.warn('Policy warnings:', result.warnings);
   *   // Safe to proceed
   *   const answer = await llm.call(userQuestion);
   * } catch (err) {
   *   if (err instanceof PolicyBlockedError) {
   *     return 'Sorry, I cannot process that request.';
   *   }
   * }
   * ```
   */
  async enforcePolicy(opts: EnforcePolicyOptions): Promise<EnforceResult> {
    this._ensureNotShutdown();
    this._throwIfQuotaExceeded();

    const effectiveEnvironment = opts.environment ?? this._environment;

    // 1. Check cache
    const cacheKey = this._policyCacheKey(
      opts.agentId,
      opts.input,
      effectiveEnvironment,
      opts.metadata,
      opts.estimatedCost,
      opts.tools,
      opts.conversationHistory,
      opts.toolOutputs,
    );
    // A cached ALLOW must never survive a kill switch. When the control channel
    // has observed a pause we skip the cache entirely and let the request reach
    // the server, which returns the kill-switch 403. The cache is also flushed
    // on the pause transition itself (see _statusPoll / WebSocket handlers), so
    // this is belt-and-suspenders for the window before that fires.
    if (this._state !== 'PAUSED') {
      const cached = this._policyCacheGet(cacheKey);
      if (cached) {
        this._log('Policy cache hit for %s', opts.agentId);
        return cached;
      }
    }

    // 2. Check circuit breaker
    if (this._cbIsOpen()) {
      if (this._enforcementOnOutage === 'fail_closed') {
        throw new EnforcementUnavailableError(this._cbFailures, this._cbLastError);
      }
      this._log('Circuit breaker open — fail_open, allowing execution for %s', opts.agentId);
      this._emitBypass({
        reason: 'circuit_breaker_open',
        source: 'fail_open_circuit_breaker',
        agentId: opts.agentId,
        message: this._cbLastError,
        consecutiveFailures: this._cbFailures,
      });
      // `source` was previously omitted on this path alone, so a caller
      // checking it could not tell a breaker-open allow from a governed one.
      return { allowed: true, source: 'fail_open_circuit_breaker' } as EnforceResult;
    }

    // 3. Build payload and make HTTP call
    // Resolve external agentId to internal UUID when cached; the API also accepts external IDs.
    const resolvedAgentId = this._resolveAgentId(opts.agentId);

    const payload = {
      agentId: resolvedAgentId,
      input: opts.input,
      environment: effectiveEnvironment,
      metadata: opts.metadata,
      estimatedCost: opts.estimatedCost,
      tools: opts.tools,
      toolDescriptors: opts.toolDescriptors,
      // Only send when non-empty — the server schema is strict, and an empty
      // array would needlessly change the request shape.
      ...(opts.conversationHistory && opts.conversationHistory.length > 0
        ? { conversationHistory: opts.conversationHistory }
        : {}),
      ...(opts.toolOutputs && opts.toolOutputs.length > 0
        ? { toolOutputs: opts.toolOutputs }
        : {}),
    };

    const url = `${this._baseUrl}${this.apiPath('/policies/enforce')}`;
    let resp: any;
    try {
      resp = await request({
        method: 'POST',
        url,
        headers: { Authorization: `Bearer ${this._apiKey}` },
        body: payload,
        resolveOnClientError: true,
        sign: this._sign(),
      });
    } catch (err: any) {
      // Network failure → circuit breaker. fail_closed must block on the FIRST
      // failure, not only once the breaker has tripped — a guarantee gated on
      // the breaker threshold silently allows the first N calls through, which
      // defeats the entire point of choosing fail_closed.
      this._cbRecordFailure(err.message ?? String(err));
      if (this._enforcementOnOutage === 'fail_closed') {
        throw new EnforcementUnavailableError(this._cbFailures, err.message);
      }
      this._log('Network error in enforcePolicy (fail_open): %s', err.message);
      this._emitBypass({
        reason: 'network_error',
        source: 'fail_open_network_error',
        agentId: opts.agentId,
        message: err.message,
        consecutiveFailures: this._cbFailures,
      });
      return { allowed: true, source: 'fail_open_network_error' } as EnforceResult;
    }

    // 4. Record success in circuit breaker — but a 5xx is NOT a successful
    // enforcement decision. Recording it as success would keep the breaker
    // closed through a sustained server outage and mask the fail_closed guard.
    if (resp.status < 500) {
      this._cbRecordSuccess();
    }

    // 5. Handle response codes
    // 403 → blocked by policy
    if (resp.status === 403 && resp.data?.allowed === false) {
      throw policyBlockedErrorFromViolations(resp.data.violations ?? []);
    }

    // 202 → require approval (never cached)
    if (resp.status === 202 && resp.data?.approvalRequestId) {
      const approvalRequestId = resp.data.approvalRequestId as string;
      // Reconstruct the exact action context the server sealed into the
      // certificate (see PolicyService.createApprovalIfNeeded). Same field set,
      // same values as this call's enforce payload, so the server's canonical
      // hashes match on both sides. This is the SDK's own independent view of
      // what it is about to execute — it is NOT echoed from the server.
      const approvedActionContext: Record<string, unknown> = {
        input: opts.input,
        environment: effectiveEnvironment,
        metadata: opts.metadata,
        estimatedCost: opts.estimatedCost,
        tools: opts.tools,
      };
      return this._pollApprovalDecision(approvalRequestId, approvedActionContext);
    }

    // 402 → plan quota exhausted
    if (resp.status === 402) {
      const quotaError = this._quotaErrorFromBody(resp.data);
      this._setQuotaExceeded(quotaError);
      if (this._planLimitBehavior === 'fail_open') {
        this._log(`[warn] Plan limit exceeded for ${quotaError.resource} (${quotaError.current}/${quotaError.max}) — continuing unmonitored`);
        // "Continuing unmonitored" is a governance gap even though the cause is
        // commercial rather than an outage, so it is reported the same way.
        this._emitBypass({
          reason: 'plan_limit_exceeded',
          source: 'fail_open_plan_limit',
          agentId: opts.agentId,
          message: quotaError.message,
          status: 402,
        });
        return { allowed: true, warnings: [{ policyId: 'plan_limit', policyName: 'Plan Limit', policyType: 'plan_limit', message: quotaError.message, enforcementMode: 'warn' }] };
      }
      throw new PlanLimitExceededError(quotaError.resource, quotaError.current, quotaError.max, quotaError.message);
    }

    // 5xx → the enforcement decision is unavailable, exactly like a network
    // failure (a load balancer returning 502/503 is the common outage shape).
    // Route it through the SAME outage policy rather than a generic throw, so
    // `enforcementOnOutage` is honored for server errors, not only for dropped
    // connections.
    if (resp.status >= 500) {
      this._cbRecordFailure(`server ${resp.status}`);
      if (this._enforcementOnOutage === 'fail_closed') {
        throw new EnforcementUnavailableError(this._cbFailures, `server error ${resp.status}`);
      }
      this._log('Server error %d in enforcePolicy (fail_open): allowing', resp.status);
      this._emitBypass({
        reason: 'server_error',
        source: 'fail_open_server_error',
        agentId: opts.agentId,
        message: `server error ${resp.status}`,
        status: resp.status,
        consecutiveFailures: this._cbFailures,
      });
      return { allowed: true, source: 'fail_open_server_error' } as EnforceResult;
    }

    // Other client errors (4xx) are the caller's bug, not an outage — surface them.
    if (resp.status >= 400) {
      throw new ExeclaveError(`Enforce policy failed (${resp.status}): ${resp.data?.error?.message ?? 'Unknown error'}`);
    }

    // 6. Cache and return
    const result = resp.data as EnforceResult;
    this._policyCacheSet(cacheKey, result);
    return result;
  }

  /**
   * Synchronously scan a tool's output BEFORE feeding it back to the model —
   * the preventive side of `tool_output_scan`. Call this after a tool returns
   * and before the agent consumes the result: a block-mode policy throws
   * `PolicyBlockedError`, letting you stop a poisoned or PII-laden tool result
   * (indirect prompt injection) from ever reaching the model.
   *
   * @example
   * const raw = await tool.run(args);
   * await exe.enforceToolOutput({ agentId: 'bot', toolName: 'web_search', output: raw });
   * // not reached if blocked
   * const answer = await llm.call(raw);
   */
  async enforceToolOutput(opts: {
    agentId: string;
    toolName: string;
    output: unknown;
    input?: unknown;
    environment?: EnforcePolicyOptions['environment'];
    metadata?: Record<string, unknown>;
  }): Promise<EnforceResult> {
    return this.enforcePolicy({
      agentId: opts.agentId,
      // `input` on the enforce request is required; a short marker keeps the
      // request valid while the actual subject of the scan is the tool output.
      input: `tool_output:${opts.toolName}`,
      environment: opts.environment,
      metadata: opts.metadata,
      toolOutputs: [{ name: opts.toolName, input: opts.input, output: opts.output }],
    });
  }

  // ========================================================================
  // Circuit Breaker Helpers
  // ========================================================================

  private _cbRecordSuccess(): void {
    this._cbFailures = 0;
    this._cbOpen = false;
    this._cbLastError = undefined;
  }

  private _cbRecordFailure(errorMsg: string): void {
    this._cbFailures++;
    this._cbLastError = errorMsg;
    if (this._cbFailures >= this._cbThreshold) {
      this._cbOpen = true;
      this._cbOpenAt = Date.now();
      this._log('Circuit breaker OPEN after %d failures (mode=%s)', this._cbFailures, this._enforcementOnOutage);
    }
  }

  private _cbIsOpen(): boolean {
    if (!this._cbOpen) return false;
    // Half-open: allow retry after reset period
    if (Date.now() - this._cbOpenAt > this._cbResetAfterMs) {
      this._log('Circuit breaker half-open — retrying');
      return false;
    }
    return true;
  }

  // ========================================================================
  // Policy Cache Helpers
  // ========================================================================

  private _policyCacheKey(
    agentId: string,
    input: string,
    environment: string,
    metadata?: Record<string, unknown>,
    estimatedCost?: number,
    tools?: string[],
    conversationHistory?: ConversationTurn[],
    toolOutputs?: ToolOutput[],
  ): string {
    // Every field the server treats as governance-relevant action context
    // must be part of the cache key. Keying on input/environment/agentId
    // alone let two calls with different metadata (e.g. different full tool
    // arguments behind a colliding/truncated `input` string) share a cached
    // decision — the second call never even reached the server, metadata
    // included or not. conversationHistory is included because it changes the
    // injection-scan verdict (a crescendo). Non-serializable metadata still
    // gets a distinct, deterministic marker rather than crashing key building.
    let extra: string;
    try {
      extra = JSON.stringify([
        metadata ?? null,
        estimatedCost ?? null,
        tools ?? null,
        conversationHistory ?? null,
        toolOutputs ?? null,
      ]);
    } catch {
      extra = '__unserializable__';
    }
    const hash = createHash('sha256')
      .update(`${environment}:${agentId}:${input}:${extra}`)
      .digest('hex')
      .slice(0, 16);
    return `policy:${hash}`;
  }

  private _policyCacheGet(key: string): EnforceResult | null {
    const entry = this._policyCache.get(key);
    if (entry && entry.expiresAt > Date.now()) return entry.response;
    if (entry) this._policyCache.delete(key);
    return null;
  }

  private _policyCacheSet(key: string, response: EnforceResult): void {
    this._policyCache.set(key, { response, expiresAt: Date.now() + this._policyCacheTtlMs });
    // Evict old entries (keep max 500)
    if (this._policyCache.size > 500) {
      const entries = [...this._policyCache.entries()].sort((a, b) => a[1].expiresAt - b[1].expiresAt);
      for (let i = 0; i < 100 && i < entries.length; i++) {
        this._policyCache.delete(entries[i][0]);
      }
    }
  }

  private _toInt(value: unknown, fallback = 0): number {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  private _quotaErrorFromBody(body: any): QuotaExceededError {
    const err = body?.error ?? {};
    return new QuotaExceededError(
      String(err.resource ?? 'unknown'),
      this._toInt(err.current, 0),
      this._toInt(err.max, 0),
      String(err.message ?? ''),
    );
  }

  private _setQuotaExceeded(error: QuotaExceededError): void {
    // Cache only trace quota; this drives fail-fast for enforce/trace hot paths.
    if (error.resource !== 'maxTracesPerMonth') return;
    this._quotaExceeded = {
      error,
      expiresAt: Date.now() + this._quotaCacheTtlMs,
    };
  }

  private _getCachedQuotaExceeded(): QuotaExceededError | null {
    if (!this._quotaExceeded) return null;
    if (Date.now() >= this._quotaExceeded.expiresAt) {
      this._quotaExceeded = null;
      return null;
    }
    return this._quotaExceeded.error;
  }

  private _throwIfQuotaExceeded(): void {
    const cached = this._getCachedQuotaExceeded();
    if (!cached) return;
    if (this._planLimitBehavior === 'fail_open') return;
    throw new PlanLimitExceededError(cached.resource, cached.current, cached.max, cached.message);
  }

  // ========================================================================
  // Heartbeat
  // ========================================================================

  private async _sendHeartbeats(): Promise<void> {
    for (const [, agent] of this._agents) {
      try {
        await request({
          method: 'POST',
          url: `${this._baseUrl}${this.apiPath(`/agents/${agent.id}/heartbeat`)}`,
          headers: { Authorization: `Bearer ${this._apiKey}` },
          body: { lastPolicyCheckAt: null },
          timeout: 10_000,
        });
        this._log('Heartbeat sent for agent %s', agent.id);
      } catch (err: any) {
        this._log('Heartbeat failed for agent %s: %s', agent.id, err.message);
      }
    }
  }

  private async _pollApprovalDecision(
    approvalRequestId: string,
    approvedActionContext: Record<string, unknown>,
  ): Promise<EnforceResult> {
    const startedAt = Date.now();
    const timeoutMs = 30 * 60 * 1000;
    const pollIntervalMs = 5_000;

    while (Date.now() - startedAt < timeoutMs) {
      const url = `${this._baseUrl}${this.apiPath(`/approvals/${approvalRequestId}`)}`;
      const resp = await request({
        method: 'GET',
        url,
        headers: { Authorization: `Bearer ${this._apiKey}` },
        resolveOnClientError: true,
      });

      if (resp.status >= 400) {
        throw new ExeclaveError(
          `Approval polling failed (${resp.status}): ${resp.data?.error?.message ?? 'Unknown error'}`,
        );
      }

      const approval = resp.data?.data;
      if (!approval) {
        throw new ExeclaveError('Approval polling returned no approval payload');
      }

      if (approval.status === 'approved') {
        // Closed loop: never trust `status === 'approved'` alone. Confirm the
        // authorization certificate binds to THIS action before allowing it.
        return this._verifyApprovedDecision(approvalRequestId, approvedActionContext);
      }

      if (approval.status === 'denied') {
        throw new PolicyDeniedError(approvalRequestId, approval.decisionReason);
      }

      if (approval.status === 'expired') {
        throw new ApprovalTimeoutError(approvalRequestId);
      }

      await this._sleep(pollIntervalMs);
    }

    throw new ApprovalTimeoutError(approvalRequestId);
  }

  /**
   * Mandatory certificate verification for an approved request. Fail-closed on
   * every axis:
   *   - the verify call itself failing (network/5xx/malformed) → throw
   *     {@link ApprovalVerificationError} (no confirmation, no execution);
   *   - a definitive `valid: false` from the server → throw
   *     {@link CertificateMismatchError} (the action does not match what a human
   *     approved).
   * Only `valid: true` returns an allowed result.
   */
  private async _verifyApprovedDecision(
    approvalRequestId: string,
    approvedActionContext: Record<string, unknown>,
  ): Promise<EnforceResult> {
    let verification: {
      valid: boolean;
      reason?: string;
      certificate?: Record<string, unknown>;
    };
    try {
      verification = await this.verifyApproval(approvalRequestId, approvedActionContext);
    } catch (err: any) {
      // Distinct from a definitive valid:false — the SDK could not obtain a
      // verdict at all. Fail closed.
      throw new ApprovalVerificationError(approvalRequestId, err?.message ?? String(err));
    }

    if (!verification || typeof verification.valid !== 'boolean') {
      throw new ApprovalVerificationError(approvalRequestId, 'malformed verification response');
    }

    if (!verification.valid) {
      throw new CertificateMismatchError(approvalRequestId, verification.reason);
    }

    return {
      allowed: true,
      approvalRequestId,
      ...(verification.certificate !== undefined
        ? { certificate: verification.certificate }
        : {}),
    } as EnforceResult;
  }

  /**
   * Check if one agent is authorized to call another.
   *
   * @returns Authorization result. Throws `ExeclaveAuthError` on 403.
   */
  async authorizeAgentCall(opts: AuthorizeCallOptions): Promise<AuthorizeResult> {
    this._ensureNotShutdown();

    const resp = await this._request('POST', this.apiPath('/agents/authorize'), {
      callerAgentId: opts.callerAgentId,
      calleeAgentId: opts.calleeAgentId,
      action: opts.action,
    });

    return resp as AuthorizeResult;
  }

  /**
   * Discover agents by capability.
   *
   * @param capability Optional capability to filter by (e.g. 'send_email').
   *                   If omitted, returns all agents with capabilities.
   */
  async discoverAgents(capability?: string): Promise<DiscoveredAgent[]> {
    this._ensureNotShutdown();

    const qs = capability ? `?capability=${encodeURIComponent(capability)}` : '';
    const resp = await this._request('GET', `${this.apiPath('/agents/discover')}${qs}`);
    return (resp.data ?? []) as DiscoveredAgent[];
  }

  /**
   * Return current plan usage and limits.
   */
  async checkUsage(): Promise<UsageStatus> {
    this._ensureNotShutdown();

    const resp = await this._requestRaw('GET', this.apiPath('/billing/usage'));
    const data = (resp.data?.data ?? resp.data ?? {}) as any;
    const nestedUsage = data.usage ?? {};

    const pickBucket = (resource: 'agents' | 'traces' | 'users' | 'policies') => {
      const fromNested = nestedUsage?.[resource];
      if (fromNested && typeof fromNested === 'object') {
        return {
          current: this._toInt(fromNested.current, 0),
          max: this._toInt(fromNested.max, 0),
        };
      }

      const fromTopLevel = data?.[resource] ?? {};
      return {
        current: this._toInt(fromTopLevel.current, 0),
        max: this._toInt(fromTopLevel.max, 0),
      };
    };

    return {
      plan: String(data.plan ?? 'unknown'),
      agents: pickBucket('agents'),
      traces: pickBucket('traces'),
      users: pickBucket('users'),
      policies: pickBucket('policies'),
      upgradeUrl:
        String(data.upgradeUrl ?? '') || 'https://www.execlave.com/dashboard/billing',
    };
  }

  /** Flush remaining traces and shut down the SDK. */
  async shutdown(): Promise<void> {
    this._state = 'SHUTDOWN';
    if (this._flushTimer) {
      clearInterval(this._flushTimer);
      this._flushTimer = null;
    }
    if (this._pollTimer) {
      clearInterval(this._pollTimer);
      this._pollTimer = null;
    }
    if (this._socket) {
      this._socket.disconnect();
      this._socket = null;
    }
    await this._doFlush();
    await this._otelExporter?.shutdown();
    this._log('Execlave SDK shut down');
  }

  // ========================================================================
  // Internal — called by Trace and Agent
  // ========================================================================

  /** @internal */
  _bufferTrace(payload: TracePayload): void {
    this._throwIfQuotaExceeded();

    // Client-side PII scrubbing
    if (this._privacy.enabled) {
      this._applyPrivacy(payload);
    }

    // Client-side injection scanning
    if (this._enableInjectionScan) {
      const injection = this._scanInjection(payload);
      if (injection.detected) {
        if (!payload.metadata) payload.metadata = {};
        payload.metadata.injection_scan = injection;
      }
    }

    // Circular buffer — drop oldest when full
    if (this._buffer.length >= MAX_BUFFER_SIZE) {
      this._buffer.shift();
    }
    this._buffer.push(payload);
    this._log('Buffered trace %s (size: %d)', payload.traceId, this._buffer.length);

    // If sync mode or buffer is full, flush immediately
    if (!this._asyncMode || this._buffer.length >= this._batchSize) {
      this._doFlush().catch(this._logError.bind(this));
    }
  }

  /** @internal */
  _apiPath(path: string): string {
    return this.apiPath(path);
  }

  /** @internal */
  async _request(method: string, path: string, body?: unknown): Promise<any> {
    const resp = await this._requestRaw(method, path, body);
    return resp.data;
  }

  /** Signing descriptor for the HTTP layer when request signing is enabled. */
  private _sign(): { key: string } | undefined {
    return this._signRequests ? { key: this._apiKey } : undefined;
  }

  private async _requestRaw(
    method: string,
    path: string,
    body?: unknown,
    resolveOnClientError = false,
  ): Promise<{ status: number; data: any }> {
    const url = `${this._baseUrl}${path}`;
    return request({
      method,
      url,
      headers: {
        Authorization: `Bearer ${this._apiKey}`,
      },
      body,
      resolveOnClientError,
      sign: this._sign(),
    });
  }

  // ========================================================================
  // Private
  // ========================================================================

  /**
   * Resolve an external agentId string to the internal UUID.
   * Prefer the internal UUID when we have a cached Agent. If no match is found,
   * return the original value; SDK-facing endpoints accept external agentId strings too.
   */
  private _resolveAgentId(agentId: string): string {
    const agent = this._agents.get(agentId);
    if (agent) {
      return agent.id; // internal UUID
    }
    // Maybe the caller already passed a UUID — return as-is
    return agentId;
  }

  private _extractAgentPayload(response: any, agentId: string, environment?: string): AgentData {
    const payload = response?.data ?? response;

    if (payload && !Array.isArray(payload) && typeof payload === 'object') {
      const responseAgentId = (payload as Partial<AgentData>).agentId;
      if (!responseAgentId || responseAgentId === agentId) {
        return payload as AgentData;
      }
      throw new ExeclaveError(
        `Agent registration returned agentId '${responseAgentId}' instead of '${agentId}'`,
      );
    }

    if (Array.isArray(payload)) {
      const agents = payload.filter(
        (item): item is AgentData => item && typeof item === 'object' && 'agentId' in item,
      );
      const matches = agents.filter((item) => item.agentId === agentId);
      if (environment) {
        const environmentMatch = matches.find((item) => item.environment === environment);
        if (environmentMatch) return environmentMatch;
      }
      if (matches.length === 1) return matches[0];
      if (matches.length > 1) {
        throw new ExeclaveError(
          `Agent registration returned multiple entries for agentId '${agentId}'`,
        );
      }
      throw new ExeclaveError(
        `Agent registration response did not include agentId '${agentId}'`,
      );
    }

    throw new ExeclaveError(
      `Agent registration returned unexpected response shape: ${typeof payload}`,
    );
  }

  /**
   * p3 — attach a signed agent credential to each trace in the batch. Resolves one
   * credential per unique agentId (cached by {@link getAgentCredential}) and stamps
   * its token onto every trace for that agent. Best-effort: a failure to issue a
   * credential for an agent leaves that agent's traces unstamped and never throws,
   * so identity stamping can never block or drop trace ingestion.
   */
  private async _stampBatchIdentities(batch: TracePayload[]): Promise<void> {
    const agentIds = new Set<string>();
    for (const trace of batch) {
      if (trace.agentId && !trace.agentCredential) agentIds.add(trace.agentId);
    }
    if (agentIds.size === 0) return;

    const tokens = new Map<string, string>();
    for (const agentId of agentIds) {
      try {
        const cred = await this.getAgentCredential(agentId);
        if (cred?.credential) tokens.set(agentId, cred.credential);
      } catch (err) {
        this._log('Identity stamping skipped for agent %s: %s', agentId, (err as Error).message);
      }
    }

    for (const trace of batch) {
      if (trace.agentId && !trace.agentCredential) {
        const token = tokens.get(trace.agentId);
        if (token) trace.agentCredential = token;
      }
    }
  }

  private async _doFlush(): Promise<void> {
    if (this._buffer.length === 0) return;

    const batch = this._buffer.splice(0, this._buffer.length);

    // OTLP mode — delegate to OTel exporter
    if (this._mode === 'otlp') {
      if (this._otelReady) await this._otelReady;
      if (this._otelExporter) {
        for (let i = 0; i < batch.length; i += this._batchSize) {
          const chunk = batch.slice(i, i + this._batchSize);
          try {
            this._otelExporter.exportTraces(chunk);
            this._log('Exported %d traces via OTLP', chunk.length);
          } catch (err) {
            this._logError(`OTLP export failed for ${chunk.length} traces: ${(err as Error).message}`);
          }
        }
      } else {
        this._logError('OTel exporter not ready — dropping traces');
      }
      return;
    }

    // p3 — best-effort: attach signed agent credentials before sending.
    if (this._stampIdentity) {
      await this._stampBatchIdentities(batch);
    }

    // Native mode — POST to Execlave API
    for (let i = 0; i < batch.length; i += this._batchSize) {
      const chunk = batch.slice(i, i + this._batchSize);
      let retries = 0;
      while (retries < 3) {
        try {
          const resp = await this._requestRaw(
            'POST',
            this.apiPath('/traces/ingest'),
            { traces: chunk },
            true,
          );

          if (resp.status === 402) {
            const quotaError = this._quotaErrorFromBody(resp.data);
            this._setQuotaExceeded(quotaError);
            this._logError(`Trace quota exceeded while flushing ${chunk.length} traces: ${quotaError.message}`);
            break;
          }

          if (resp.status >= 400) {
            throw new ExeclaveError(
              `Trace ingestion failed (${resp.status}): ${resp.data?.error?.message ?? 'Unknown error'}`,
            );
          }

          this._log('Flushed %d traces', chunk.length);
          break;
        } catch (err) {
          retries++;
          if (retries >= 3) {
            this._logError(`Failed to flush ${chunk.length} traces after 3 retries: ${(err as Error).message}`);
          } else {
            await this._sleep(2 ** retries * 500);
          }
        }
      }
    }
  }

  private async _statusPoll(): Promise<void> {
    for (const [agentId, agent] of this._agents) {
      try {
        const resp = await this._request('GET', this.apiPath(`/agents/${agent.id}/status-poll`));
        const newStatus = resp.data?.status ?? 'active';

        if (newStatus === 'paused' && this._state === 'ACTIVE') {
          this._state = 'PAUSED';
          agent.status = 'paused';
          // Drop any cached ALLOW decisions immediately — a paused agent must
          // not keep executing on stale cache entries for the cache TTL.
          this._policyCache.clear();
          this._log('Agent %s has been PAUSED via kill switch', agentId);
        } else if (newStatus === 'active' && this._state === 'PAUSED') {
          this._state = 'ACTIVE';
          agent.status = 'active';
          this._log('Agent %s has been RESUMED', agentId);
        }

        agent.status = newStatus;
      } catch {
        this._log('Status poll failed for agent %s', agentId);
      }
    }
  }

  // ========================================================================
  // Privacy & Injection Scanning
  // ========================================================================

  private _hashPii(value: string): string {
    return createHash('sha256').update(value).digest('hex').slice(0, 16);
  }

  private _toText(data: unknown): string {
    if (data == null) return '';
    if (typeof data === 'string') return data;
    if (typeof data === 'object') {
      if (Array.isArray(data)) return data.map(String).join(' ');
      return Object.values(data as Record<string, unknown>).map(String).join(' ');
    }
    return String(data);
  }

  private _scrubText(text: string): string {
    if (!text) return text ?? '';
    let result = text;
    for (const [piiType, pattern] of Object.entries(PII_PATTERNS)) {
      result = result.replace(new RegExp(pattern.source, pattern.flags), `[${piiType.toUpperCase()}_REDACTED]`);
    }
    return result;
  }

  private _applyPrivacy(payload: TracePayload): void {
    const scrubFields = this._privacy.scrubFields ?? ['input', 'output'];
    const hashPii = this._privacy.hashPii ?? true;
    const piiSummary: Record<string, { count: number; hashes: string[] }> = {};

    for (const field of scrubFields) {
      const value = (payload as any)[field];
      if (!value) continue;
      const text = this._toText(value);
      if (!text) continue;

      // Detect PII
      for (const [piiType, pattern] of Object.entries(PII_PATTERNS)) {
        const matches = text.match(new RegExp(pattern.source, pattern.flags));
        if (matches && matches.length > 0) {
          if (!piiSummary[piiType]) piiSummary[piiType] = { count: 0, hashes: [] };
          piiSummary[piiType].count += matches.length;
          if (hashPii) {
            piiSummary[piiType].hashes.push(...matches.map((m: string) => this._hashPii(m)));
          }
        }
      }

      // Replace PII with placeholders
      if (typeof value === 'string') {
        (payload as any)[field] = this._scrubText(value);
      } else if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
        const scrubbed: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
          scrubbed[k] = typeof v === 'string' ? this._scrubText(v) : v;
        }
        (payload as any)[field] = scrubbed;
      }
    }

    if (Object.keys(piiSummary).length > 0) {
      if (!payload.metadata) payload.metadata = {};
      payload.metadata.pii_detected = piiSummary;
      payload.metadata.pii_scrubbed = true;
    }
  }

  private _scanInjection(payload: TracePayload): { detected: boolean; risk_level: string; patterns_matched: string[] } {
    const text = this._toText(payload.input);
    if (!text) return { detected: false, risk_level: 'none', patterns_matched: [] };

    const matched: string[] = [];
    for (const pattern of INJECTION_PATTERNS) {
      if (pattern.test(text)) {
        matched.push(pattern.source);
      }
    }

    const count = matched.length;
    let risk: string;
    if (count === 0) risk = 'none';
    else if (count === 1) risk = 'low';
    else if (count <= 3) risk = 'medium';
    else if (count <= 5) risk = 'high';
    else risk = 'critical';

    return { detected: count > 0, risk_level: risk, patterns_matched: matched };
  }

  // ========================================================================
  // Helpers
  // ========================================================================

  private _firstAgentId(): string | undefined {
    const first = this._agents.values().next();
    return first.done ? undefined : first.value.agentId;
  }

  private _firstAgent(): Agent | undefined {
    const first = this._agents.values().next();
    return first.done ? undefined : first.value;
  }

  private _ensureNotShutdown(): void {
    if (this._state === 'SHUTDOWN') {
      throw new ExeclaveError('SDK has been shut down. Call not allowed.');
    }
  }

  private _sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Connect to the Socket.IO /sdk namespace for real-time control channel.
   * Falls back silently to HTTP polling if socket.io-client is not installed.
   */
  private _connectWebSocket(): void {
    try {
      // Dynamic require — socket.io-client is an optional peer dependency
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const { io } = require('socket.io-client');

      // Use the first registered agent's agentId if available
      const agentId = this._firstAgentId();

      this._socket = io(`${this._baseUrl}/sdk`, {
        auth: {
          apiKey: this._apiKey,
          agentId,
        },
        transports: ['websocket'],
        reconnection: true,
        reconnectionDelay: 2000,
        reconnectionAttempts: 10,
      });

      this._socket.on(
        'agent.status_updated',
        (data: { agentId: string; status: string; reason?: string }) => {
          const agent = data.agentId ? this._agents.get(data.agentId) : undefined;

          if (data.status === 'paused' && this._state === 'ACTIVE') {
            this._state = 'PAUSED';
            if (agent) agent.status = 'paused';
            // Drop cached ALLOW decisions the instant a pause arrives.
            this._policyCache.clear();
            this._log(
              'Agent %s PAUSED via WebSocket kill switch (reason: %s)',
              data.agentId,
              data.reason ?? 'none',
            );
          } else if (data.status === 'active' && this._state === 'PAUSED') {
            this._state = 'ACTIVE';
            if (agent) agent.status = 'active';
            this._log('Agent %s RESUMED via WebSocket', data.agentId);
          }
        },
      );

      this._socket.on('connect', () => {
        this._log('WebSocket control channel connected');
      });

      this._socket.on('connect_error', (err: Error) => {
        // Silently fall back to HTTP polling — no user action needed
        this._log('WebSocket connect error: %s — falling back to HTTP polling', err.message);
      });
    } catch {
      // socket.io-client not installed — HTTP polling continues as fallback
    }
  }

  /**
   * Report that enforcement was bypassed and the action proceeded anyway.
   *
   * Timestamped here rather than by the listener so the ungoverned window is
   * recorded at the moment it happened. The handler is invoked synchronously
   * and any exception it throws is swallowed: a faulty listener must never be
   * able to break the enforcement path it is only observing.
   */
  private _emitBypass(event: Omit<EnforcementBypassEvent, 'timestamp'>): void {
    if (!this._onEnforcementBypassed) return;
    try {
      this._onEnforcementBypassed({ ...event, timestamp: new Date().toISOString() });
    } catch (err) {
      this._logError(err);
    }
  }

  private _log(msg: string, ...args: unknown[]): void {
    if (this._debug) {
      // Callers write `%s` placeholders, but passing `msg` through as data (to
      // avoid CWE-134) meant the placeholders were never substituted and debug
      // output read "Policy cache hit for %s agent-1".
      //
      // Substitution is done here instead, then handed to console as DATA. That
      // keeps both properties: the placeholders resolve, and no
      // externally-influenced text is ever interpreted as a format specifier —
      // interpolation is a single non-recursive pass, so a `%s` occurring
      // inside a substituted value cannot consume the next argument.
      console.debug('[Execlave]', formatLogMessage(msg, args));
    }
  }

  private _logError(msg: string | unknown): void {
    if (this._debug) {
      console.error('[Execlave]', msg);
    }
  }
}
