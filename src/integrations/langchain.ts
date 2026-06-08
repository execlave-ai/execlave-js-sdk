/**
 * LangChain JS auto-instrumentation.
 *
 * Usage:
 *
 * ```ts
 * import { Execlave } from '@execlave/sdk';
 * import { ExeclaveCallbackHandler } from '@execlave/sdk/integrations/langchain';
 *
 * const exe = new Execlave({ apiKey: '...' });
 * const handler = new ExeclaveCallbackHandler(exe, { agentId: 'my-bot' });
 * await chain.invoke({ q }, { callbacks: [handler] });
 * ```
 *
 * Uses LangChain's `BaseCallbackHandler` (soft-imported so
 * `@execlave/sdk` has no compile-time dependency on langchain).
 * Consumers must install `@langchain/core` >= 0.3 themselves.
 *
 * Only TypeScript types are duck-typed here; at runtime the handler
 * implements the method names LangChain expects.
 */

import type { Execlave } from '../client';
import {
  PolicyBlockedError,
  PolicyDeniedError,
  ApprovalTimeoutError,
  EnforcementUnavailableError,
  AgentPausedError,
} from '../errors';
import {
  Span,
  SPAN_KIND_AGENT,
  SPAN_KIND_CHAIN,
  SPAN_KIND_LLM,
  SPAN_KIND_RETRIEVER,
  SPAN_KIND_TOOL,
  getSpanTree,
} from '../instrumentation/spans';

function isEnforcementError(err: unknown): boolean {
  return (
    err instanceof PolicyBlockedError ||
    err instanceof PolicyDeniedError ||
    err instanceof ApprovalTimeoutError ||
    err instanceof EnforcementUnavailableError ||
    err instanceof AgentPausedError
  );
}

export interface ExeclaveCallbackHandlerOptions {
  /** Agent id registered with Execlave. Required for enforcement. */
  agentId: string;
  /** Run `enforcePolicy` on chain/tool starts. Default true. */
  enforce?: boolean;
  sessionId?: string;
  userId?: string;
}

/**
 * LangChain callback handler that streams into Execlave.
 *
 * This class does not `extends BaseCallbackHandler` at compile time —
 * we duck-type the interface so the SDK package does not require
 * `@langchain/core` to be installed. When registered with
 * `config.callbacks`, LangChain invokes matching methods by name.
 */
export class ExeclaveCallbackHandler {
  // LangChain inspects these. `name` is used for trace metadata.
  readonly name = 'ExeclaveCallbackHandler';
  readonly raiseError = true;
  readonly awaitHandlers = true;

  private _exe: Execlave;
  private _agentId: string;
  private _enforce: boolean;
  private _sessionId?: string;
  private _userId?: string;
  private _tree: ReturnType<typeof getSpanTree>;
  private _spans = new Map<string, Span>();

  constructor(exe: Execlave, opts: ExeclaveCallbackHandlerOptions) {
    if (!exe) throw new Error('ExeclaveCallbackHandler requires an Execlave client');
    if (!opts?.agentId) throw new Error('ExeclaveCallbackHandler requires agentId');
    this._exe = exe;
    this._agentId = opts.agentId;
    this._enforce = opts.enforce !== false;
    this._sessionId = opts.sessionId;
    this._userId = opts.userId;
    this._tree = getSpanTree(exe);
  }

  // --------------------------------------------------------------
  // Helpers
  // --------------------------------------------------------------
  private _open(
    runId: string,
    parentRunId: string | undefined,
    kind: Parameters<typeof this._tree.start>[0]['kind'],
    name: string,
    input?: unknown,
    metadata?: Record<string, unknown>,
  ): Span {
    const parent = parentRunId ? this._spans.get(parentRunId) : null;
    const span = this._tree.start({
      kind,
      name,
      parent,
      agentId: this._agentId,
      sessionId: this._sessionId,
      userId: this._userId,
      metadata,
    });
    if (input !== undefined) span.setInput(input);
    this._spans.set(runId, span);
    return span;
  }

  private _close(
    runId: string,
    output: unknown,
    status: 'success' | 'error' = 'success',
    errorMessage?: string,
    errorType?: string,
  ): void {
    const span = this._spans.get(runId);
    if (!span) return;
    this._spans.delete(runId);
    if (output !== undefined) {
      try {
        span.setOutput(output);
      } catch {
        /* noop */
      }
    }
    span.finish(status, errorMessage, errorType);
  }

  private async _enforceCall(input: string, tools?: string[]): Promise<void> {
    if (!this._enforce) return;
    try {
      await this._exe.enforcePolicy({
        agentId: this._agentId,
        input,
        tools,
      });
    } catch (err) {
      if (isEnforcementError(err)) throw err;
      // eslint-disable-next-line no-console
      console.warn('[execlave] enforcePolicy failed (non-fatal):', err);
    }
  }

  // --------------------------------------------------------------
  // Chain callbacks
  // --------------------------------------------------------------
  async handleChainStart(
    chain: { name?: string; id?: string[] } | undefined,
    inputs: Record<string, unknown>,
    runId: string,
    parentRunId?: string,
  ): Promise<void> {
    const name = chain?.name ?? chain?.id?.[chain.id.length - 1] ?? 'chain';
    if (!parentRunId) {
      const inputText = extractInputText(inputs);
      if (inputText) await this._enforceCall(inputText);
    }
    this._open(runId, parentRunId, SPAN_KIND_CHAIN, name, inputs);
  }

  async handleChainEnd(outputs: unknown, runId: string): Promise<void> {
    this._close(runId, outputs, 'success');
  }

  async handleChainError(error: Error, runId: string): Promise<void> {
    this._close(runId, undefined, 'error', error?.message, error?.name);
  }

  // --------------------------------------------------------------
  // LLM callbacks
  // --------------------------------------------------------------
  async handleLLMStart(
    llm: { name?: string; id?: string[] } | undefined,
    prompts: string[],
    runId: string,
    parentRunId?: string,
    extraParams?: Record<string, unknown>,
  ): Promise<void> {
    const name = llm?.name ?? llm?.id?.[llm.id.length - 1] ?? 'llm';
    const span = this._open(runId, parentRunId, SPAN_KIND_LLM, name, prompts);
    const invocation = (extraParams?.invocation_params ?? {}) as Record<string, unknown>;
    const model = (invocation.model ?? invocation.model_name) as string | undefined;
    if (model) span.setModel(model);
  }

  async handleChatModelStart(
    llm: { name?: string; id?: string[] } | undefined,
    messages: unknown[],
    runId: string,
    parentRunId?: string,
    extraParams?: Record<string, unknown>,
  ): Promise<void> {
    const name = llm?.name ?? llm?.id?.[llm.id.length - 1] ?? 'chat_model';
    const span = this._open(runId, parentRunId, SPAN_KIND_LLM, name, messages);
    const invocation = (extraParams?.invocation_params ?? {}) as Record<string, unknown>;
    const model = (invocation.model ?? invocation.model_name) as string | undefined;
    if (model) span.setModel(model);
  }

  async handleLLMEnd(output: any, runId: string): Promise<void> {
    const span = this._spans.get(runId);
    if (span) {
      const usage = output?.llmOutput?.tokenUsage ?? output?.llmOutput?.usage;
      if (usage) {
        const p = usage.promptTokens ?? usage.prompt_tokens ?? usage.input_tokens;
        const c = usage.completionTokens ?? usage.completion_tokens ?? usage.output_tokens;
        if (typeof p === 'number' && typeof c === 'number') span.setTokens(p, c);
      }
      const texts: string[] = [];
      for (const batch of output?.generations ?? []) {
        for (const gen of batch ?? []) {
          if (typeof gen.text === 'string') texts.push(gen.text);
          else if (gen.message?.content) texts.push(String(gen.message.content));
        }
      }
      if (texts.length) span.setOutput(texts.length === 1 ? texts[0] : texts);
    }
    this._close(runId, undefined, 'success');
  }

  async handleLLMError(error: Error, runId: string): Promise<void> {
    this._close(runId, undefined, 'error', error?.message, error?.name);
  }

  // --------------------------------------------------------------
  // Tool callbacks
  // --------------------------------------------------------------
  async handleToolStart(
    tool: { name?: string; id?: string[] } | undefined,
    input: string,
    runId: string,
    parentRunId?: string,
  ): Promise<void> {
    const toolName = tool?.name ?? tool?.id?.[tool.id.length - 1] ?? 'tool';
    await this._enforceCall(input ?? `tool:${toolName}`, [toolName]);
    this._open(runId, parentRunId, SPAN_KIND_TOOL, toolName, input, { toolName });
  }

  async handleToolEnd(output: unknown, runId: string): Promise<void> {
    this._close(runId, output, 'success');
  }

  async handleToolError(error: Error, runId: string): Promise<void> {
    this._close(runId, undefined, 'error', error?.message, error?.name);
  }

  // --------------------------------------------------------------
  // Agent callbacks
  // --------------------------------------------------------------
  async handleAgentAction(action: { tool?: string; toolInput?: unknown }, runId: string, parentRunId?: string): Promise<void> {
    this._open(
      runId,
      parentRunId,
      SPAN_KIND_AGENT,
      String(action?.tool ?? 'agent_action'),
      action?.toolInput,
      { agentAction: String(action?.tool ?? 'agent_action') },
    );
  }

  async handleAgentEnd(action: { returnValues?: unknown; log?: unknown }, runId: string): Promise<void> {
    this._close(runId, action?.returnValues ?? action?.log, 'success');
  }

  // --------------------------------------------------------------
  // Retriever callbacks
  // --------------------------------------------------------------
  async handleRetrieverStart(
    retriever: { name?: string } | undefined,
    query: string,
    runId: string,
    parentRunId?: string,
  ): Promise<void> {
    const name = retriever?.name ?? 'retriever';
    this._open(runId, parentRunId, SPAN_KIND_RETRIEVER, name, query);
  }

  async handleRetrieverEnd(documents: any[], runId: string): Promise<void> {
    const span = this._spans.get(runId);
    if (span && Array.isArray(documents)) {
      span.addMetadata({
        retrievedDocs: documents.map((d) => ({
          id: d?.metadata?.id ?? d?.metadata?.source,
          length: typeof d?.pageContent === 'string' ? d.pageContent.length : 0,
        })),
      });
    }
    this._close(runId, undefined, 'success');
  }

  async handleRetrieverError(error: Error, runId: string): Promise<void> {
    this._close(runId, undefined, 'error', error?.message, error?.name);
  }
}

// ------------------------------------------------------------------
// Helpers
// ------------------------------------------------------------------
function extractInputText(inputs: Record<string, unknown>): string | null {
  if (!inputs || typeof inputs !== 'object') return null;
  for (const key of ['input', 'question', 'query', 'q', 'prompt', 'text']) {
    const v = (inputs as any)[key];
    if (typeof v === 'string' && v) return v;
  }
  const parts: string[] = [];
  for (const v of Object.values(inputs)) {
    if (typeof v === 'string') parts.push(v);
  }
  return parts.length ? parts.join(' ') : null;
}
