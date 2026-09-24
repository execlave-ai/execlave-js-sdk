import { Execlave } from '../client';
import { EnforcementUnavailableError } from '../errors';
import type { EnforcementBypassEvent } from '../types';

jest.mock('../http', () => ({ request: jest.fn() }));
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { request } = require('../http');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const pkgVersion: string = require('../../package.json').version;

/**
 * `onEnforcementBypassed` only tells the caller's own process. Until bypasses
 * also reached the server, the platform's audit trail could not tell "all calls
 * governed" from "the SDK lost contact for two hours" — an absent record read as
 * fully governed. These tests pin the end-to-end behaviour: what a real client
 * sends, when, and that none of it can touch the enforcement path.
 */
const isReport = (c: unknown[]) =>
  String((c[0] as { url: string }).url).endsWith('/sdk/bypass-windows');
const reports = () =>
  (request as jest.Mock).mock.calls.filter(isReport).map((c) => (c[0] as { body: any }).body);
const allWindows = () => reports().flatMap((b) => b.windows);

let enforce: (input: string) => Promise<{ status: number; data?: unknown }>;
let reportHandler: () => Promise<{ status: number; data?: unknown }>;

function makeClient(over: Record<string, unknown> = {}) {
  return new Execlave({
    apiKey: 'exe_prod_test',
    baseUrl: 'https://api.test',
    enableControlChannel: false,
    asyncMode: false,
    ...over,
  });
}

beforeEach(() => {
  (request as jest.Mock).mockReset();
  enforce = async () => {
    throw new Error('socket hang up');
  };
  reportHandler = async () => ({ status: 200, data: { accepted: 1, duplicates: 0 } });
  (request as jest.Mock).mockImplementation(
    async (opts: { url: string; body?: { input?: string } }) =>
      String(opts.url).endsWith('/sdk/bypass-windows')
        ? reportHandler()
        : enforce(opts.body?.input ?? ''),
  );
});

afterEach(() => {
  jest.useRealTimers();
});

describe('bypass reporting to the platform', () => {
  it('reports a network-outage bypass as one coalesced window on shutdown', async () => {
    const exe = makeClient();
    await exe.enforcePolicy({ agentId: 'agent-1', input: 'one' });
    await exe.enforcePolicy({ agentId: 'agent-1', input: 'two' });
    await exe.shutdown();

    const ws = allWindows();
    expect(ws).toHaveLength(1);
    expect(ws[0]).toMatchObject({
      agentId: 'agent-1',
      reason: 'network_error',
      source: 'fail_open_network_error',
      count: 2,
    });
    expect(ws[0].windowId).toMatch(/^[0-9a-f-]{36}$/);
    expect(new Date(ws[0].firstAt).getTime()).not.toBeNaN();
  });

  it('posts to the versioned endpoint and identifies the SDK from package.json', async () => {
    const exe = makeClient();
    await exe.enforcePolicy({ agentId: 'agent-1', input: 'x' });
    await exe.shutdown();

    const call = (request as jest.Mock).mock.calls.find(isReport)![0];
    expect(call.method).toBe('POST');
    expect(call.url).toBe('https://api.test/api/v1/sdk/bypass-windows');
    expect(call.headers.Authorization).toBe('Bearer exe_prod_test');
    expect(reports()[0].sdk).toEqual({
      name: '@execlave/sdk',
      language: 'js',
      version: pkgVersion,
    });
  });

  it('reports a plan-limit bypass — the one most likely to fire in normal operation', async () => {
    enforce = async () => ({
      status: 402,
      data: { error: { resource: 'maxTracesPerMonth', current: 10, max: 10, message: 'limit' } },
    });
    const exe = makeClient();
    await exe.enforcePolicy({ agentId: 'agent-1', input: 'x' });
    await exe.shutdown();

    expect(allWindows()[0]).toMatchObject({
      reason: 'plan_limit_exceeded',
      source: 'fail_open_plan_limit',
      status: 402,
    });
  });

  it('reports a 5xx bypass with its status', async () => {
    enforce = async () => ({ status: 503, data: {} });
    const exe = makeClient();
    await exe.enforcePolicy({ agentId: 'agent-1', input: 'x' });
    await exe.shutdown();

    expect(allWindows()[0]).toMatchObject({ reason: 'server_error', status: 503 });
  });

  it('reports even when no onEnforcementBypassed listener is wired', async () => {
    const exe = makeClient(); // no listener
    await exe.enforcePolicy({ agentId: 'agent-1', input: 'x' });
    await exe.shutdown();

    expect(allWindows()).toHaveLength(1);
  });

  it('still calls the local listener once per bypass, alongside reporting', async () => {
    const events: EnforcementBypassEvent[] = [];
    const exe = makeClient({
      onEnforcementBypassed: (e: EnforcementBypassEvent) => events.push(e),
    });
    await exe.enforcePolicy({ agentId: 'agent-1', input: 'a' });
    await exe.enforcePolicy({ agentId: 'agent-1', input: 'b' });
    await exe.shutdown();

    // The listener keeps its per-call granularity; the server gets the window.
    expect(events).toHaveLength(2);
    expect(allWindows()[0].count).toBe(2);
  });

  it('a throwing listener cannot stop the report', async () => {
    const exe = makeClient({
      onEnforcementBypassed: () => {
        throw new Error('listener exploded');
      },
    });
    await exe.enforcePolicy({ agentId: 'agent-1', input: 'x' });
    await exe.shutdown();

    expect(allWindows()).toHaveLength(1);
  });

  it('reportBypassesToPlatform: false keeps only the local callback', async () => {
    const events: EnforcementBypassEvent[] = [];
    const exe = makeClient({
      reportBypassesToPlatform: false,
      onEnforcementBypassed: (e: EnforcementBypassEvent) => events.push(e),
    });
    await exe.enforcePolicy({ agentId: 'agent-1', input: 'x' });
    await exe.shutdown();

    expect(events).toHaveLength(1);
    expect(reports()).toHaveLength(0);
  });

  it('reports nothing under fail_closed — nothing was bypassed', async () => {
    const exe = makeClient({ enforcementOnOutage: 'fail_closed' });
    await expect(exe.enforcePolicy({ agentId: 'agent-1', input: 'x' })).rejects.toBeInstanceOf(
      EnforcementUnavailableError,
    );
    await exe.shutdown();

    expect(reports()).toHaveLength(0);
  });

  it('a governed decision ends the window: two outages are two records, not one', async () => {
    const exe = makeClient();
    await exe.enforcePolicy({ agentId: 'agent-1', input: 'down 1' });
    await exe.enforcePolicy({ agentId: 'agent-1', input: 'down 2' });

    // The platform is back and decides.
    enforce = async () => ({ status: 200, data: { allowed: true } });
    await exe.enforcePolicy({ agentId: 'agent-1', input: 'up' });

    // ...and goes away again.
    enforce = async () => {
      throw new Error('socket hang up');
    };
    await exe.enforcePolicy({ agentId: 'agent-1', input: 'down 3' });
    await exe.shutdown();

    expect(allWindows().map((w) => w.count)).toEqual([2, 1]);
  });

  it('a fail-open plan-limit 402 keeps its window open; it is a bypass, not a recovery', async () => {
    enforce = async () => ({
      status: 402,
      data: { error: { resource: 'maxTracesPerMonth', current: 10, max: 10, message: 'limit' } },
    });
    const exe = makeClient();
    await exe.enforcePolicy({ agentId: 'agent-1', input: 'a' });
    await exe.enforcePolicy({ agentId: 'agent-1', input: 'b' });
    await exe.enforcePolicy({ agentId: 'agent-1', input: 'c' });
    await exe.shutdown();

    expect(allWindows().map((w) => w.count)).toEqual([3]);
  });

  it('does not report a governed allow', async () => {
    enforce = async () => ({ status: 200, data: { allowed: true } });
    const exe = makeClient();
    await exe.enforcePolicy({ agentId: 'agent-1', input: 'x' });
    await exe.shutdown();

    expect(reports()).toHaveLength(0);
  });
});

describe('never on the enforcement path', () => {
  it('a hung report endpoint does not slow enforcement, and shutdown gives up at its deadline', async () => {
    jest.useFakeTimers();
    reportHandler = () => new Promise(() => {}); // never answers
    const exe = makeClient();

    for (let i = 0; i < 5; i++) {
      // Each resolves without touching the report endpoint at all.
      await exe.enforcePolicy({ agentId: 'agent-1', input: `call ${i}` });
    }
    expect(reports()).toHaveLength(0);

    let finished = false;
    const done = exe.shutdown().then(() => {
      finished = true;
    });
    await jest.advanceTimersByTimeAsync(3_000);
    await done;

    expect(finished).toBe(true);
  });

  it('sends from the background timer once a window has gone idle — no shutdown needed', async () => {
    jest.useFakeTimers();
    const exe = makeClient();
    await exe.enforcePolicy({ agentId: 'agent-1', input: 'x' });
    expect(reports()).toHaveLength(0);

    // Past the 60s idle gap and at least one 10s timer tick.
    await jest.advanceTimersByTimeAsync(80_000);

    expect(allWindows()).toHaveLength(1);
    await exe.shutdown();
  });

  it('keeps an unacknowledged window and retries it after a failed send', async () => {
    jest.useFakeTimers();
    let attempts = 0;
    reportHandler = async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('down');
      return { status: 200 };
    };
    const exe = makeClient();
    await exe.enforcePolicy({ agentId: 'agent-1', input: 'x' });

    await jest.advanceTimersByTimeAsync(80_000); // first attempt fails
    await jest.advanceTimersByTimeAsync(60_000); // past the backoff: second attempt lands

    const bodies = reports();
    expect(bodies.length).toBeGreaterThanOrEqual(2);
    // Same window, same idempotency key — safe for the server to dedupe.
    expect(bodies[1].windows[0].windowId).toBe(bodies[0].windows[0].windowId);
    await exe.shutdown();
  });
});
