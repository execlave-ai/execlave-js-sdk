/**
 * High-level event helpers used by framework adapters (mirror of the
 * Python events module).
 *
 * Helpers run `exe.enforcePolicy(...)` pre-execution and open a span
 * under the current span stack. Policy-block errors re-raise;
 * transient enforcement errors are swallowed with a console.warn.
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
  SPAN_KIND_LLM,
  SPAN_KIND_RETRIEVER,
  SPAN_KIND_TOOL,
  getSpanTree,
} from './spans';

function isEnforcementError(err: unknown): boolean {
  return (
    err instanceof PolicyBlockedError ||
    err instanceof PolicyDeniedError ||
    err instanceof ApprovalTimeoutError ||
    err instanceof EnforcementUnavailableError ||
    err instanceof AgentPausedError
  );
}

async function maybeEnforce(
  exe: Execlave,
  opts: {
    agentId?: string;
    input?: string;
    tools?: string[];
    metadata?: Record<string, unknown>;
    estimatedCost?: number;
  },
): Promise<unknown | null> {
  if (!opts.agentId || opts.input == null) return null;
  try {
    return await exe.enforcePolicy({
      agentId: opts.agentId,
      input: opts.input,
      tools: opts.tools,
      metadata: opts.metadata,
      estimatedCost: opts.estimatedCost,
    });
  } catch (err) {
    if (isEnforcementError(err)) throw err;
    // eslint-disable-next-line no-console
    console.warn('[execlave] enforcePolicy failed (non-fatal):', err);
    return null;
  }
}

function summariseDecision(decision: any): Record<string, unknown> {
  if (!decision || typeof decision !== 'object') return {};
  const out: Record<string, unknown> = {};
  for (const k of ['allowed', 'mode', 'source', 'warnings', 'requiresApproval']) {
    if (k in decision) out[k] = decision[k];
  }
  return out;
}

export async function recordLlmCall<T>(
  exe: Execlave,
  opts: {
    agentId?: string;
    model?: string;
    input?: string;
    metadata?: Record<string, unknown>;
    estimatedCost?: number;
  },
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  const decision = await maybeEnforce(exe, opts);
  const tree = getSpanTree(exe);
  const span = tree.start({
    kind: SPAN_KIND_LLM,
    name: opts.model ?? 'llm',
    agentId: opts.agentId,
  });
  if (opts.input != null) span.setInput(opts.input);
  if (opts.model) span.setModel(opts.model);
  if (decision) span.addMetadata({ enforcement: summariseDecision(decision) });

  try {
    const result = await fn(span);
    span.finish('success');
    return result;
  } catch (err) {
    const e = err as Error;
    span.finish('error', e?.message, e?.name);
    throw err;
  }
}

export async function recordToolCall<T>(
  exe: Execlave,
  opts: {
    agentId?: string;
    toolName: string;
    input?: string;
    metadata?: Record<string, unknown>;
  },
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  const decision = await maybeEnforce(exe, {
    agentId: opts.agentId,
    input: opts.input ?? `tool:${opts.toolName}`,
    tools: [opts.toolName],
    metadata: { ...(opts.metadata ?? {}), toolName: opts.toolName },
  });
  const tree = getSpanTree(exe);
  const span = tree.start({
    kind: SPAN_KIND_TOOL,
    name: opts.toolName,
    agentId: opts.agentId,
  });
  if (opts.input != null) span.setInput(opts.input);
  span.addMetadata({ toolName: opts.toolName });
  if (decision) span.addMetadata({ enforcement: summariseDecision(decision) });

  try {
    const result = await fn(span);
    span.finish('success');
    return result;
  } catch (err) {
    const e = err as Error;
    span.finish('error', e?.message, e?.name);
    throw err;
  }
}

export function recordAgentAction(
  exe: Execlave,
  opts: {
    agentId?: string;
    action: string;
    metadata?: Record<string, unknown>;
  },
): Span {
  const tree = getSpanTree(exe);
  return tree.start({
    kind: SPAN_KIND_AGENT,
    name: opts.action,
    agentId: opts.agentId,
    metadata: opts.metadata,
  });
}

export async function recordRetrieval<T>(
  exe: Execlave,
  opts: {
    agentId?: string;
    query: string;
    retrieverName?: string;
    metadata?: Record<string, unknown>;
  },
  fn: (span: Span) => Promise<T>,
): Promise<T> {
  const tree = getSpanTree(exe);
  const span = tree.start({
    kind: SPAN_KIND_RETRIEVER,
    name: opts.retrieverName ?? 'retriever',
    agentId: opts.agentId,
    metadata: opts.metadata,
  });
  span.setInput(opts.query);
  try {
    const result = await fn(span);
    span.finish('success');
    return result;
  } catch (err) {
    const e = err as Error;
    span.finish('error', e?.message, e?.name);
    throw err;
  }
}
