/**
 * Trace object for recording execution details.
 *
 * Used as a handle returned by `ag.startTrace()`. Collects input, output,
 * model info, tokens, cost, and metadata. Call `.finish()` to submit.
 */

import { randomBytes } from 'crypto';
import type { TracePayload, TraceStatus } from './types';

// Back-reference to the client to avoid circular import at module level.
// The client sets itself on each Trace via the constructor.
interface BufferOwner {
  _bufferTrace(payload: TracePayload): void;
}

export class Trace {
  readonly traceId: string;
  readonly agentId: string | undefined;
  readonly sessionId: string | undefined;
  readonly userId: string | undefined;

  private _owner: BufferOwner;
  private _metadata: Record<string, unknown>;
  private _input: unknown = undefined;
  private _output: unknown = undefined;
  private _modelName: string | undefined;
  private _promptTokens: number | undefined;
  private _completionTokens: number | undefined;
  private _cost: number | undefined;
  private _status: TraceStatus = 'success';
  private _errorMessage: string | undefined;
  private _errorType: string | undefined;
  private _startMs: number;
  private _durationOverride: number | undefined;
  private _finished = false;

  constructor(
    owner: BufferOwner,
    opts: {
      agentId?: string;
      traceId?: string;
      sessionId?: string;
      userId?: string;
      metadata?: Record<string, unknown>;
    } = {},
  ) {
    this._owner = owner;
    this.traceId = opts.traceId ?? `tr_${randomBytes(8).toString('hex')}`;
    this.agentId = opts.agentId;
    this.sessionId = opts.sessionId;
    this.userId = opts.userId;
    this._metadata = opts.metadata ?? {};
    this._startMs = Date.now();
  }

  /** Set the input data for this trace. Chainable. */
  setInput(data: unknown): this {
    this._input = data;
    return this;
  }

  /** Set the output data for this trace. Chainable. */
  setOutput(data: unknown): this {
    this._output = data;
    return this;
  }

  /** Set the model name used. Chainable. */
  setModel(modelName: string): this {
    this._modelName = modelName;
    return this;
  }

  /** Set token counts. Chainable. */
  setTokens(prompt: number, completion: number): this {
    this._promptTokens = prompt;
    this._completionTokens = completion;
    return this;
  }

  /** Set estimated cost in USD. Chainable. */
  setCost(costUsd: number): this {
    this._cost = costUsd;
    return this;
  }

  /** Merge additional metadata. Chainable. */
  addMetadata(meta: Record<string, unknown>): this {
    Object.assign(this._metadata, meta);
    return this;
  }

  /** Override the auto-calculated duration (ms). Chainable. */
  setDuration(ms: number): this {
    this._durationOverride = ms;
    return this;
  }

  /**
   * Finish the trace and submit it to the buffer.
   *
   * @param status - 'success' | 'error' | 'timeout' | 'blocked'
   * @param errorMessage - Error message if status is 'error'
   * @param errorType - Error class/type name
   */
  finish(
    status: TraceStatus = 'success',
    errorMessage?: string,
    errorType?: string,
  ): void {
    if (this._finished) return;
    this._finished = true;

    this._status = status;
    this._errorMessage = errorMessage;
    this._errorType = errorType;

    this._owner._bufferTrace(this._toPayload());
  }

  private _toPayload(): TracePayload {
    const durationMs = this._durationOverride ?? (Date.now() - this._startMs);
    const totalTokens =
      this._promptTokens !== undefined && this._completionTokens !== undefined
        ? this._promptTokens + this._completionTokens
        : undefined;

    return {
      traceId: this.traceId,
      agentId: this.agentId,
      sessionId: this.sessionId,
      userId: this.userId,
      timestamp: new Date(this._startMs).toISOString(),
      durationMs,
      status: this._status,
      input: this._input,
      output: this._output,
      errorMessage: this._errorMessage,
      errorType: this._errorType,
      modelName: this._modelName,
      promptTokens: this._promptTokens,
      completionTokens: this._completionTokens,
      totalTokens,
      costUsd: this._cost,
      metadata: Object.keys(this._metadata).length > 0 ? this._metadata : undefined,
    };
  }
}
