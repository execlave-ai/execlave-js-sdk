import {
  PolicyBlockedError,
  ValidatorDeniedError,
  ToolIntegrityError,
  policyBlockedErrorFromViolations,
} from '../errors';

const toolViolation = {
  policyId: 'p1',
  policyName: 'Tool Integrity',
  policyType: 'tool_integrity',
  message: 'Descriptor for "read_file" changed since it was pinned.',
  enforcementMode: 'block',
};

const validatorViolation = {
  policyId: 'p2',
  policyName: 'BYOV',
  policyType: 'custom_validator',
  message: 'denied',
  enforcementMode: 'block',
};

const plainViolation = {
  policyId: 'p3',
  policyName: 'Injection',
  policyType: 'injection_scan',
  message: 'blocked',
  enforcementMode: 'block',
};

describe('ToolIntegrityError', () => {
  it('extends PolicyBlockedError and filters tool_integrity violations', () => {
    const err = new ToolIntegrityError([toolViolation, plainViolation]);
    expect(err).toBeInstanceOf(PolicyBlockedError);
    expect(err.name).toBe('ToolIntegrityError');
    expect(err.toolViolations).toHaveLength(1);
    expect(err.toolViolations[0].policyType).toBe('tool_integrity');
  });
});

describe('policyBlockedErrorFromViolations', () => {
  it('returns ValidatorDeniedError when a custom_validator violation is present', () => {
    const err = policyBlockedErrorFromViolations([toolViolation, validatorViolation]);
    expect(err).toBeInstanceOf(ValidatorDeniedError);
  });

  it('returns ToolIntegrityError when only a tool_integrity violation is present', () => {
    const err = policyBlockedErrorFromViolations([toolViolation]);
    expect(err).toBeInstanceOf(ToolIntegrityError);
  });

  it('returns a plain PolicyBlockedError otherwise', () => {
    const err = policyBlockedErrorFromViolations([plainViolation]);
    expect(err).toBeInstanceOf(PolicyBlockedError);
    expect(err).not.toBeInstanceOf(ToolIntegrityError);
    expect(err).not.toBeInstanceOf(ValidatorDeniedError);
  });
});
