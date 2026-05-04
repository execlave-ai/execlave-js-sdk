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
  ValidatorDeniedError,
  PolicyDeniedError,
  ApprovalTimeoutError,
  EnforcementUnavailableError,
  QuotaExceededError,
  PlanLimitExceededError,
} from './errors';
import type {
  ExeclaveConfig,
  PrivacyConfig,
  RegisterAgentOptions,
  TraceOptions,
  TracePayload,
  AgentData,
  EnforcePolicyOptions,
  EnforceResult,
  AuthorizeCallOptions,
  AuthorizeResult,
  DiscoveredAgent,
  UsageStatus,
} from './types';
import { createHash } from 'crypto';

type SdkState = 'INITIALIZING' | 'ACTIVE' | 'PAUSED' | 'SHUTDOWN';

const MAX_BUFFER_SIZE = 10_000;

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
 * const ag = new Execlave({ apiKey: 'exe_prod_xxx', environment: 'production' });
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
  private _mode: 'native' | 'otlp';
  private _otlpEndpoint?: string;
  private _otelExporter: import('./otel').OTelExporter | null = null;
  private _otelReady: Promise<void> | null = null;

  private _state: SdkState = 'INITIALIZING';
  private _buffer: TracePayload[] = [];
  private _agents: Map<string, Agent> = new Map();

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
  private _heartbeatIntervalMs: number = 600_000;

  constructor(config: ExeclaveConfig = {}) {
    this._apiKey = config.apiKey ?? process.env.EXECLAVE_API_KEY ?? '';
    if (!this._apiKey) {
      throw new Error('apiKey must be provided or EXECLAVE_API_KEY env var must be set');
    }

    this._baseUrl = (config.baseUrl ?? process.env.EXECLAVE_BASE_URL ?? 'https://api.execlave.com').replace(/\/+$/, '');
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
    this._mode = config.mode ?? 'native';
    this._otlpEndpoint = config.otlpEndpoint;
    this._enforcementOnOutage = config.enforcementOnOutage ?? 'fail_open';
    this._planLimitBehavior = config.planLimitBehavior ?? 'fail_open';
    this._heartbeatIntervalMs = config.heartbeatIntervalMs ?? 600_000;
    this._policyCacheTtlMs = config.policyCacheTtlMs ?? 60_000;

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
    const payload: Record<string, unknown> = {
      agentId: opts.agentId,
      name: opts.name,
      type: opts.type ?? 'chatbot',
      platform: opts.platform ?? 'custom',
      environment: opts.environment ?? this._environment,
    };
    if (opts.description) payload.description = opts.description;
    if (opts.ownerEmail) payload.ownerEmail = opts.ownerEmail;
    if (opts.allowedDataSources) payload.allowedDataSources = opts.allowedDataSources;
    if (opts.allowedActions) payload.allowedActions = opts.allowedActions;
    if (opts.requiresHumanApprovalFor) payload.requiresHumanApprovalFor = opts.requiresHumanApprovalFor;
    if (opts.tags) payload.tags = opts.tags;
    if (opts.metadata) payload.metadata = opts.metadata;

    try {
      const resp = await this._request('POST', this.apiPath('/agents'), payload);
      const data = (resp.data ?? resp) as AgentData;
      const agent = new Agent(this, data);
      this._agents.set(opts.agentId, agent);
      return agent;
    } catch (err) {
      // If agent already exists, try to fetch it
      if (err instanceof ExeclaveError && err.message.includes('already exists')) {
        const listResp = await this._request('GET', `${this.apiPath('/agents')}?search=${encodeURIComponent(opts.agentId)}`);
        const agents = (listResp.data ?? []) as AgentData[];
        const match = agents.find((a) => a.agentId === opts.agentId);
        if (match) {
          const agent = new Agent(this, match);
          this._agents.set(opts.agentId, agent);
          return agent;
        }
      }
      throw err;
    }
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

    // 1. Check cache
    const cacheKey = this._policyCacheKey(opts.agentId, opts.input);
    const cached = this._policyCacheGet(cacheKey);
    if (cached) {
      this._log('Policy cache hit for %s', opts.agentId);
      return cached;
    }

    // 2. Check circuit breaker
    if (this._cbIsOpen()) {
      if (this._enforcementOnOutage === 'fail_closed') {
        throw new EnforcementUnavailableError(this._cbFailures, this._cbLastError);
      }
      this._log('Circuit breaker open — fail_open, allowing execution for %s', opts.agentId);
      return { allowed: true } as EnforceResult;
    }

    // 3. Build payload and make HTTP call
    // Resolve external agentId to internal UUID if we have a cached agent
    const resolvedAgentId = this._resolveAgentId(opts.agentId);

    const payload = {
      agentId: resolvedAgentId,
      input: opts.input,
      environment: opts.environment ?? this._environment,
      metadata: opts.metadata,
      estimatedCost: opts.estimatedCost,
      tools: opts.tools,
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
      });
    } catch (err: any) {
      // Network failure → circuit breaker
      this._cbRecordFailure(err.message ?? String(err));
      if (this._enforcementOnOutage === 'fail_closed' && this._cbIsOpen()) {
        throw new EnforcementUnavailableError(this._cbFailures, err.message);
      }
      this._log('Network error in enforcePolicy (fail_open): %s', err.message);
      return { allowed: true } as EnforceResult;
    }

    // 4. Record success in circuit breaker
    this._cbRecordSuccess();

    // 5. Handle response codes
    // 403 → blocked by policy
    if (resp.status === 403 && resp.data?.allowed === false) {
      throw ValidatorDeniedError.fromViolations(resp.data.violations ?? []);
    }

    // 202 → require approval (never cached)
    if (resp.status === 202 && resp.data?.approvalRequestId) {
      const approvalRequestId = resp.data.approvalRequestId as string;
      return this._pollApprovalDecision(approvalRequestId);
    }

    // 402 → plan quota exhausted
    if (resp.status === 402) {
      const quotaError = this._quotaErrorFromBody(resp.data);
      this._setQuotaExceeded(quotaError);
      if (this._planLimitBehavior === 'fail_open') {
        this._log(`[warn] Plan limit exceeded for ${quotaError.resource} (${quotaError.current}/${quotaError.max}) — continuing unmonitored`);
        return { allowed: true, warnings: [{ policyId: 'plan_limit', policyName: 'Plan Limit', policyType: 'plan_limit', message: quotaError.message, enforcementMode: 'warn' }] };
      }
      throw new PlanLimitExceededError(quotaError.resource, quotaError.current, quotaError.max, quotaError.message);
    }

    // Other client errors
    if (resp.status >= 400) {
      throw new ExeclaveError(`Enforce policy failed (${resp.status}): ${resp.data?.error?.message ?? 'Unknown error'}`);
    }

    // 6. Cache and return
    const result = resp.data as EnforceResult;
    this._policyCacheSet(cacheKey, result);
    return result;
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

  private _policyCacheKey(agentId: string, input: string): string {
    const hash = createHash('sha256').update(`${agentId}:${input}`).digest('hex').slice(0, 16);
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

  private async _pollApprovalDecision(approvalRequestId: string): Promise<EnforceResult> {
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
        return { allowed: true, approvalRequestId };
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
    });
  }

  // ========================================================================
  // Private
  // ========================================================================

  /**
   * Resolve an external agentId string to the internal UUID.
   * The API endpoints like /policies/enforce expect the internal UUID,
   * but users naturally pass the external agentId (e.g. "my-bot").
   * This looks up the cached Agent and returns its UUID (.id).
   * If no match is found, returns the original value unchanged.
   */
  private _resolveAgentId(agentId: string): string {
    const agent = this._agents.get(agentId);
    if (agent) {
      return agent.id; // internal UUID
    }
    // Maybe the caller already passed a UUID — return as-is
    return agentId;
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

  private _log(msg: string, ...args: unknown[]): void {
    if (this._debug) {
      console.debug(`[Execlave] ${msg}`, ...args);
    }
  }

  private _logError(msg: string | unknown): void {
    if (this._debug) {
      console.error(`[Execlave] ${msg}`);
    }
  }
}
