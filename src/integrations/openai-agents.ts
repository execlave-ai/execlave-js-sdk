/**
 * OpenAI Agents SDK auto-instrumentation.
 *
 * Plug into the Agents SDK tracing pipeline:
 *
 * ```ts
 * import { setTraceProcessors } from '@openai/agents';
 * import { Execlave } from '@execlave/sdk';
 * import { ExeclaveTracingProcessor } from '@execlave/sdk/integrations/openai-agents';
 *
 * const exe = new Execlave({ apiKey: '...' });
 * setTraceProcessors([new ExeclaveTracingProcessor(exe, { agentId: 'my-bot' })]);
 * ```
 *
 * The processor maps each agent_span / generation_span / function_span /
 * handoff_span / guardrail_span into an Execlave span via the shared
 * instrumentation layer. Tool-call enforcement runs on function_span
 * starts so tool-allowlist policies block a tool before the SDK executes
 * it.
 *
 * No compile-time dependency on the OpenAI Agents SDK — span shapes are
 * duck-typed.
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
  SPAN_KIND_GUARDRAIL,
  SPAN_KIND_HANDOFF,
  SPAN_KIND_LLM,
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

export interface ExeclaveTracingProcessorOptions {
  /** Agent id registered with Execlave. Required for enforcement. */
  agentId: string;
  /** Run `enforcePolicy` on tool starts. Default true. */
  enforce?: boolean;
  sessionId?: string;
  userId?: string;
}

// Mapping from Agents-SDK span-data class names to Execlave span kinds.
// Keyed on `span.spanData.constructor.name` to stay version-tolerant.
const KIND_MAP: Record<string, string> = {
  AgentSpanData: SPAN_KIND_AGENT,
  GenerationSpanData: SPAN_KIND_LLM,
  ResponseSpanData: SPAN_KIND_LLM,
  FunctionSpanData: SPAN_KIND_TOOL,
  HandoffSpanData: SPAN_KIND_HANDOFF,
  GuardrailSpanData: SPAN_KIND_GUARDRAIL,
  CustomSpanData: SPAN_KIND_AGENT,
};

/**
 * TracingProcessor implementation for the OpenAI Agents SDK that streams
 * spans into Execlave.
 *
 * Implements the duck-typed methods the Agents SDK invokes: `onTraceStart`,
 * `onTraceEnd`, `onSpanStart`, `onSpanEnd`, `shutdown`, `forceFlush`.
 */
export class ExeclaveTracingProcessor {
  readonly name = 'ExeclaveTracingProcessor';

  private _exe: Execlave;
  private _agentId: string;
  private _enforce: boolean;
  private _sessionId?: string;
  private _userId?: string;
  private _tree: ReturnType<typeof getSpanTree>;
  private _spans = new Map<string, Span>();

  constructor(exe: Execlave, opts: ExeclaveTracingProcessorOptions) {
    if (!exe) throw new Error('ExeclaveTracingProcessor requires an Execlave client');
    if (!opts?.agentId) throw new Error('ExeclaveTracingProcessor requires agentId');
    this._exe = exe;
    this._agentId = opts.agentId;
    this._enforce = opts.enforce !== false;
    this._sessionId = opts.sessionId;
    this._userId = opts.userId;
    this._tree = getSpanTree(exe);
  }

  // --------------------------------------------------------------
  // TracingProcessor interface
  // --------------------------------------------------------------
  onTraceStart(_trace: unknown): void {
    /* no-op */
  }

  onTraceEnd(_trace: unknown): void {
    /* no-op */
  }

  async onSpanStart(span: any): Promise<void> {
    try {
      await this._startSpan(span);
    } catch (err) {
      if (isEnforcementError(err)) throw err;
      // eslint-disable-next-line no-console
      console.warn('[execlave] onSpanStart failed (non-fatal):', err);
    }
  }

  onSpanEnd(span: any): void {
    try {
      this._endSpan(span);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('[execlave] onSpanEnd failed (non-fatal):', err);
    }
  }

  async shutdown(): Promise<void> {
    try {
      await this._exe.flush();
    } catch {
      /* noop */
    }
  }

  async forceFlush(): Promise<void> {
    try {
      await this._exe.flush();
    } catch {
      /* noop */
    }
  }

  // --------------------------------------------------------------
  // Internals
  // --------------------------------------------------------------
  private async _enforceTool(toolName: string, args: unknown): Promise<void> {
    if (!this._enforce) return;
    try {
      await this._exe.enforcePolicy({
        agentId: this._agentId,
        input: safeStr(args) ?? `tool:${toolName}`,
        tools: [toolName],
      });
    } catch (err) {
      if (isEnforcementError(err)) throw err;
      // eslint-disable-next-line no-console
      console.warn('[execlave] enforcePolicy failed (non-fatal):', err);
    }
  }

  private async _startSpan(span: any): Promise<void> {
    const spanId = getAttr(span, 'spanId') ?? getAttr(span, 'id');
    if (!spanId) return;
    const parentId = getAttr(span, 'parentId');
    const spanData = getAttr(span, 'spanData');
    const dataClass = spanData ? (spanData as { constructor?: { name?: string } }).constructor?.name ?? '' : '';
    const kind = (KIND_MAP[dataClass] ?? SPAN_KIND_AGENT) as Parameters<typeof this._tree.start>[0]['kind'];
    const name = spanName(spanData) ?? kind;

    // Tool-call enforcement happens before we open the span so a block
    // aborts the SDK run without producing an orphaned span.
    if (kind === SPAN_KIND_TOOL) {
      const args = getAttr(spanData, 'input') ?? getAttr(spanData, 'arguments');
      await this._enforceTool(name, args);
    }

    const parent = parentId ? this._spans.get(String(parentId)) : null;
    const ourSpan = this._tree.start({
      kind,
      name,
      parent,
      agentId: this._agentId,
      sessionId: this._sessionId,
      userId: this._userId,
      metadata: { openaiAgentsSpanId: String(spanId) },
    });

    const input = getAttr(spanData, 'input');
    if (input !== undefined && input !== null) {
      try {
        ourSpan.setInput(input);
      } catch {
        /* noop */
      }
    }
    const model = getAttr(spanData, 'model');
    if (typeof model === 'string' && model) ourSpan.setModel(model);
    this._spans.set(String(spanId), ourSpan);
  }

  private _endSpan(span: any): void {
    const spanId = getAttr(span, 'spanId') ?? getAttr(span, 'id');
    if (!spanId) return;
    const ourSpan = this._spans.get(String(spanId));
    if (!ourSpan) return;
    this._spans.delete(String(spanId));

    const spanData = getAttr(span, 'spanData');
    const output = getAttr(spanData, 'output');
    if (output !== undefined && output !== null) {
      try {
        ourSpan.setOutput(output);
      } catch {
        /* noop */
      }
    }
    const usage = getAttr(spanData, 'usage') as Record<string, unknown> | null;
    if (usage && typeof usage === 'object') {
      const p = (usage.prompt_tokens ?? usage.input_tokens ?? usage.promptTokens ?? usage.inputTokens) as
        | number
        | undefined;
      const c = (usage.completion_tokens ?? usage.output_tokens ?? usage.completionTokens ?? usage.outputTokens) as
        | number
        | undefined;
      if (typeof p === 'number' && typeof c === 'number') ourSpan.setTokens(p, c);
    }
    const error = getAttr(span, 'error');
    if (error) {
      const msg = (error as { message?: string }).message ?? safeStr(error) ?? 'error';
      const type = (error as { name?: string }).name ?? 'Error';
      ourSpan.finish('error', msg, type);
    } else {
      ourSpan.finish('success');
    }
  }
}

// ----------------------------------------------------------------------
// Defensive getters — span-data shape varies across SDK versions.
// ----------------------------------------------------------------------
function getAttr(obj: any, name: string): unknown {
  if (obj === null || obj === undefined) return undefined;
  // Try snake_case fallback (Python parity).
  const snake = name.replace(/([A-Z])/g, '_$1').toLowerCase();
  if (typeof obj === 'object') {
    if (name in obj && obj[name] !== undefined) return obj[name];
    if (snake in obj && obj[snake] !== undefined) return obj[snake];
  }
  return undefined;
}

function spanName(spanData: any): string | null {
  if (!spanData) return null;
  for (const attr of ['name', 'toolName', 'tool_name', 'functionName', 'function_name', 'agentName', 'agent_name', 'model']) {
    const v = getAttr(spanData, attr);
    if (typeof v === 'string' && v) return v;
  }
  return null;
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
