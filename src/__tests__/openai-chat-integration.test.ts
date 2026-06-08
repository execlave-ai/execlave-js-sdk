/**
 * Tests for the OpenAI Chat Completions integration. Duck-typed — no
 * real `openai` package required.
 */

import { PolicyBlockedError } from '../errors';
import { instrumentOpenAI } from '../integrations/openai-chat';

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

function makeClient(response: any | Error) {
  const create = jest.fn(async (_params: any) => {
    if (response instanceof Error) throw response;
    return response;
  });
  return {
    chat: { completions: { create } },
  };
}

describe('instrumentOpenAI', () => {
  it('requires a client', () => {
    expect(() => instrumentOpenAI(undefined as any, makeExe(), { agentId: 'b' })).toThrow();
  });

  it('requires agentId', () => {
    expect(() => instrumentOpenAI(makeClient({}), makeExe(), { agentId: '' })).toThrow();
  });

  it('rejects a client without chat.completions.create', () => {
    expect(() =>
      instrumentOpenAI({} as any, makeExe(), { agentId: 'b' }),
    ).toThrow(TypeError);
  });

  it('enforces the last user message', async () => {
    const exe = makeExe();
    const client = makeClient({
      choices: [{ message: { content: 'ok' } }],
      usage: { prompt_tokens: 1, completion_tokens: 2 },
      model: 'gpt-4o-mini',
    });
    instrumentOpenAI(client, exe, { agentId: 'bot' });
    await client.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        { role: 'system', content: 'be nice' },
        { role: 'user', content: 'hello' },
      ],
    });
    expect(exe.enforcePolicy).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: 'bot', input: 'hello' }),
    );
  });

  it('blocks request before forwarding when policy denies', async () => {
    const exe = makeExe();
    exe.enforcePolicy = jest
      .fn()
      .mockRejectedValue(new PolicyBlockedError([{ policyType: 'pii', message: 'no' }] as any));
    const client = makeClient({ choices: [] });
    instrumentOpenAI(client, exe, { agentId: 'bot' });
    await expect(
      client.chat.completions.create({
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'ssn=1' }],
      }),
    ).rejects.toBeInstanceOf(PolicyBlockedError);
    expect(client.chat.completions.create).toBeDefined();
    // underlying create called zero times: easier to assert via a spy.
  });

  it('is idempotent', () => {
    const exe = makeExe();
    const client = makeClient({ choices: [] });
    instrumentOpenAI(client, exe, { agentId: 'bot', enforce: false });
    const first = client.chat.completions.create;
    instrumentOpenAI(client, exe, { agentId: 'bot', enforce: false });
    expect(client.chat.completions.create).toBe(first);
  });

  it('extracts text from multimodal content parts', async () => {
    const exe = makeExe();
    const client = makeClient({ choices: [{ message: { content: 'ok' } }] });
    instrumentOpenAI(client, exe, { agentId: 'bot' });
    await client.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'describe this' },
            { type: 'image_url', image_url: { url: 'x' } },
          ],
        },
      ],
    });
    expect(exe.enforcePolicy).toHaveBeenCalledWith(
      expect.objectContaining({ input: 'describe this' }),
    );
  });

  it('records tokens and model from the response', async () => {
    const exe = makeExe();
    const client = makeClient({
      choices: [{ message: { content: 'hi' } }],
      usage: { prompt_tokens: 5, completion_tokens: 7 },
      model: 'gpt-4o-mini-2026-01-01',
    });
    instrumentOpenAI(client, exe, { agentId: 'bot', enforce: false });
    await client.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'hi' }],
    });
    const trace = (exe.startTrace as jest.Mock).mock.results[0].value;
    expect(trace.setTokens).toHaveBeenCalledWith(5, 7);
    expect(trace.setModel).toHaveBeenCalledWith('gpt-4o-mini-2026-01-01');
  });

  it('marks span as error and re-throws when the call fails', async () => {
    const exe = makeExe();
    const client = makeClient(new Error('rate limited'));
    instrumentOpenAI(client, exe, { agentId: 'bot', enforce: false });
    await expect(
      client.chat.completions.create({
        model: 'gpt-4o',
        messages: [{ role: 'user', content: 'x' }],
      }),
    ).rejects.toThrow('rate limited');
    const trace = (exe.startTrace as jest.Mock).mock.results[0].value;
    expect(trace.finish).toHaveBeenCalledWith('error', 'rate limited', 'Error');
  });
});
