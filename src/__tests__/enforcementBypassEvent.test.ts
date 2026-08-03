import { Execlave } from '../client';
import type { EnforcementBypassEvent } from '../types';

jest.mock('../http', () => ({ request: jest.fn() }));
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { request } = require('../http');

/**
 * Under `fail_open` (the default) an enforcement outage is invisible: the call
 * returns allowed:true and the only trace was a debug log, which is off in
 * production. That window — the agent running ungoverned — is exactly what an
 * auditor needs, so it is now reported as a structured event (F-SDK-12).
 */
function makeClient(onEnforcementBypassed?: (e: EnforcementBypassEvent) => void) {
  return new Execlave({
    apiKey: 'exe_prod_test',
    baseUrl: 'https://api.test',
    enableControlChannel: false,
    asyncMode: false,
    onEnforcementBypassed,
  });
}

const events: EnforcementBypassEvent[] = [];
const collect = (e: EnforcementBypassEvent) => events.push(e);

beforeEach(() => {
  events.length = 0;
  (request as jest.Mock).mockReset();
});

describe('enforcement bypass reporting', () => {
  it('reports a network outage that was allowed through', async () => {
    (request as jest.Mock).mockRejectedValue(Object.assign(new Error('socket hang up')));

    const exe = makeClient(collect);
    const result = await exe.enforcePolicy({ agentId: 'agent-1', input: 'hello' });

    expect(result.allowed).toBe(true);
    expect(events).toHaveLength(1);
    expect(events[0].reason).toBe('network_error');
    expect(events[0].agentId).toBe('agent-1');
    expect(events[0].message).toContain('socket hang up');
    // The timestamp is stamped when the bypass happened, so the ungoverned
    // window can be reconstructed later.
    expect(() => new Date(events[0].timestamp).toISOString()).not.toThrow();
  });

  it('reports a 5xx that was allowed through, with the status', async () => {
    (request as jest.Mock).mockResolvedValue({ status: 503, data: {} });

    const exe = makeClient(collect);
    const result = await exe.enforcePolicy({ agentId: 'agent-2', input: 'hi' });

    expect(result.allowed).toBe(true);
    expect(events[0].reason).toBe('server_error');
    expect(events[0].status).toBe(503);
  });

  it('reports a plan-limit bypass, since running unmonitored is still a gap', async () => {
    (request as jest.Mock).mockResolvedValue({
      status: 402,
      data: { error: { resource: 'maxTracesPerMonth', current: 10, max: 10, message: 'limit' } },
    });

    const exe = makeClient(collect);
    await exe.enforcePolicy({ agentId: 'agent-3', input: 'hi' });

    expect(events[0].reason).toBe('plan_limit_exceeded');
    expect(events[0].status).toBe(402);
  });

  it('reports every bypass while the breaker stays open', async () => {
    (request as jest.Mock).mockRejectedValue(new Error('down'));
    const exe = makeClient(collect);

    // Trip the breaker (threshold 3), then keep calling.
    for (let i = 0; i < 5; i++) {
      await exe.enforcePolicy({ agentId: 'agent-4', input: `call ${i}` });
    }

    // Silence after the breaker opens would hide the longest ungoverned
    // stretch — precisely the part that matters.
    expect(events.length).toBe(5);
    expect(events.some((e) => e.reason === 'circuit_breaker_open')).toBe(true);
  });

  it('marks a breaker-open allow in the result source', async () => {
    (request as jest.Mock).mockRejectedValue(new Error('down'));
    const exe = makeClient();

    for (let i = 0; i < 3; i++) {
      await exe.enforcePolicy({ agentId: 'agent-5', input: 'x' });
    }
    const afterOpen = await exe.enforcePolicy({ agentId: 'agent-5', input: 'x' });

    // This path previously returned allowed:true with NO source, so a caller
    // could not distinguish it from a governed allow.
    expect(afterOpen.source).toBe('fail_open_circuit_breaker');
  });

  it('does not fire on a normal governed allow', async () => {
    (request as jest.Mock).mockResolvedValue({ status: 200, data: { allowed: true } });

    const exe = makeClient(collect);
    await exe.enforcePolicy({ agentId: 'agent-6', input: 'hi' });

    expect(events).toHaveLength(0);
  });

  it('survives a listener that throws', async () => {
    (request as jest.Mock).mockRejectedValue(new Error('down'));
    const exe = makeClient(() => {
      throw new Error('listener exploded');
    });

    // A faulty observer must never break the path it is observing.
    await expect(exe.enforcePolicy({ agentId: 'agent-7', input: 'hi' })).resolves.toMatchObject({
      allowed: true,
    });
  });

  it('works when no listener is configured', async () => {
    (request as jest.Mock).mockRejectedValue(new Error('down'));
    const exe = makeClient();
    await expect(exe.enforcePolicy({ agentId: 'agent-8', input: 'hi' })).resolves.toMatchObject({
      allowed: true,
    });
  });
});
