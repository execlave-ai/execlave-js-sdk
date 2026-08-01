/**
 * Tests for the CrewAI integration.
 *
 * Scoped to the enforcement input/metadata behavior fixed for the
 * truncation/omission pattern; there is no existing broader adapter test
 * suite for crewai.ts to extend.
 */

import { instrumentCrew } from '../integrations/crewai';

function makeExe() {
  const baseTrace = {
    setInput: jest.fn().mockReturnThis(),
    setOutput: jest.fn().mockReturnThis(),
    finish: jest.fn(),
  };
  return {
    enforcePolicy: jest.fn().mockResolvedValue({ allowed: true }),
    startTrace: jest.fn((opts: any) => ({
      ...baseTrace,
      traceId: opts?.traceId ?? `tr_${Math.random()}`,
    })),
  } as any;
}

describe('instrumentCrew', () => {
  it('requires a crew', () => {
    expect(() => instrumentCrew(null as any, makeExe(), { agentId: 'bot' })).toThrow();
  });

  it('requires an agentId', () => {
    expect(() => instrumentCrew({} as any, makeExe(), { agentId: '' })).toThrow();
  });

  it('enforces on a tool step', async () => {
    const exe = makeExe();
    const crew: any = {};
    instrumentCrew(crew, exe, { agentId: 'bot' });
    await crew.stepCallback({ tool: 'search', toolInput: { q: 'x' } });
    expect(exe.enforcePolicy).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: 'bot', tools: ['search'] }),
    );
  });

  it('seals the full untruncated tool input into metadata', async () => {
    // `input` (safeStr) truncates at 4000 chars for policy/classifier read.
    // The certificate's digest must cover the WHOLE sealed action context —
    // metadata is never truncated.
    const exe = makeExe();
    const crew: any = {};
    instrumentCrew(crew, exe, { agentId: 'bot' });
    const bigInput = { q: 'x'.repeat(5000) };
    await crew.stepCallback({ tool: 'search', toolInput: bigInput });
    expect(exe.enforcePolicy).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: { toolInput: bigInput } }),
    );
  });

  it('sanitizes non-serializable tool input instead of letting it fail-open at the HTTP layer', async () => {
    // A raw circular tool input reaching JSON.stringify at the HTTP layer
    // would be caught by enforcePolicy's network-error handler and silently
    // ALLOW the call under fail_open — reproducibly, not just transiently.
    const exe = makeExe();
    const crew: any = {};
    instrumentCrew(crew, exe, { agentId: 'bot' });
    const circular: Record<string, unknown> = { cmd: 'wire_funds' };
    circular.self = circular;
    await crew.stepCallback({ tool: 'wire_funds', toolInput: circular });
    expect(exe.enforcePolicy).toHaveBeenCalledTimes(1);
    const sentPayload = (exe.enforcePolicy as jest.Mock).mock.calls[0][0];
    expect(() => JSON.stringify(sentPayload)).not.toThrow();
    expect(sentPayload.metadata).toBeDefined();
  });

  it('is idempotent', () => {
    const exe = makeExe();
    const crew: any = {};
    instrumentCrew(crew, exe, { agentId: 'bot' });
    const first = crew.stepCallback;
    instrumentCrew(crew, exe, { agentId: 'bot' });
    expect(crew.stepCallback).toBe(first);
  });
});
