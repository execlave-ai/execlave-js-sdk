/**
 * Model Context Protocol (MCP) client auto-instrumentation.
 *
 * Wrap an `@modelcontextprotocol/sdk` `Client` so every `callTool` is
 * policy-enforced (tool allowlist) and recorded as a `tool` span.
 *
 * ```ts
 * import { Client } from '@modelcontextprotocol/sdk/client/index.js';
 * import { Execlave } from '@execlave/sdk';
 * import { instrumentMcpClient } from '@execlave/sdk/integrations/mcp';
 *
 * const exe = new Execlave({ apiKey: '...' });
 * const mcp = new Client({ name: 'app', version: '1.0' });
 * instrumentMcpClient(mcp, exe, { agentId: 'my-bot' });
 *
 * const result = await mcp.callTool({ name: 'search', arguments: { q: 'x' } });
 * ```
 *
 * Idempotent. No compile-time dependency on the MCP SDK — the call
 * surface is duck-typed.
 */

import type { Execlave } from '../client';
import {
  PolicyBlockedError,
  PolicyDeniedError,
  ApprovalTimeoutError,
  EnforcementUnavailableError,
  AgentPausedError,
} from '../errors';
import { SPAN_KIND_TOOL, getSpanTree } from '../instrumentation/spans';

const MARKER = '_execlaveInstrumented';

function isEnforcementError(err: unknown): boolean {
  return (
    err instanceof PolicyBlockedError ||
    err instanceof PolicyDeniedError ||
    err instanceof ApprovalTimeoutError ||
    err instanceof EnforcementUnavailableError ||
    err instanceof AgentPausedError
  );
}

export interface InstrumentMcpClientOptions {
  /** Agent id registered with Execlave. Required for enforcement. */
  agentId: string;
  /** Run `enforcePolicy` on tool calls. Default true. */
  enforce?: boolean;
  sessionId?: string;
  userId?: string;
}

/**
 * Wrap `client.callTool` to enforce policies and record a tool span.
 * Returns the same client for fluent chaining.
 */
export function instrumentMcpClient<T>(
  client: T,
  exe: Execlave,
  opts: InstrumentMcpClientOptions,
): T {
  if (client === null || client === undefined) {
    throw new Error('instrumentMcpClient: client must not be null/undefined');
  }
  if (!exe) throw new Error('instrumentMcpClient: exe must not be null/undefined');
  if (!opts?.agentId) throw new Error('instrumentMcpClient: agentId is required');

  const c = client as any;
  if (c[MARKER]) return client;

  const original = c.callTool;
  if (typeof original !== 'function') {
    throw new TypeError('instrumentMcpClient: client.callTool is missing or not a function');
  }
  const enforce = opts.enforce !== false;
  const tree = getSpanTree(exe);
  const boundOriginal = original.bind(c);

  const wrapped = async (request: any, ...rest: any[]): Promise<any> => {
    // Both `(name, args)` and `({ name, arguments })` shapes are
    // supported by various MCP SDK versions.
    const { name, args } = normaliseCallToolArgs(request, rest);

    if (enforce && name) {
      try {
        await exe.enforcePolicy({
          agentId: opts.agentId,
          input: safeStr(args) ?? `tool:${name}`,
          tools: [name],
        });
      } catch (err) {
        if (isEnforcementError(err)) throw err;
        // eslint-disable-next-line no-console
        console.warn('[execlave] MCP enforcePolicy failed (non-fatal):', err);
      }
    }

    const span = tree.start({
      kind: SPAN_KIND_TOOL,
      name: String(name ?? 'mcp.tool'),
      agentId: opts.agentId,
      sessionId: opts.sessionId,
      userId: opts.userId,
      metadata: { mcpTool: true },
    });
    if (args !== undefined && args !== null) {
      try {
        span.setInput(args);
      } catch {
        /* noop */
      }
    }
    let result: any;
    try {
      result = await boundOriginal(request, ...rest);
    } catch (err: any) {
      span.finish('error', err?.message ?? String(err), err?.name ?? 'Error');
      throw err;
    }
    try {
      const text = extractContent(result?.content);
      if (text !== null) span.setOutput(text);
    } catch {
      /* noop */
    }
    span.finish(result?.isError ? 'error' : 'success');
    return result;
  };

  try {
    c.callTool = wrapped;
    c[MARKER] = true;
  } catch {
    /* frozen object */
  }
  return client;
}

// ----------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------
function normaliseCallToolArgs(
  request: any,
  rest: any[],
): { name: string | null; args: unknown } {
  if (typeof request === 'string') {
    return { name: request, args: rest[0] };
  }
  if (request && typeof request === 'object') {
    const name =
      typeof request.name === 'string'
        ? request.name
        : typeof request?.params?.name === 'string'
          ? request.params.name
          : null;
    const args =
      request.arguments !== undefined
        ? request.arguments
        : request?.params?.arguments;
    return { name, args };
  }
  return { name: null, args: undefined };
}

function extractContent(content: unknown): string | null {
  if (!Array.isArray(content)) return safeStr(content);
  const parts: string[] = [];
  for (const item of content) {
    const text = (item as any)?.text;
    if (typeof text === 'string') parts.push(text);
    else {
      const s = safeStr(item);
      if (s) parts.push(s);
    }
  }
  return parts.length ? parts.join('\n').slice(0, 4000) : null;
}

function safeStr(value: unknown, limit = 4000): string | null {
  if (value === null || value === undefined) return null;
  try {
    const s = typeof value === 'string' ? value : JSON.stringify(value);
    return s.slice(0, limit);
  } catch {
    return null;
  }
}
