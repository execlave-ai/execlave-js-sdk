/**
 * Nested span primitives. Each `Span` wraps the SDK's `Trace` and
 * carries parent/child identity through the trace metadata so the
 * backend can reconstruct the execution tree.
 *
 * Concurrency model: Node.js is single-threaded, but async tasks can
 * interleave. We expose `withSpan(span, fn)` so async framework
 * adapters can scope the "current span" to a specific async operation
 * without relying on AsyncLocalStorage (keeps footprint zero-dep).
 * The default stack is process-wide; framework adapters can pass
 * `parent` explicitly to avoid relying on the implicit stack.
 */

import { randomBytes } from 'crypto';
import { Trace } from '../trace';
import type { Execlave } from '../client';

export const SPAN_KIND_AGENT = 'agent';
export const SPAN_KIND_CHAIN = 'chain';
export const SPAN_KIND_LLM = 'llm';
export const SPAN_KIND_TOOL = 'tool';
export const SPAN_KIND_RETRIEVER = 'retriever';
export const SPAN_KIND_GUARDRAIL = 'guardrail';
export const SPAN_KIND_HANDOFF = 'handoff';

export type SpanKind =
  | typeof SPAN_KIND_AGENT
  | typeof SPAN_KIND_CHAIN
  | typeof SPAN_KIND_LLM
  | typeof SPAN_KIND_TOOL
  | typeof SPAN_KIND_RETRIEVER
  | typeof SPAN_KIND_GUARDRAIL
  | typeof SPAN_KIND_HANDOFF;

export interface StartSpanOptions {
  kind: SpanKind;
  name: string;
  parent?: Span | null;
  agentId?: string;
  sessionId?: string;
  userId?: string;
  metadata?: Record<string, unknown>;
}

export class Span {
  readonly spanId: string;
  readonly parentSpanId: string | null;
  readonly kind: SpanKind;
  readonly name: string;

  private _trace: Trace;
  private _tree: SpanTree;
  private _finished = false;

  constructor(
    trace: Trace,
    opts: {
      spanId: string;
      parentSpanId: string | null;
      kind: SpanKind;
      name: string;
      tree: SpanTree;
    },
  ) {
    this._trace = trace;
    this.spanId = opts.spanId;
    this.parentSpanId = opts.parentSpanId;
    this.kind = opts.kind;
    this.name = opts.name;
    this._tree = opts.tree;

    trace.addMetadata({
      spanId: this.spanId,
      parentSpanId: this.parentSpanId,
      spanKind: this.kind,
      spanName: this.name,
    });
  }

  /** Internal: exposed for nested spans to inherit trace id. */
  get _innerTrace(): Trace {
    return this._trace;
  }

  /** Trace id that this span's metadata is attached to. */
  get traceId(): string {
    return this._trace.traceId;
  }

  setInput(value: unknown): this {
    this._trace.setInput(value);
    return this;
  }
  setOutput(value: unknown): this {
    this._trace.setOutput(value);
    return this;
  }
  setModel(model: string): this {
    this._trace.setModel(model);
    return this;
  }
  setTokens(prompt: number, completion: number): this {
    this._trace.setTokens(prompt, completion);
    return this;
  }
  setCost(costUsd: number): this {
    this._trace.setCost(costUsd);
    return this;
  }
  addMetadata(meta: Record<string, unknown>): this {
    this._trace.addMetadata(meta);
    return this;
  }

  child(opts: { kind: SpanKind; name: string }): Span {
    return this._tree.start({ ...opts, parent: this });
  }

  finish(
    status: 'success' | 'error' | 'timeout' = 'success',
    errorMessage?: string,
    errorType?: string,
  ): void {
    if (this._finished) return;
    this._finished = true;
    this._tree._pop(this);
    try {
      this._trace.finish(status, errorMessage, errorType);
    } catch {
      // transport/buffer errors are never fatal for the host app.
    }
  }
}

export class SpanTree {
  private _stack: Span[] = [];
  constructor(private _exe: Execlave) {}

  current(): Span | null {
    return this._stack.length > 0 ? this._stack[this._stack.length - 1] : null;
  }

  start(opts: StartSpanOptions): Span {
    const parent = opts.parent ?? this.current();
    const parentId = parent ? parent.spanId : null;
    const inherited = parent ? parent._innerTrace : null;

    const trace = this._exe.startTrace({
      traceId: inherited ? inherited.traceId : undefined,
      agentId: opts.agentId ?? inherited?.agentId,
      sessionId: opts.sessionId ?? inherited?.sessionId,
      userId: opts.userId ?? inherited?.userId,
      metadata: opts.metadata,
    });

    const spanId = `sp_${randomBytes(8).toString('hex')}`;
    const span = new Span(trace, {
      spanId,
      parentSpanId: parentId,
      kind: opts.kind,
      name: opts.name,
      tree: this,
    });
    this._stack.push(span);
    return span;
  }

  _pop(span: Span): void {
    const idx = this._stack.lastIndexOf(span);
    if (idx >= 0) this._stack.splice(idx, 1);
  }
}

const _treeCache = new WeakMap<Execlave, SpanTree>();

export function getSpanTree(exe: Execlave): SpanTree {
  let tree = _treeCache.get(exe);
  if (!tree) {
    tree = new SpanTree(exe);
    _treeCache.set(exe, tree);
  }
  return tree;
}
