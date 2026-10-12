import type { Execlave } from './client';

export interface OpenAIChatConnectorRequest {
  agentId: string;
  input: string;
  model: string;
  messages: Array<{ role: string; content: string }>;
  metadata?: Record<string, unknown>;
  tools?: string[];
  estimatedCost?: number;
}

export interface OpenAIChatConnectorClient {
  chat: {
    completions: {
      create: (payload: Record<string, unknown>) => Promise<any>;
    };
  };
}

export interface LangChainConnectorRequest {
  agentId: string;
  input: string;
  metadata?: Record<string, unknown>;
  tools?: string[];
  estimatedCost?: number;
}

export interface LangChainRunnable {
  invoke: (input: unknown, config?: Record<string, unknown>) => Promise<unknown>;
}

/**
 * Execute an OpenAI chat completion with Execlave enforcement + tracing.
 */
export async function runOpenAIChat(
  exe: Execlave,
  openai: OpenAIChatConnectorClient,
  req: OpenAIChatConnectorRequest,
): Promise<any> {
  await exe.enforcePolicy({
    agentId: req.agentId,
    input: req.input,
    metadata: req.metadata,
    tools: req.tools,
    estimatedCost: req.estimatedCost,
  });

  const trace = exe.startTrace({
    agentId: req.agentId,
    metadata: { connector: 'openai', ...req.metadata },
  });
  trace.setInput(req.messages);
  trace.setModel(req.model);

  try {
    const response = await openai.chat.completions.create({
      model: req.model,
      messages: req.messages,
    });

    const usage = response?.usage;
    if (usage && typeof usage.prompt_tokens === 'number' && typeof usage.completion_tokens === 'number') {
      trace.setTokens(usage.prompt_tokens, usage.completion_tokens);
    }

    trace.setOutput(response);
    trace.finish('success');
    return response;
  } catch (error) {
    trace.finish('error', (error as Error).message, (error as Error).name);
    throw error;
  }
}

/**
 * Execute a LangChain runnable with Execlave enforcement + tracing.
 */
export async function runLangChain(
  exe: Execlave,
  runnable: LangChainRunnable,
  req: LangChainConnectorRequest,
): Promise<unknown> {
  await exe.enforcePolicy({
    agentId: req.agentId,
    input: req.input,
    metadata: req.metadata,
    tools: req.tools,
    estimatedCost: req.estimatedCost,
  });

  const trace = exe.startTrace({
    agentId: req.agentId,
    metadata: { connector: 'langchain', ...req.metadata },
  });
  trace.setInput(req.input);

  try {
    const response = await runnable.invoke(req.input);
    trace.setOutput(response);
    trace.finish('success');
    return response;
  } catch (error) {
    trace.finish('error', (error as Error).message, (error as Error).name);
    throw error;
  }
}
