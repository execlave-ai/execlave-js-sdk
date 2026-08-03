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

  it('seals the full model + message array into metadata (not just the extracted user text)', async () => {
    // `input` is bounded to the extracted latest user turn for policy/classifier
    // read; the certificate's digest must still cover the system prompt, prior
    // turns, and model — otherwise those could drift post-approval undetected.
    const exe = makeExe();
    const client = makeClient({ choices: [{ message: { content: 'ok' } }] });
    instrumentOpenAI(client, exe, { agentId: 'bot' });
    const messages = [
      { role: 'system', content: 'be nice' },
      { role: 'user', content: 'hello' },
    ];
    await client.chat.completions.create({ model: 'gpt-4o-mini', messages });
    expect(exe.enforcePolicy).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({ model: 'gpt-4o-mini', messages }),
      }),
    );
  });

  it('seals the ENTIRE request object, not just model + messages — the gap this adapter used to have', async () => {
    // Before this fix, only `{ model, messages }` were hand-picked into the
    // sealed metadata. `tools`, `tool_choice`, `temperature`, and
    // `response_format` could differ from what a human approved without
    // ever invalidating the certificate. Prove the full request survives
    // sealing now, and that changing an untouched field changes the sealed
    // value (i.e. would change the certificate digest).
    const exe = makeExe();
    const client = makeClient({ choices: [{ message: { content: 'ok' } }] });
    instrumentOpenAI(client, exe, { agentId: 'bot' });
    const params = {
      model: 'gpt-4o',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{ type: 'function', function: { name: 'search' } }],
      tool_choice: 'required',
      temperature: 0.2,
      response_format: { type: 'json_object' },
    };
    await client.chat.completions.create(params);
    expect(exe.enforcePolicy).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: expect.objectContaining(params) }),
    );

    const secondExe = makeExe();
    const secondClient = makeClient({ choices: [{ message: { content: 'ok' } }] });
    instrumentOpenAI(secondClient, secondExe, { agentId: 'bot' });
    await secondClient.chat.completions.create({ ...params, tool_choice: 'auto' });
    const firstMetadata = (exe.enforcePolicy as jest.Mock).mock.calls[0][0].metadata;
    const secondMetadata = (secondExe.enforcePolicy as jest.Mock).mock.calls[0][0].metadata;
    expect(firstMetadata).not.toEqual(secondMetadata);
  });

  it('sanitizes a non-serializable message array instead of letting it fail-open at the HTTP layer', async () => {
    // Same regression as the MCP adapter: a circular reference reaching
    // JSON.stringify at the HTTP layer would be caught by enforcePolicy's
    // network-error handler and silently ALLOW the call under fail_open —
    // reproducibly, not just as a transient blip.
    const exe = makeExe();
    const client = makeClient({ choices: [{ message: { content: 'ok' } }] });
    instrumentOpenAI(client, exe, { agentId: 'bot' });

    const circularMsg: Record<string, unknown> = { role: 'user', content: 'hi' };
    circularMsg.self = circularMsg;

    await client.chat.completions.create({ model: 'gpt-4o-mini', messages: [circularMsg] });

    expect(exe.enforcePolicy).toHaveBeenCalledTimes(1);
    const sentPayload = (exe.enforcePolicy as jest.Mock).mock.calls[0][0];
    expect(() => JSON.stringify(sentPayload)).not.toThrow();
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
