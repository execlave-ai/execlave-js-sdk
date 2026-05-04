import { runLangChain, runOpenAIChat } from '../connectors';

describe('connectors', () => {
  it('runOpenAIChat should enforce policy, trace, and return response', async () => {
    const trace = {
      setInput: jest.fn().mockReturnThis(),
      setModel: jest.fn().mockReturnThis(),
      setTokens: jest.fn().mockReturnThis(),
      setOutput: jest.fn().mockReturnThis(),
      finish: jest.fn(),
    };

    const ag: any = {
      enforcePolicy: jest.fn().mockResolvedValue({ allowed: true }),
      startTrace: jest.fn().mockReturnValue(trace),
    };

    const openai = {
      chat: {
        completions: {
          create: jest.fn().mockResolvedValue({
            id: 'chatcmpl_1',
            usage: { prompt_tokens: 10, completion_tokens: 22 },
            choices: [{ message: { content: 'hello' } }],
          }),
        },
      },
    };

    const response = await runOpenAIChat(ag, openai as any, {
      agentId: 'agent_1',
      input: 'hello',
      model: 'gpt-4o-mini',
      messages: [{ role: 'user', content: 'hello' }],
    });

    expect(ag.enforcePolicy).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: 'agent_1', input: 'hello' }),
    );
    expect(trace.setModel).toHaveBeenCalledWith('gpt-4o-mini');
    expect(trace.setTokens).toHaveBeenCalledWith(10, 22);
    expect(trace.finish).toHaveBeenCalledWith('success');
    expect(response.id).toBe('chatcmpl_1');
  });

  it('runLangChain should enforce policy, trace, and return output', async () => {
    const trace = {
      setInput: jest.fn().mockReturnThis(),
      setOutput: jest.fn().mockReturnThis(),
      finish: jest.fn(),
    };

    const ag: any = {
      enforcePolicy: jest.fn().mockResolvedValue({ allowed: true }),
      startTrace: jest.fn().mockReturnValue(trace),
    };

    const runnable = {
      invoke: jest.fn().mockResolvedValue('answer'),
    };

    const response = await runLangChain(ag, runnable, {
      agentId: 'agent_1',
      input: 'question',
    });

    expect(ag.enforcePolicy).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: 'agent_1', input: 'question' }),
    );
    expect(trace.finish).toHaveBeenCalledWith('success');
    expect(response).toBe('answer');
  });
});
