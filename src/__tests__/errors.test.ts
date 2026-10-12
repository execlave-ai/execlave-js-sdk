import {
  ExeclaveError,
  ExeclaveAuthError,
  AgentPausedError,
  PolicyBlockedError,
  ValidatorDeniedError,
  PolicyDeniedError,
  ApprovalTimeoutError,
  QuotaExceededError,
  PlanLimitExceededError,
} from '../errors';

describe('ExeclaveError', () => {
  it('should be an instance of Error', () => {
    const err = new ExeclaveError('something went wrong');
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(ExeclaveError);
  });

  it('should set name to ExeclaveError', () => {
    const err = new ExeclaveError('msg');
    expect(err.name).toBe('ExeclaveError');
  });

  it('should carry the provided message', () => {
    const err = new ExeclaveError('detailed message');
    expect(err.message).toBe('detailed message');
  });

  it('should have a stack trace', () => {
    const err = new ExeclaveError('stack test');
    expect(err.stack).toBeDefined();
    expect(err.stack).toContain('ExeclaveError');
  });
});

describe('ExeclaveAuthError', () => {
  it('should extend ExeclaveError', () => {
    const err = new ExeclaveAuthError();
    expect(err).toBeInstanceOf(ExeclaveError);
    expect(err).toBeInstanceOf(Error);
  });

  it('should have default message', () => {
    const err = new ExeclaveAuthError();
    expect(err.message).toBe('Invalid API key or insufficient permissions');
  });

  it('should accept custom message', () => {
    const err = new ExeclaveAuthError('Custom auth error');
    expect(err.message).toBe('Custom auth error');
  });

  it('should set name to ExeclaveAuthError', () => {
    const err = new ExeclaveAuthError();
    expect(err.name).toBe('ExeclaveAuthError');
  });
});

describe('AgentPausedError', () => {
  it('should extend ExeclaveError', () => {
    const err = new AgentPausedError('bot-1');
    expect(err).toBeInstanceOf(ExeclaveError);
    expect(err).toBeInstanceOf(Error);
  });

  it('should set name to AgentPausedError', () => {
    const err = new AgentPausedError('bot-1');
    expect(err.name).toBe('AgentPausedError');
  });

  it('should carry agentId', () => {
    const err = new AgentPausedError('my-agent');
    expect(err.agentId).toBe('my-agent');
  });

  it('should produce a default message without reason', () => {
    const err = new AgentPausedError('abc');
    expect(err.message).toBe("Agent 'abc' is paused");
  });

  it('should include reason in message when provided', () => {
    const err = new AgentPausedError('abc', 'compliance violation');
    expect(err.message).toBe("Agent 'abc' is paused: compliance violation");
    expect(err.reason).toBe('compliance violation');
  });

  it('should have undefined reason when not provided', () => {
    const err = new AgentPausedError('x');
    expect(err.reason).toBeUndefined();
  });
});

describe('PolicyBlockedError', () => {
  const violations = [
    {
      policyId: 'pol-1',
      policyName: 'Injection Scan',
      policyType: 'injection_scan',
      message: 'Prompt injection detected',
      enforcementMode: 'block',
    },
  ];

  it('should extend ExeclaveError', () => {
    const err = new PolicyBlockedError(violations);
    expect(err).toBeInstanceOf(ExeclaveError);
    expect(err).toBeInstanceOf(Error);
  });

  it('should set name to PolicyBlockedError', () => {
    const err = new PolicyBlockedError(violations);
    expect(err.name).toBe('PolicyBlockedError');
  });

  it('should carry violations array', () => {
    const err = new PolicyBlockedError(violations);
    expect(err.violations).toHaveLength(1);
    expect(err.violations[0].policyType).toBe('injection_scan');
  });

  it('should produce a message listing violation types', () => {
    const err = new PolicyBlockedError(violations);
    expect(err.message).toContain('[injection_scan]');
    expect(err.message).toContain('Prompt injection detected');
  });

  it('should handle multiple violations', () => {
    const multi = [
      ...violations,
      {
        policyId: 'pol-2',
        policyName: 'Data Restriction',
        policyType: 'data_restriction',
        message: 'Contains PII',
        enforcementMode: 'block',
      },
    ];
    const err = new PolicyBlockedError(multi);
    expect(err.violations).toHaveLength(2);
    expect(err.message).toContain('[data_restriction]');
  });
});

describe('ValidatorDeniedError', () => {
  const validatorViolation = {
    policyId: 'pol-3',
    policyName: 'Finance Validator',
    policyType: 'custom_validator',
    message: 'Exceeds finance team spend limit',
    enforcementMode: 'block',
  };
  const injectionViolation = {
    policyId: 'pol-1',
    policyName: 'Injection Scan',
    policyType: 'injection_scan',
    message: 'Prompt injection detected',
    enforcementMode: 'block',
  };

  it('extends PolicyBlockedError and sets name', () => {
    const err = new ValidatorDeniedError([validatorViolation]);
    expect(err).toBeInstanceOf(PolicyBlockedError);
    expect(err).toBeInstanceOf(ExeclaveError);
    expect(err.name).toBe('ValidatorDeniedError');
  });

  it('exposes only custom_validator violations on validatorViolations', () => {
    const err = new ValidatorDeniedError([validatorViolation, injectionViolation]);
    expect(err.violations).toHaveLength(2);
    expect(err.validatorViolations).toHaveLength(1);
    expect(err.validatorViolations[0].policyId).toBe('pol-3');
  });

  it('fromViolations returns ValidatorDeniedError when a validator fired', () => {
    const err = ValidatorDeniedError.fromViolations([injectionViolation, validatorViolation]);
    expect(err).toBeInstanceOf(ValidatorDeniedError);
  });

  it('fromViolations returns PolicyBlockedError when no validator fired', () => {
    const err = ValidatorDeniedError.fromViolations([injectionViolation]);
    expect(err).toBeInstanceOf(PolicyBlockedError);
    expect(err).not.toBeInstanceOf(ValidatorDeniedError);
  });
});

describe('PolicyDeniedError', () => {
  it('should carry approval request id and optional reason', () => {
    const err = new PolicyDeniedError('apr_123', 'Denied by reviewer');
    expect(err).toBeInstanceOf(ExeclaveError);
    expect(err.approvalRequestId).toBe('apr_123');
    expect(err.reason).toBe('Denied by reviewer');
    expect(err.message).toContain('Denied by reviewer');
  });
});

describe('ApprovalTimeoutError', () => {
  it('should carry approval request id', () => {
    const err = new ApprovalTimeoutError('apr_456');
    expect(err).toBeInstanceOf(ExeclaveError);
    expect(err.approvalRequestId).toBe('apr_456');
    expect(err.message).toContain('timed out');
  });
});

describe('QuotaExceededError', () => {
  it('should extend ExeclaveError', () => {
    const err = new QuotaExceededError('maxTracesPerMonth', 10000, 10000);
    expect(err).toBeInstanceOf(ExeclaveError);
    expect(err).toBeInstanceOf(Error);
  });

  it('should expose resource and usage fields', () => {
    const err = new QuotaExceededError('maxTracesPerMonth', 10000, 10000);
    expect(err.resource).toBe('maxTracesPerMonth');
    expect(err.current).toBe(10000);
    expect(err.max).toBe(10000);
  });

  it('should include upgrade URL in default message', () => {
    const err = new QuotaExceededError('traces', 10000, 10000);
    expect(err.message).toContain('Plan limit reached for traces (10000/10000)');
    expect(err.message).toContain('https://www.execlave.com/dashboard/billing');
  });
});

describe('PlanLimitExceededError', () => {
  it('should extend QuotaExceededError', () => {
    const err = new PlanLimitExceededError('maxAgents', 3, 3);
    expect(err).toBeInstanceOf(QuotaExceededError);
    expect(err).toBeInstanceOf(ExeclaveError);
    expect(err).toBeInstanceOf(Error);
  });

  it('should set name to PlanLimitExceededError', () => {
    const err = new PlanLimitExceededError('maxAgents', 3, 3);
    expect(err.name).toBe('PlanLimitExceededError');
  });

  it('should expose resource and usage fields', () => {
    const err = new PlanLimitExceededError('maxTracesPerMonth', 10000, 10000);
    expect(err.resource).toBe('maxTracesPerMonth');
    expect(err.current).toBe(10000);
    expect(err.max).toBe(10000);
  });
});
