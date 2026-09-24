/**
 * Tests for the OpenAI Agents SDK integration.
 *
 * Scoped to the enforcement input/metadata behavior fixed for the
 * truncation/omission pattern; there is no existing broader adapter test
 * suite for openai-agents.ts to extend.
 */

import { ExeclaveTracingProcessor } from '../integrations/openai-agents';

function makeExe() {
  const baseTrace = {
    setInput: jest.fn().mockReturnThis(),
    setOutput: jest.fn().mockReturnThis(),
    setModel: jest.fn().mockReturnThis(),
    setTokens: jest.fn().mockReturnThis(),
    finish: jest.fn(),
  };
  return {
    enforcePolicy: jest.fn().mockResolvedValue({ allowed: true }),
    startTrace: jest.fn((opts: any) => ({
      ...baseTrace,
      traceId: opts?.traceId ?? `tr_${Math.random()}`,
      addMetadata: jest.fn().mockReturnThis(),
    })),
  } as any;
}

class FunctionSpanData {
  constructor(public input: unknown) {}
}

describe('ExeclaveTracingProcessor', () => {
  it('requires an Execlave client', () => {
    expect(() => new ExeclaveTracingProcessor(undefined as any, { agentId: 'bot' })).toThrow();
  });

  it('requires an agentId', () => {
    expect(() => new ExeclaveTracingProcessor(makeExe(), { agentId: '' })).toThrow();
  });

  it('enforces on a function (tool) span start', async () => {
    const exe = makeExe();
    const p = new ExeclaveTracingProcessor(exe, { agentId: 'bot' });
    await p.onSpanStart({ spanId: 's1', spanData: new FunctionSpanData({ q: 'x' }) });
    expect(exe.enforcePolicy).toHaveBeenCalledWith(expect.objectContaining({ agentId: 'bot' }));
  });

  it('seals the full untruncated tool args into metadata', async () => {
    // `input` (safeStr) truncates at 4000 chars for policy/classifier read.
    // The certificate's digest must cover the WHOLE sealed action context —
    // metadata is never truncated.
    const exe = makeExe();
    const p = new ExeclaveTracingProcessor(exe, { agentId: 'bot' });
    const bigArgs = { q: 'x'.repeat(5000) };
    await p.onSpanStart({ spanId: 's2', spanData: new FunctionSpanData(bigArgs) });
    expect(exe.enforcePolicy).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: { toolArguments: bigArgs } }),
    );
  });

  it('sanitizes non-serializable tool args instead of letting them fail-open at the HTTP layer', async () => {
    const exe = makeExe();
    const p = new ExeclaveTracingProcessor(exe, { agentId: 'bot' });
    const circular: Record<string, unknown> = { cmd: 'wire_funds' };
    circular.self = circular;
    await p.onSpanStart({ spanId: 's3', spanData: new FunctionSpanData(circular) });
    expect(exe.enforcePolicy).toHaveBeenCalledTimes(1);
    const sentPayload = (exe.enforcePolicy as jest.Mock).mock.calls[0][0];
    expect(() => JSON.stringify(sentPayload)).not.toThrow();
  });
});
