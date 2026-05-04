/**
 * Execlave SDK error classes.
 */

/** Base error for all Execlave SDK errors. */
export class ExeclaveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExeclaveError';
  }
}

/** Raised when authentication fails (invalid API key or insufficient permissions). */
export class ExeclaveAuthError extends ExeclaveError {
  constructor(message = 'Invalid API key or insufficient permissions') {
    super(message);
    this.name = 'ExeclaveAuthError';
  }
}

/**
 * Raised when an agent is paused via the kill switch.
 *
 * New trace calls throw this immediately without hitting the LLM.
 * In-flight traces complete naturally (no mid-execution termination).
 * Your application should catch this and return a graceful message to users.
 */
export class AgentPausedError extends ExeclaveError {
  agentId: string;
  reason?: string;

  constructor(agentId: string, reason?: string) {
    const msg = reason
      ? `Agent '${agentId}' is paused: ${reason}`
      : `Agent '${agentId}' is paused`;
    super(msg);
    this.name = 'AgentPausedError';
    this.agentId = agentId;
    this.reason = reason;
  }
}

/**
 * Raised when pre-execution policy enforcement blocks the request.
 *
 * Contains the list of policy violations that caused the block.
 * Your application should catch this and return a safe message to users
 * instead of executing the LLM call.
 */
export class PolicyBlockedError extends ExeclaveError {
  violations: Array<{
    policyId: string;
    policyName: string;
    policyType: string;
    message: string;
    enforcementMode: string;
  }>;

  constructor(violations: PolicyBlockedError['violations']) {
    const messages = violations.map((v) => `[${v.policyType}] ${v.message}`);
    super(`Execution blocked by policy: ${messages.join('; ')}`);
    this.name = 'PolicyBlockedError';
    this.violations = violations;
  }
}

/**
 * Raised when a {@link PolicyBlockedError} is caused by a `custom_validator`
 * policy — i.e. the block decision came from a customer-hosted HTTP endpoint
 * (Bring-Your-Own-Validator / BYOV). Programmatic code can `instanceof`
 * this class to distinguish validator denials from built-in policy blocks.
 */
export class ValidatorDeniedError extends PolicyBlockedError {
  /** Violations whose policy_type === 'custom_validator'. */
  validatorViolations: PolicyBlockedError['violations'];

  constructor(violations: PolicyBlockedError['violations']) {
    super(violations);
    this.name = 'ValidatorDeniedError';
    this.validatorViolations = violations.filter(
      (v) => v.policyType === 'custom_validator',
    );
  }

  /**
   * Build a ValidatorDeniedError from an arbitrary list of violations if at
   * least one is a custom_validator violation; otherwise returns a plain
   * {@link PolicyBlockedError}.
   */
  static fromViolations(
    violations: PolicyBlockedError['violations'],
  ): PolicyBlockedError {
    const hasValidator = violations.some((v) => v.policyType === 'custom_validator');
    return hasValidator ? new ValidatorDeniedError(violations) : new PolicyBlockedError(violations);
  }
}

export class PolicyDeniedError extends ExeclaveError {
  approvalRequestId: string;
  reason?: string;

  constructor(approvalRequestId: string, reason?: string) {
    super(
      reason
        ? `Approval request '${approvalRequestId}' was denied: ${reason}`
        : `Approval request '${approvalRequestId}' was denied`,
    );
    this.name = 'PolicyDeniedError';
    this.approvalRequestId = approvalRequestId;
    this.reason = reason;
  }
}

export class ApprovalTimeoutError extends ExeclaveError {
  approvalRequestId: string;

  constructor(approvalRequestId: string) {
    super(`Approval request '${approvalRequestId}' timed out`);
    this.name = 'ApprovalTimeoutError';
    this.approvalRequestId = approvalRequestId;
  }
}

/**
 * Raised when the Execlave enforcement endpoint is unreachable
 * and the SDK is configured with `enforcementOnOutage: 'fail_closed'`.
 *
 * The circuit breaker trips after 3 consecutive failures. When this error
 * is thrown, your application should halt agent execution.
 */
export class EnforcementUnavailableError extends ExeclaveError {
  consecutiveFailures: number;
  lastError?: string;

  constructor(consecutiveFailures: number, lastError?: string) {
    const msg =
      `Enforcement unavailable after ${consecutiveFailures} consecutive failures. ` +
      `SDK is in fail_closed mode — agent execution is blocked.` +
      (lastError ? ` Last error: ${lastError}` : '');
    super(msg);
    this.name = 'EnforcementUnavailableError';
    this.consecutiveFailures = consecutiveFailures;
    this.lastError = lastError;
  }
}

/**
 * Raised when the organization's plan quota is exhausted.
 */
export class QuotaExceededError extends ExeclaveError {
  resource: string;
  current: number;
  max: number;

  constructor(resource: string, current: number, max: number, message = '') {
    super(
      message ||
        `Plan limit reached for ${resource} (${current}/${max}). ` +
          'Upgrade at https://www.execlave.com/dashboard/billing',
    );
    this.name = 'QuotaExceededError';
    this.resource = resource;
    this.current = current;
    this.max = max;
  }
}

/**
 * Raised when the organization's plan limit is exceeded and the SDK is
 * configured with `planLimitBehavior: 'fail_closed'`.
 *
 * When `planLimitBehavior` is `'fail_open'` (default), the SDK logs a
 * warning and allows execution to continue unmonitored instead of throwing.
 */
export class PlanLimitExceededError extends QuotaExceededError {
  constructor(resource: string, current: number, max: number, message = '') {
    super(resource, current, max, message);
    this.name = 'PlanLimitExceededError';
  }
}
