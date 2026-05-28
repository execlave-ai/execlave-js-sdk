/**
 * Tests for the LangChain integration callback handler.
 *
 * The JS handler does NOT extend a LangChain base class at compile
 * time (duck-typed), so no langchain-core mock is required.
 */

import { PolicyBlockedError } from '../errors';
import { ExeclaveCallbackHandler } from '../integrations/langchain';

function makeExe() {
  const baseTrace = {
    setInput: jest.fn().mockReturnThis(),
    setOutput: jest.fn().mockReturnThis(),
    setModel: jest.fn().mockReturnThis(),
    setTokens: jest.fn().mockReturnThis(),
    addMetadata: jest.fn().mockReturnThis(),
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

describe('ExeclaveCallbackHandler', () => {
  it('requires an Execlave client', () => {
    expect(
      () => new ExeclaveCallbackHandler(undefined as any, { agentId: 'bot' }),
    ).toThrow();
  });

  it('requires an agentId', () => {
    expect(
      () => new ExeclaveCallbackHandler(makeExe(), { agentId: '' }),
    ).toThrow();
  });

  it('enforces only on top-level chain start', async () => {
    const exe = makeExe();
    const h = new ExeclaveCallbackHandler(exe, { agentId: 'bot' });
    await h.handleChainStart({ name: 'root' }, { input: 'hello' }, 'r1');
    await h.handleChainStart({ name: 'sub' }, { input: 'nested' }, 'r2', 'r1');
    expect(exe.enforcePolicy).toHaveBeenCalledTimes(1);
    expect(exe.enforcePolicy).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: 'bot', input: 'hello' }),
    );
  });

  it('propagates PolicyBlockedError from chain start', async () => {
    const exe = makeExe();
    exe.enforcePolicy = jest.fn().mockRejectedValue(
      new PolicyBlockedError([{ policyType: 'pii', message: 'no' }] as any),
    );
    const h = new ExeclaveCallbackHandler(exe, { agentId: 'bot' });
    await expect(
      h.handleChainStart({ name: 'c' }, { input: 'secret' }, 'r'),
    ).rejects.toBeInstanceOf(PolicyBlockedError);
  });

  it('enforces with tool allowlist on tool start', async () => {
    const exe = makeExe();
    const h = new ExeclaveCallbackHandler(exe, { agentId: 'bot' });
    await h.handleToolStart({ name: 'web_search' }, 'q=x', 'tool-1');
    expect(exe.enforcePolicy).toHaveBeenCalledWith(
      expect.objectContaining({ tools: ['web_search'] }),
    );
  });

  it('halts execution when tool is blocked', async () => {
    const exe = makeExe();
    exe.enforcePolicy = jest.fn().mockRejectedValue(
      new PolicyBlockedError([{ policyType: 'tool', message: 'no' }] as any),
    );
    const h = new ExeclaveCallbackHandler(exe, { agentId: 'bot' });
    await expect(
      h.handleToolStart({ name: 'rm_rf' }, '/', 'tool-1'),
    ).rejects.toBeInstanceOf(PolicyBlockedError);
  });

  it('cleans up span map on chain end', async () => {
    const exe = makeExe();
    const h = new ExeclaveCallbackHandler(exe, { agentId: 'bot', enforce: false });
    await h.handleChainStart({ name: 'c' }, { input: 'x' }, 'r');
    expect((h as any)._spans.has('r')).toBe(true);
    await h.handleChainEnd({ output: 'ok' }, 'r');
    expect((h as any)._spans.has('r')).toBe(false);
  });

  it('does not store page_content in retriever metadata', async () => {
    const exe = makeExe();
    const h = new ExeclaveCallbackHandler(exe, { agentId: 'bot', enforce: false });
    await h.handleRetrieverStart({ name: 'r' }, 'query', 'rt-1');
    const span = (h as any)._spans.get('rt-1');
    const addMetadata = span._trace.addMetadata as jest.Mock;
    await h.handleRetrieverEnd(
      [
        { metadata: { id: 'd1' }, pageContent: 'SECRET-DATA-123' },
        { metadata: { source: 'd2.md' }, pageContent: 'abc' },
      ] as any,
      'rt-1',
    );
    // Check no call to addMetadata contains the literal "SECRET-DATA-123".
    for (const call of addMetadata.mock.calls) {
      expect(JSON.stringify(call)).not.toContain('SECRET-DATA-123');
    }
  });
});
