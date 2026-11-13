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
 * Base class for every error that represents a governance decision to STOP
 * agent execution — a policy block, an approval denial/timeout, a certificate
 * that does not bind the action, an unverifiable approval, a paused agent, or a
 * fail-closed enforcement outage.
 *
 * Integrations MUST rethrow these rather than swallowing them (see
 * {@link isEnforcementError}). Deriving from a common base is deliberate: a new
 * enforcement error added below automatically halts execution everywhere,
 * instead of silently failing open until every wrapper's allowlist is updated.
 * Errors that are NOT halt decisions (auth failures, plan/quota limits, which
 * have their own fail-open handling) intentionally do not extend this.
 */
export class EnforcementHaltError extends ExeclaveError {
  constructor(message: string) {
    super(message);
    this.name = 'EnforcementHaltError';
  }
}

/**
 * True when an error is a governance decision to halt execution.
 *
 * Single source of truth — integrations import this instead of maintaining
 * their own `instanceof` allowlists (the duplication that previously let
 * certificate-mismatch rejections be swallowed as "non-fatal").
 */
export function isEnforcementError(err: unknown): boolean {
  return err instanceof EnforcementHaltError;
}

/**
 * Raised when an agent is paused via the kill switch.
 *
 * New trace calls throw this immediately without hitting the LLM.
 * In-flight traces complete naturally (no mid-execution termination).
 * Your application should catch this and return a graceful message to users.
 */
export class AgentPausedError extends EnforcementHaltError {
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
export class PolicyBlockedError extends EnforcementHaltError {
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

/**
 * Raised when a {@link PolicyBlockedError} is caused by a `tool_integrity`
 * policy — an MCP tool descriptor drifted from its pinned baseline, an
 * unapproved tool/server was used, or a tool description matched a poisoning
 * pattern. Programmatic code can `instanceof` this to react to supply-chain
 * tampering (e.g. quarantine the agent, alert security).
 */
export class ToolIntegrityError extends PolicyBlockedError {
  /** Violations whose policy_type === 'tool_integrity'. */
  toolViolations: PolicyBlockedError['violations'];

  constructor(violations: PolicyBlockedError['violations']) {
    super(violations);
    this.name = 'ToolIntegrityError';
    this.toolViolations = violations.filter((v) => v.policyType === 'tool_integrity');
  }
}

/**
 * Build the most specific PolicyBlockedError subclass for a list of
 * violations: a `custom_validator` denial → {@link ValidatorDeniedError};
 * otherwise a `tool_integrity` block → {@link ToolIntegrityError}; otherwise a
 * plain {@link PolicyBlockedError}.
 */
export function policyBlockedErrorFromViolations(
  violations: PolicyBlockedError['violations'],
): PolicyBlockedError {
  if (violations.some((v) => v.policyType === 'custom_validator')) {
    return new ValidatorDeniedError(violations);
  }
  if (violations.some((v) => v.policyType === 'tool_integrity')) {
    return new ToolIntegrityError(violations);
  }
  return new PolicyBlockedError(violations);
}

export class PolicyDeniedError extends EnforcementHaltError {
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

export class ApprovalTimeoutError extends EnforcementHaltError {
  approvalRequestId: string;

  constructor(approvalRequestId: string) {
    super(`Approval request '${approvalRequestId}' timed out`);
    this.name = 'ApprovalTimeoutError';
    this.approvalRequestId = approvalRequestId;
  }
}

/**
 * Raised when an approval was granted but its authorization certificate does
 * NOT bind to the action the SDK is about to execute — i.e. the server returned
 * `valid: false` from the verify step.
 *
 * This is the closed-loop, fail-closed guard: an approval only authorizes the
 * exact action a human approved. A mismatch means the presented action context
 * differs from the approved one (`action_context_mismatch`), the certificate is
 * expired (`certificate_expired`), already consumed (`certificate_already_used`),
 * unanchored in the audit chain (`certificate_unanchored`), or tampered
 * (`certificate_tampered`). Execution MUST NOT proceed — treat like a denial.
 */
export class CertificateMismatchError extends EnforcementHaltError {
  approvalRequestId: string;
  /** Server-provided machine-readable reason (e.g. 'action_context_mismatch'). */
  reason?: string;

  constructor(approvalRequestId: string, reason?: string) {
    super(
      `Authorization certificate for approval '${approvalRequestId}' does not ` +
        `bind to the action being executed` +
        (reason ? ` (${reason})` : '') +
        ' — execution blocked.',
    );
    this.name = 'CertificateMismatchError';
    this.approvalRequestId = approvalRequestId;
    this.reason = reason;
  }
}

/**
 * Raised when the SDK could not positively confirm an approval's certificate —
 * the verify call itself failed (network error, 5xx, malformed response), as
 * opposed to a definitive `valid: false` ({@link CertificateMismatchError}).
 *
 * Fail-closed by design: no confirmation means no execution. Catch this to
 * halt the agent (and optionally retry) rather than proceeding on an
 * unverified approval.
 */
export class ApprovalVerificationError extends EnforcementHaltError {
  approvalRequestId: string;
  cause?: string;

  constructor(approvalRequestId: string, cause?: string) {
    super(
      `Could not verify the authorization certificate for approval ` +
        `'${approvalRequestId}'` +
        (cause ? `: ${cause}` : '') +
        ' — execution blocked (fail-closed).',
    );
    this.name = 'ApprovalVerificationError';
    this.approvalRequestId = approvalRequestId;
    this.cause = cause;
  }
}

/**
 * Raised when the Execlave enforcement endpoint is unreachable
 * and the SDK is configured with `enforcementOnOutage: 'fail_closed'`.
 *
 * The circuit breaker trips after 3 consecutive failures. When this error
 * is thrown, your application should halt agent execution.
 */
export class EnforcementUnavailableError extends EnforcementHaltError {
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
 * Raised when a framework adapter attempts to call the internal
 * `enforcePolicyBound` boundary with `metadata` that was not produced by
 * `sealForMetadata`/`sealMetadataEntry`/`sealMetadata` (see
 * `_actionBinding.ts`).
 *
 * This is a contract violation in OUR OWN adapter code, not an operational
 * failure or a policy decision — it means a material field could have been
 * silently omitted from the certificate's canonical action context. Treated
 * as fail-closed rather than the "log and continue" behavior other
 * `EnforcementHaltError` subclasses get from adapters, for the same reason:
 * an unbound certificate is worse than a blocked call.
 */
export class MetadataContractError extends EnforcementHaltError {
  constructor(detail?: string) {
    super(
      'enforcePolicy metadata must be sealed via sealForMetadata/sealMetadataEntry/' +
        'sealMetadata before crossing the enforcePolicyBound boundary' +
        (detail ? ` (${detail})` : '') +
        ' — execution blocked.',
    );
    this.name = 'MetadataContractError';
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
