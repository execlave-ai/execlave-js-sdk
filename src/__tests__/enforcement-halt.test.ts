/**
 * Regression guard: every governance decision that must STOP execution has to
 * be classified as an enforcement error, so integration wrappers rethrow it
 * instead of swallowing it as "non-fatal".
 *
 * This locks the fix for the bug where CertificateMismatchError (post-approval
 * action drift) was NOT in the adapters' hand-maintained `instanceof`
 * allowlists, so a drift rejection was caught, logged, and execution continued
 * — silently turning a fail-closed guarantee into fail-open on every adapter
 * path.
 */
import {
  isEnforcementError,
  EnforcementHaltError,
  ExeclaveError,
  ExeclaveAuthError,
  AgentPausedError,
  PolicyBlockedError,
  ValidatorDeniedError,
  ToolIntegrityError,
  PolicyDeniedError,
  ApprovalTimeoutError,
  CertificateMismatchError,
  ApprovalVerificationError,
  EnforcementUnavailableError,
  QuotaExceededError,
  PlanLimitExceededError,
} from '../errors';

const VIOLATION = [
  {
    policyId: 'p1',
    policyName: 'P',
    policyType: 'custom_validator',
    message: 'no',
    enforcementMode: 'block',
  },
];

describe('enforcement halt classification', () => {
  it('classifies every halt-decision error as an enforcement error', () => {
    const haltErrors: unknown[] = [
      new AgentPausedError('agent_1', 'paused'),
      new PolicyBlockedError(VIOLATION),
      new ValidatorDeniedError(VIOLATION),
      new ToolIntegrityError(VIOLATION),
      new PolicyDeniedError('apr_1', 'denied'),
      new ApprovalTimeoutError('apr_1'),
      new CertificateMismatchError('apr_1', 'action_context_mismatch'),
      new ApprovalVerificationError('apr_1', 'ECONNRESET'),
      new EnforcementUnavailableError(3, 'boom'),
    ];

    for (const err of haltErrors) {
      expect(isEnforcementError(err)).toBe(true);
      expect(err).toBeInstanceOf(EnforcementHaltError);
    }
  });

  it('post-approval drift errors specifically are halt decisions (the regression)', () => {
    // These two were added with the fail-closed auto-verify work and were the
    // ones missing from the adapters' allowlists.
    expect(isEnforcementError(new CertificateMismatchError('apr_1', 'certificate_expired'))).toBe(
      true,
    );
    expect(isEnforcementError(new ApprovalVerificationError('apr_1'))).toBe(true);
  });

  it('does NOT classify non-halt errors as enforcement errors', () => {
    const nonHalt: unknown[] = [
      new ExeclaveError('generic'),
      new ExeclaveAuthError(),
      new QuotaExceededError('traces', 10, 10),
      new PlanLimitExceededError('traces', 10, 10),
      new Error('plain'),
      undefined,
      null,
    ];

    for (const err of nonHalt) {
      expect(isEnforcementError(err)).toBe(false);
    }
  });

  it('halt errors keep their own identity (subclass checks still work)', () => {
    const denied = new ValidatorDeniedError(VIOLATION);
    expect(denied).toBeInstanceOf(ValidatorDeniedError);
    expect(denied).toBeInstanceOf(PolicyBlockedError);
    expect(denied).toBeInstanceOf(EnforcementHaltError);
    expect(denied).toBeInstanceOf(ExeclaveError);
    expect(denied.name).toBe('ValidatorDeniedError');
  });
});
