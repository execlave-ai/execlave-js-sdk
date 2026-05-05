import { Trace } from '../trace';
import type { TracePayload } from '../types';

/** Stub owner that captures buffered payloads. */
function createMockOwner() {
  const traces: TracePayload[] = [];
  return {
    _bufferTrace: jest.fn((p: TracePayload) => traces.push(p)),
    traces,
  };
}

describe('Trace', () => {
  // ------------------------------------------------------------------
  // Construction
  // ------------------------------------------------------------------
  describe('constructor', () => {
    it('should auto-generate a traceId when not provided', () => {
      const owner = createMockOwner();
      const trace = new Trace(owner, { agentId: 'a1' });
      expect(trace.traceId).toMatch(/^tr_[0-9a-f]{16}$/);
    });

    it('should use provided traceId', () => {
      const owner = createMockOwner();
      const trace = new Trace(owner, { traceId: 'custom-id', agentId: 'a1' });
      expect(trace.traceId).toBe('custom-id');
    });

    it('should store agentId, sessionId, and userId', () => {
      const owner = createMockOwner();
      const trace = new Trace(owner, {
        agentId: 'bot',
        sessionId: 'sess-1',
        userId: 'user-1',
      });
      expect(trace.agentId).toBe('bot');
      expect(trace.sessionId).toBe('sess-1');
      expect(trace.userId).toBe('user-1');
    });
  });

  // ------------------------------------------------------------------
  // Chainable setters
  // ------------------------------------------------------------------
  describe('setters', () => {
    it('setInput() is chainable', () => {
      const owner = createMockOwner();
      const trace = new Trace(owner, {});
      const result = trace.setInput('hello');
      expect(result).toBe(trace);
    });

    it('setOutput() is chainable', () => {
      const owner = createMockOwner();
      const trace = new Trace(owner, {});
      const result = trace.setOutput('world');
      expect(result).toBe(trace);
    });

    it('setModel() is chainable', () => {
      const owner = createMockOwner();
      const trace = new Trace(owner, {});
      expect(trace.setModel('gpt-4')).toBe(trace);
    });

    it('setTokens() is chainable', () => {
      const owner = createMockOwner();
      const trace = new Trace(owner, {});
      expect(trace.setTokens(10, 20)).toBe(trace);
    });

    it('setCost() is chainable', () => {
      const owner = createMockOwner();
      const trace = new Trace(owner, {});
      expect(trace.setCost(0.05)).toBe(trace);
    });

    it('addMetadata() is chainable', () => {
      const owner = createMockOwner();
      const trace = new Trace(owner, {});
      expect(trace.addMetadata({ key: 'val' })).toBe(trace);
    });
  });

  // ------------------------------------------------------------------
  // finish()
  // ------------------------------------------------------------------
  describe('finish()', () => {
    it('should buffer a trace payload with _bufferTrace', () => {
      const owner = createMockOwner();
      const trace = new Trace(owner, { agentId: 'a1' });
      trace.setInput('q').setOutput('a').setModel('gpt-4').setTokens(10, 20);
      trace.finish();

      expect(owner._bufferTrace).toHaveBeenCalledTimes(1);
      const payload = owner.traces[0];
      expect(payload.agentId).toBe('a1');
      expect(payload.input).toBe('q');
      expect(payload.output).toBe('a');
      expect(payload.modelName).toBe('gpt-4');
      expect(payload.promptTokens).toBe(10);
      expect(payload.completionTokens).toBe(20);
      expect(payload.totalTokens).toBe(30);
      expect(payload.status).toBe('success');
    });

    it('should default status to success', () => {
      const owner = createMockOwner();
      const trace = new Trace(owner, {});
      trace.finish();
      expect(owner.traces[0].status).toBe('success');
    });

    it('should record error status, message, and type', () => {
      const owner = createMockOwner();
      const trace = new Trace(owner, {});
      trace.finish('error', 'Oops', 'RuntimeError');

      const p = owner.traces[0];
      expect(p.status).toBe('error');
      expect(p.errorMessage).toBe('Oops');
      expect(p.errorType).toBe('RuntimeError');
    });

    it('should compute durationMs >= 0', () => {
      const owner = createMockOwner();
      const trace = new Trace(owner, {});
      trace.finish();
      expect(owner.traces[0].durationMs).toBeGreaterThanOrEqual(0);
    });

    it('should include timestamp as ISO string', () => {
      const owner = createMockOwner();
      const trace = new Trace(owner, {});
      trace.finish();
      const ts = owner.traces[0].timestamp;
      expect(new Date(ts).toISOString()).toBe(ts);
    });

    it('should be idempotent — second call is a no-op', () => {
      const owner = createMockOwner();
      const trace = new Trace(owner, {});
      trace.finish();
      trace.finish();
      expect(owner._bufferTrace).toHaveBeenCalledTimes(1);
    });

    it('should include metadata when added', () => {
      const owner = createMockOwner();
      const trace = new Trace(owner, {});
      trace.addMetadata({ custom: 'value' });
      trace.finish();
      expect(owner.traces[0].metadata).toEqual({ custom: 'value' });
    });

    it('should omit metadata when none is added', () => {
      const owner = createMockOwner();
      const trace = new Trace(owner, {});
      trace.finish();
      expect(owner.traces[0].metadata).toBeUndefined();
    });

    it('should include costUsd when setCost is called', () => {
      const owner = createMockOwner();
      const trace = new Trace(owner, {});
      trace.setCost(0.03);
      trace.finish();
      expect(owner.traces[0].costUsd).toBe(0.03);
    });

    it('should leave totalTokens undefined when tokens not set', () => {
      const owner = createMockOwner();
      const trace = new Trace(owner, {});
      trace.finish();
      expect(owner.traces[0].totalTokens).toBeUndefined();
    });

    it('should include environment, sessionId, userId, tags, parentTraceId, spanType in payload when set', () => {
      const owner = createMockOwner();
      const trace = new Trace(owner, {
        agentId: 'a1',
        sessionId: 'sess-9',
        userId: 'user-9',
        environment: 'development',
        tags: ['exp', 'qa'],
        parentTraceId: 'tr_parent',
        spanType: 'llm',
        metadata: { k: 'v' },
      });
      trace.finish();
      const p = owner.traces[0];
      expect(p.environment).toBe('development');
      expect(p.sessionId).toBe('sess-9');
      expect(p.userId).toBe('user-9');
      expect(p.tags).toEqual(['exp', 'qa']);
      expect(p.parentTraceId).toBe('tr_parent');
      expect(p.spanType).toBe('llm');
      expect(p.metadata).toEqual({ k: 'v' });
    });

    it('should omit environment, tags, parentTraceId, spanType when not set', () => {
      const owner = createMockOwner();
      const trace = new Trace(owner, {});
      trace.finish();
      const p = owner.traces[0];
      expect(p.environment).toBeUndefined();
      expect(p.tags).toBeUndefined();
      expect(p.parentTraceId).toBeUndefined();
      expect(p.spanType).toBeUndefined();
    });

    it('addTags() merges and deduplicates', () => {
      const owner = createMockOwner();
      const trace = new Trace(owner, { tags: ['a'] });
      trace.addTags(['b', 'a', 'c']);
      trace.finish();
      expect(owner.traces[0].tags).toEqual(['a', 'b', 'c']);
    });
  });
});
