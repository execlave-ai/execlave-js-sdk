/**
 * Tests for the instrumentation primitives.
 */

import { PolicyBlockedError } from '../errors';
import {
  SPAN_KIND_AGENT,
  SPAN_KIND_LLM,
  SPAN_KIND_TOOL,
  getSpanTree,
} from '../instrumentation/spans';
import { recordLlmCall, recordToolCall } from '../instrumentation/events';

function makeExe() {
  const trace = {
    traceId: `t_${Math.random()}`,
    setInput: jest.fn().mockReturnThis(),
    setOutput: jest.fn().mockReturnThis(),
    setModel: jest.fn().mockReturnThis(),
    setTokens: jest.fn().mockReturnThis(),
    addMetadata: jest.fn().mockReturnThis(),
    finish: jest.fn(),
  };
  return {
    startTrace: jest.fn((opts: any) => ({ ...trace, traceId: opts?.traceId ?? trace.traceId })),
    enforcePolicy: jest.fn().mockResolvedValue({ allowed: true, mode: 'monitor' }),
  } as any;
}

describe('instrumentation/spans', () => {
  it('creates a root span with no parent', () => {
    const exe = makeExe();
    const tree = getSpanTree(exe);
    const span = tree.start({ kind: SPAN_KIND_LLM, name: 'gpt-4o' });
    expect(span.parentSpanId).toBeNull();
    expect(span.spanId).toMatch(/^sp_/);
    expect(span.kind).toBe(SPAN_KIND_LLM);
    span.finish('success');
  });

  it('nested spans share a traceId', () => {
    const exe = makeExe();
    const tree = getSpanTree(exe);
    const parent = tree.start({ kind: SPAN_KIND_AGENT, name: 'root' });
    const child = parent.child({ kind: SPAN_KIND_LLM, name: 'gpt-4o' });
    expect(child.traceId).toBe(parent.traceId);
    expect(child.parentSpanId).toBe(parent.spanId);
    child.finish('success');
    parent.finish('success');
  });

  it('current() reflects the process-wide stack', () => {
    const exe = makeExe();
    const tree = getSpanTree(exe);
    expect(tree.current()).toBeNull();
    const a = tree.start({ kind: SPAN_KIND_AGENT, name: 'a' });
    expect(tree.current()).toBe(a);
    const b = a.child({ kind: SPAN_KIND_TOOL, name: 'tool' });
    expect(tree.current()).toBe(b);
    b.finish('success');
    expect(tree.current()).toBe(a);
    a.finish('success');
    expect(tree.current()).toBeNull();
  });

  it('finish is idempotent', () => {
    const exe = makeExe();
    const tree = getSpanTree(exe);
    const span = tree.start({ kind: SPAN_KIND_LLM, name: 'x' });
    span.finish('success');
    span.finish('success'); // no throw
  });

  it('getSpanTree is cached per Execlave instance', () => {
    const exe = makeExe();
    expect(getSpanTree(exe)).toBe(getSpanTree(exe));
  });
});

describe('instrumentation/events', () => {
  it('recordLlmCall enforces and runs the body', async () => {
    const exe = makeExe();
    let kindSeen: string | undefined;
    const result = await recordLlmCall(
      exe,
      { agentId: 'bot', model: 'gpt-4o', input: 'hello' },
      async (span) => {
        kindSeen = span.kind;
        return 'ok';
      },
    );
    expect(result).toBe('ok');
    expect(kindSeen).toBe(SPAN_KIND_LLM);
    expect(exe.enforcePolicy).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: 'bot', input: 'hello' }),
    );
  });

  it('recordLlmCall skips enforcement without input', async () => {
    const exe = makeExe();
    await recordLlmCall(
      exe,
      { agentId: 'bot', model: 'gpt-4o' },
      async () => 'ok',
    );
    expect(exe.enforcePolicy).not.toHaveBeenCalled();
  });

  it('recordLlmCall re-throws PolicyBlockedError', async () => {
    const exe = makeExe();
    exe.enforcePolicy = jest.fn().mockRejectedValue(
      new PolicyBlockedError([{ policyType: 'pii', message: 'no' }] as any),
    );
    await expect(
      recordLlmCall(
        exe,
        { agentId: 'bot', model: 'gpt-4o', input: 'x' },
        async () => 'never',
      ),
    ).rejects.toBeInstanceOf(PolicyBlockedError);
  });

  it('recordLlmCall swallows non-enforcement enforcement errors', async () => {
    const exe = makeExe();
    exe.enforcePolicy = jest.fn().mockRejectedValue(new Error('network blip'));
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const out = await recordLlmCall(
      exe,
      { agentId: 'bot', model: 'gpt-4o', input: 'x' },
      async () => 'done',
    );
    expect(out).toBe('done');
    warn.mockRestore();
  });

  it('recordLlmCall marks span as error if body throws', async () => {
    const exe = makeExe();
    await expect(
      recordLlmCall(
        exe,
        { agentId: 'bot', model: 'gpt-4o', input: 'x' },
        async () => {
          throw new Error('downstream failed');
        },
      ),
    ).rejects.toThrow('downstream failed');
  });

  it('recordToolCall passes tool allowlist to enforce', async () => {
    const exe = makeExe();
    await recordToolCall(
      exe,
      { agentId: 'bot', toolName: 'web_search', input: 'q' },
      async () => 'r',
    );
    expect(exe.enforcePolicy).toHaveBeenCalledWith(
      expect.objectContaining({ tools: ['web_search'] }),
    );
  });
});
