/**
 * Tests for effect evidence: the `finish()` options-object overload and
 * `ExeclaveClient.resolveTrace()`.
 *
 * NOTE on deviation from the task brief: the brief's sample test imports
 * `createClient` from `./helpers` and reads buffered payloads via a
 * `exe._pendingTraces()` method. Neither exists in this package —
 * `sdk-js/src/__tests__/` has no `helpers.ts`, and `Execlave` has no
 * `_pendingTraces` method (see `sdk-js/src/client.ts`). The real patterns,
 * confirmed by reading the existing suites, are:
 *   - `trace.test.ts` constructs a `Trace` directly against a stub
 *     `{ _bufferTrace: jest.fn() }` owner and asserts on the captured
 *     payload — used here for the `finish()` overload tests.
 *   - `client.test.ts` mocks the `../http` module's `request` export and
 *     builds an `Execlave` client via a local `createClient()` helper —
 *     used here for the `resolveTrace()` test.
 */

import { Trace } from '../trace';
import type { TracePayload } from '../types';

/** Stub owner that captures buffered payloads (mirrors trace.test.ts). */
function createMockOwner() {
  const traces: TracePayload[] = [];
  return {
    _bufferTrace: jest.fn((p: TracePayload) => traces.push(p)),
    traces,
  };
}

describe('effect evidence — finish() overload', () => {
  it('finish() accepts an options object carrying evidence', () => {
    const owner = createMockOwner();
    const trace = new Trace(owner, { agentId: 'agent-1' });

    trace.finish({
      status: 'effect_unconfirmed',
      effectEvidence: { basis: 'acknowledgement', acknowledgementId: 'job_42' },
    });

    expect(owner._bufferTrace).toHaveBeenCalledTimes(1);
    const payload = owner.traces[0];
    expect(payload.status).toBe('effect_unconfirmed');
    expect(payload.effectEvidence).toEqual({
      basis: 'acknowledgement',
      acknowledgementId: 'job_42',
    });
  });

  it('finish() still accepts the positional signature', () => {
    const owner = createMockOwner();
    const trace = new Trace(owner, { agentId: 'agent-1' });

    trace.finish('error', 'boom', 'TypeError');

    const payload = owner.traces[0];
    expect(payload.status).toBe('error');
    expect(payload.errorMessage).toBe('boom');
    expect(payload.errorType).toBe('TypeError');
    expect(payload.effectEvidence).toBeUndefined();
  });

  it('finish() with no arguments still defaults to success', () => {
    const owner = createMockOwner();
    const trace = new Trace(owner, { agentId: 'agent-1' });

    trace.finish();

    expect(owner.traces[0].status).toBe('success');
  });

  it('finish() only buffers once even when called twice', () => {
    const owner = createMockOwner();
    const trace = new Trace(owner, { agentId: 'agent-1' });

    trace.finish({ status: 'effect_unconfirmed' });
    trace.finish('error');

    expect(owner._bufferTrace).toHaveBeenCalledTimes(1);
    expect(owner.traces[0].status).toBe('effect_unconfirmed');
  });
});

// ---------------------------------------------------------------------------
// resolveTrace() — mocks ../http like client.test.ts
// ---------------------------------------------------------------------------
const mockRequest = jest.fn();
jest.mock('../http', () => ({
  request: mockRequest,
}));

// Imported after the mock is in place.
// eslint-disable-next-line import/first
import { Execlave } from '../client';
// eslint-disable-next-line import/first
import { ExeclaveError } from '../errors';

function createClient(overrides: Record<string, unknown> = {}): Execlave {
  return new Execlave({
    apiKey: 'ag_test_key123456789012',
    asyncMode: false,
    enableControlChannel: false,
    debug: false,
    ...overrides,
  } as any);
}

describe('effect evidence — resolveTrace()', () => {
  afterEach(() => {
    mockRequest.mockReset();
  });

  it('posts to the resolutions endpoint', async () => {
    const exe = createClient();
    mockRequest.mockResolvedValueOnce({ status: 201, data: {} });

    await exe.resolveTrace('tr_1', {
      resolvedStatus: 'success',
      basis: 'read_back',
      effectRef: 'invoice_991',
    });

    expect(mockRequest).toHaveBeenCalledTimes(1);
    const call = mockRequest.mock.calls[0][0];
    expect(call.method).toBe('POST');
    expect(call.url).toContain('/api/v1/traces/tr_1/resolutions');
    expect(call.body).toEqual({
      resolvedStatus: 'success',
      basis: 'read_back',
      effectRef: 'invoice_991',
    });
  });

  it('propagates a server rejection rather than swallowing it', async () => {
    // `_request`/`_requestRaw` delegate status-code handling to the real
    // `request()` in ./http, which rejects for 4xx/5xx (resolveOnClientError
    // defaults to false — see http.ts). Since this test mocks the ./http
    // module wholesale, it must simulate that same rejection rather than
    // resolving with a 4xx status, or it would test a shape that can't occur
    // at runtime.
    const exe = createClient();
    mockRequest.mockRejectedValueOnce(new ExeclaveError('API request failed (400): invalid basis'));

    await expect(
      exe.resolveTrace('tr_1', { resolvedStatus: 'success', basis: 'read_back' }),
    ).rejects.toThrow('invalid basis');
  });
});
