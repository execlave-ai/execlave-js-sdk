/**
 * A trace the platform refuses must reach the application.
 *
 * Traces are sent in the background. Before this, a refusal was a debug log
 * (off in production) and a per-trace refusal inside an accepted batch was
 * not read at all, so the caller believed a `success` had been recorded when
 * nothing was stored. The case that matters most is an agent whose outcome
 * strictness is `strict`: the platform refuses a `success` without confirming
 * evidence with `OUTCOME_EVIDENCE_REQUIRED`.
 */
const mockRequest = jest.fn();
jest.mock('../http', () => ({
  request: mockRequest,
}));

import { Execlave } from '../client';
import type { TraceRejection } from '../types';

const STRICT_MESSAGE =
  'This agent requires confirmed outcomes (outcomeStrictness "strict"): status "success" needs effectEvidence';

function createClient(overrides: Record<string, unknown> = {}): Execlave {
  const exe = new Execlave({
    apiKey: 'ag_test_key123456789012',
    asyncMode: true,
    flushIntervalMs: 10_000_000,
    enableControlChannel: false,
    debug: false,
    ...overrides,
  } as any);
  (exe as any)._sleep = jest.fn().mockResolvedValue(undefined);
  return exe;
}

const ingestCalls = () =>
  mockRequest.mock.calls.filter((c: any) => c[0].url?.includes('/traces/ingest'));

describe('rejected traces reach the application', () => {
  let consoleError: jest.SpyInstance;

  beforeEach(() => {
    mockRequest.mockReset();
    consoleError = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    consoleError.mockRestore();
  });

  it('reports a strict refusal of the whole batch (400) to onTraceRejected and from flush()', async () => {
    const onTraceRejected = jest.fn();
    const exe = createClient({ onTraceRejected });
    const trace = exe.startTrace({ agentId: 'bot' });
    trace.finish();
    mockRequest.mockResolvedValue({
      status: 400,
      data: {
        error: { code: 'OUTCOME_EVIDENCE_REQUIRED', message: STRICT_MESSAGE },
        accepted: 0,
        failed: 1,
        errors: [{ traceId: trace.traceId, code: 'OUTCOME_EVIDENCE_REQUIRED', error: STRICT_MESSAGE }],
      },
    });

    const result = await exe.flush();

    const expected: TraceRejection[] = [
      { traceId: trace.traceId, code: 'OUTCOME_EVIDENCE_REQUIRED', message: STRICT_MESSAGE },
    ];
    expect(result).toEqual({ sent: 0, rejected: expected, undelivered: 0 });
    expect(onTraceRejected).toHaveBeenCalledTimes(1);
    expect(onTraceRejected).toHaveBeenCalledWith(expected);
  });

  it('never resends a refused trace, as success or as anything else', async () => {
    const exe = createClient({ onTraceRejected: jest.fn() });
    exe.startTrace({ agentId: 'bot' }).finish();
    mockRequest.mockResolvedValue({
      status: 400,
      data: { error: { code: 'OUTCOME_EVIDENCE_REQUIRED', message: STRICT_MESSAGE } },
    });

    await exe.flush();
    await exe.flush();

    // One attempt, and the refused trace is not put back in the buffer.
    expect(ingestCalls()).toHaveLength(1);
  });

  it('reads per-trace refusals inside an accepted batch (202)', async () => {
    const onTraceRejected = jest.fn();
    const exe = createClient({ onTraceRejected });
    const refused = exe.startTrace({ agentId: 'strict-bot' });
    refused.finish();
    exe.startTrace({ agentId: 'other-bot' }).finish();
    mockRequest.mockResolvedValue({
      status: 202,
      data: {
        accepted: 1,
        failed: 1,
        errors: [{ traceId: refused.traceId, code: 'OUTCOME_EVIDENCE_REQUIRED', error: STRICT_MESSAGE }],
      },
    });

    const result = await exe.flush();

    expect(result.sent).toBe(1);
    expect(result.rejected).toEqual([
      { traceId: refused.traceId, code: 'OUTCOME_EVIDENCE_REQUIRED', message: STRICT_MESSAGE },
    ]);
    expect(onTraceRejected).toHaveBeenCalledWith(result.rejected);
  });

  it('reports every trace of a chunk when a 4xx names none', async () => {
    const exe = createClient({ onTraceRejected: jest.fn() });
    const a = exe.startTrace({ agentId: 'bot' });
    a.finish();
    const b = exe.startTrace({ agentId: 'bot' });
    b.finish();
    mockRequest.mockResolvedValue({
      status: 400,
      data: { error: { code: 'VALIDATION_ERROR', message: 'Validation failed' } },
    });

    const result = await exe.flush();

    expect(result.rejected.map((r) => r.traceId).sort()).toEqual([a.traceId, b.traceId].sort());
    expect(result.rejected.every((r) => r.code === 'VALIDATION_ERROR')).toBe(true);
  });

  it('writes to console.error when no handler is set, even with debug off', async () => {
    const exe = createClient();
    const trace = exe.startTrace({ agentId: 'bot' });
    trace.finish();
    mockRequest.mockResolvedValue({
      status: 400,
      data: {
        error: { code: 'OUTCOME_EVIDENCE_REQUIRED', message: STRICT_MESSAGE },
        errors: [{ traceId: trace.traceId, code: 'OUTCOME_EVIDENCE_REQUIRED', error: STRICT_MESSAGE }],
      },
    });

    await exe.flush();

    expect(consoleError).toHaveBeenCalledTimes(1);
    const line = String(consoleError.mock.calls[0][0]);
    expect(line).toContain('NOT stored');
    expect(line).toContain(trace.traceId);
    expect(line).toContain('OUTCOME_EVIDENCE_REQUIRED');
  });

  it('says nothing when every trace was stored', async () => {
    const onTraceRejected = jest.fn();
    const exe = createClient({ onTraceRejected });
    exe.startTrace({ agentId: 'bot' }).finish();
    mockRequest.mockResolvedValue({ status: 202, data: { accepted: 1, failed: 0 } });

    const result = await exe.flush();

    expect(result).toEqual({ sent: 1, rejected: [], undelivered: 0 });
    expect(onTraceRejected).not.toHaveBeenCalled();
    expect(consoleError).not.toHaveBeenCalled();
  });

  it('survives a handler that throws', async () => {
    const exe = createClient({
      onTraceRejected: () => {
        throw new Error('listener bug');
      },
    });
    exe.startTrace({ agentId: 'bot' }).finish();
    mockRequest.mockResolvedValue({
      status: 400,
      data: { error: { code: 'OUTCOME_EVIDENCE_REQUIRED', message: STRICT_MESSAGE } },
    });

    await expect(exe.flush()).resolves.toMatchObject({ sent: 0 });
  });

  it('counts traces dropped after exhausted retries as undelivered, not as rejected', async () => {
    const onTraceRejected = jest.fn();
    const exe = createClient({ onTraceRejected });
    exe.startTrace({ agentId: 'bot' }).finish();
    mockRequest.mockResolvedValue({ status: 503, data: { error: { message: 'down' } } });

    const result = await exe.flush();

    expect(result).toEqual({ sent: 0, rejected: [], undelivered: 1 });
    expect(onTraceRejected).not.toHaveBeenCalled();
  });
});
