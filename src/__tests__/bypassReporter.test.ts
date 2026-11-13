import { BypassWindowReporter, type BypassReportBody } from '../bypassReporter';

/**
 * The SDK defaults to fail_open, so an outage or an exhausted plan quota lets
 * actions proceed with no server enforcement decision. The callback surfaces that
 * locally; this reporter is what puts it on the server's audit trail, so "no
 * bypass record" stops reading as "fully governed".
 *
 * Bypasses are coalesced into windows — a per-call record would put thousands of
 * rows a minute into a per-org hash chain during an outage. Only CLOSED windows
 * are sent, so a window is immutable once reported.
 */

const IDLE = 60_000;
const MAX = 15 * 60_000;

let clock = Date.parse('2026-09-21T12:00:00.000Z');
let n = 0;
const advance = (ms: number) => {
  clock += ms;
};

type Send = jest.Mock<Promise<{ status: number }>, [BypassReportBody]>;

function make(
  send: Send,
  opts: Partial<ConstructorParameters<typeof BypassWindowReporter>[0]> = {},
) {
  return new BypassWindowReporter({
    send,
    sdk: { name: '@execlave/sdk', language: 'js', version: '1.8.0' },
    now: () => clock,
    uuid: () => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`,
    idleMs: IDLE,
    maxDurationMs: MAX,
    ...opts,
  });
}

const mk = (impl?: (b: BypassReportBody) => Promise<{ status: number }>): Send =>
  jest.fn<Promise<{ status: number }>, [BypassReportBody]>(impl);
const ok = (): Send => mk(async () => ({ status: 200 }));
const bypass = (over: Record<string, unknown> = {}) => ({
  reason: 'network_error' as const,
  source: 'fail_open_network_error',
  agentId: 'agent-1',
  ...over,
});

beforeEach(() => {
  clock = Date.parse('2026-09-21T12:00:00.000Z');
  n = 0;
});

describe('coalescing', () => {
  it('folds repeated bypasses for one agent+reason into a single window', async () => {
    const send = ok();
    const r = make(send);

    r.record(bypass({ message: 'first' }));
    advance(5_000);
    r.record(bypass({ message: 'last', status: 503 }));
    advance(IDLE);
    r.tick();
    await r.flush();

    expect(send).toHaveBeenCalledTimes(1);
    const [body] = send.mock.calls[0];
    expect(body.windows).toHaveLength(1);
    expect(body.windows[0]).toMatchObject({
      agentId: 'agent-1',
      reason: 'network_error',
      source: 'fail_open_network_error',
      count: 2,
      firstAt: '2026-09-21T12:00:00.000Z',
      lastAt: '2026-09-21T12:00:05.000Z',
      message: 'last',
      status: 503,
    });
  });

  it('keeps different agents and different reasons in separate windows', async () => {
    const send = ok();
    const r = make(send);

    r.record(bypass());
    r.record(bypass({ agentId: 'agent-2' }));
    r.record(bypass({ reason: 'plan_limit_exceeded', source: 'fail_open_plan_limit' }));
    advance(IDLE);
    r.tick();
    await r.flush();

    expect(send.mock.calls[0][0].windows).toHaveLength(3);
  });

  it('gives every window its own id — the idempotency key', async () => {
    const send = ok();
    const r = make(send);
    r.record(bypass());
    r.record(bypass({ agentId: 'agent-2' }));
    advance(IDLE);
    r.tick();
    await r.flush();

    const ids = send.mock.calls[0][0].windows.map((w) => w.windowId);
    expect(new Set(ids).size).toBe(2);
  });
});

describe('when a window closes', () => {
  it('does NOT send an open window — reported windows are immutable', async () => {
    const send = ok();
    const r = make(send);
    r.record(bypass());
    advance(10_000); // well inside the idle gap
    r.tick();
    await r.flush();

    expect(send).not.toHaveBeenCalled();
  });

  it('closes after an idle gap', async () => {
    const send = ok();
    const r = make(send);
    r.record(bypass());
    advance(IDLE);
    r.tick();
    await r.flush();

    expect(send).toHaveBeenCalledTimes(1);
  });

  it('starts a NEW window when a bypass arrives after the idle gap, closing the old one', async () => {
    const send = ok();
    const r = make(send);
    r.record(bypass());
    advance(IDLE + 1);
    r.record(bypass()); // no tick in between: record itself must notice
    advance(IDLE);
    r.tick();
    await r.flush();

    const ws = send.mock.calls[0][0].windows;
    expect(ws).toHaveLength(2);
    expect(ws.map((w) => w.count)).toEqual([1, 1]);
  });

  it('caps a window at the max duration so a long outage is many records, not one unbounded one', async () => {
    const send = ok();
    const r = make(send);
    // A bypass every 30s for 40 minutes — never idle, so only the duration cap can close it.
    for (let i = 0; i <= 80; i++) {
      r.record(bypass());
      advance(30_000);
    }
    advance(IDLE);
    r.tick();
    await r.flush();

    const ws = send.mock.calls.flatMap((c) => c[0].windows);
    expect(ws.length).toBeGreaterThanOrEqual(3);
    for (const w of ws) {
      expect(Date.parse(w.lastAt) - Date.parse(w.firstAt)).toBeLessThanOrEqual(MAX);
    }
    expect(ws.reduce((s, w) => s + w.count, 0)).toBe(81);
  });

  it("closes only that agent's windows when the agent gets a governed decision (recovery)", async () => {
    const send = ok();
    const r = make(send);
    r.record(bypass());
    r.record(bypass({ agentId: 'agent-2' }));

    r.recover('agent-1');
    await r.flush();

    const ws = send.mock.calls[0][0].windows;
    expect(ws.map((w) => w.agentId)).toEqual(['agent-1']);
  });
});

describe('sending', () => {
  it('sends the SDK identity and the client clock at send time', async () => {
    const send = ok();
    const r = make(send);
    r.record(bypass());
    r.recover('agent-1');
    advance(1_234);
    await r.flush();

    const [body] = send.mock.calls[0];
    expect(body.sdk).toEqual({ name: '@execlave/sdk', language: 'js', version: '1.8.0' });
    expect(body.sentAt).toBe(new Date(clock).toISOString());
  });

  it('does not send again once the windows are acknowledged', async () => {
    const send = ok();
    const r = make(send);
    r.record(bypass());
    r.recover('agent-1');
    await r.flush();
    await r.flush();

    expect(send).toHaveBeenCalledTimes(1);
  });

  it('sends at most 100 windows per request', async () => {
    const send = ok();
    const r = make(send);
    for (let i = 0; i < 230; i++) r.record(bypass({ agentId: `agent-${i}` }));
    advance(IDLE);
    r.tick();
    await r.flush({ force: true });

    expect(send.mock.calls.map((c) => c[0].windows.length)).toEqual([100, 100, 30]);
  });

  it('truncates fields to what the server accepts instead of having the whole report rejected', async () => {
    const send = ok();
    const r = make(send);
    r.record(
      bypass({ message: 'x'.repeat(2_000), agentId: 'a'.repeat(400), source: 's'.repeat(200) }),
    );
    r.recover('a'.repeat(256));
    r.tick();
    advance(IDLE);
    r.tick();
    await r.flush();

    const w = send.mock.calls[0][0].windows[0];
    expect(w.message!.length).toBeLessThanOrEqual(500);
    expect(w.agentId.length).toBeLessThanOrEqual(256);
    expect(w.source.length).toBeLessThanOrEqual(64);
  });

  it('never runs two sends at once', async () => {
    let release!: () => void;
    const send = mk(() => new Promise((res) => (release = () => res({ status: 200 }))));
    const r = make(send);
    r.record(bypass());
    r.recover('agent-1');

    const a = r.flush();
    const b = r.flush();
    release();
    await Promise.all([a, b]);

    expect(send).toHaveBeenCalledTimes(1);
  });
});

describe('failure: keep the evidence, retry, never spin', () => {
  it('keeps the window and retries with the SAME id when the network fails', async () => {
    const send: Send = jest
      .fn()
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockResolvedValue({ status: 200 });
    const r = make(send);
    r.record(bypass());
    r.recover('agent-1');

    await r.flush();
    await r.flush({ force: true });

    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1][0].windows[0].windowId).toBe(
      send.mock.calls[0][0].windows[0].windowId,
    );
    // Acknowledged now: nothing left.
    await r.flush({ force: true });
    expect(send).toHaveBeenCalledTimes(2);
  });

  it.each([500, 502, 503, 429, 408, 401, 403, 404])(
    'keeps the windows on HTTP %i (retryable, or nothing the SDK can fix by discarding)',
    async (status) => {
      const send: Send = jest.fn().mockResolvedValue({ status });
      const r = make(send);
      r.record(bypass());
      r.recover('agent-1');

      await r.flush();
      await r.flush({ force: true });

      expect(send).toHaveBeenCalledTimes(2);
    },
  );

  it.each([400, 413, 422])(
    'discards a window the server will never accept (HTTP %i) rather than resending it forever',
    async (status) => {
      const log = jest.fn();
      const send: Send = jest.fn().mockResolvedValue({ status });
      const r = make(send, { log });
      r.record(bypass());
      r.recover('agent-1');

      await r.flush();
      await r.flush({ force: true });

      expect(send).toHaveBeenCalledTimes(1);
      expect(log).toHaveBeenCalledWith(expect.stringContaining(String(status)));
    },
  );

  it('backs off: the timer-driven flush does not hammer a failing endpoint', async () => {
    const send: Send = jest.fn().mockRejectedValue(new Error('down'));
    const r = make(send);
    r.record(bypass());
    r.recover('agent-1');

    await r.flush(); // attempt 1 fails
    advance(1_000);
    await r.flush(); // inside the backoff — must not send
    expect(send).toHaveBeenCalledTimes(1);

    advance(5 * 60_000); // past any backoff
    await r.flush();
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('a forced flush (shutdown) ignores backoff', async () => {
    const send: Send = jest.fn().mockRejectedValue(new Error('down'));
    const r = make(send);
    r.record(bypass());
    r.recover('agent-1');
    await r.flush();

    await r.flush({ force: true });
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('never throws out of record/tick/flush, even if the transport throws synchronously', async () => {
    const send = jest.fn(() => {
      throw new Error('boom');
    }) as unknown as Send;
    const r = make(send);

    expect(() => r.record(bypass())).not.toThrow();
    r.recover('agent-1');
    expect(() => r.tick()).not.toThrow();
    await expect(r.flush()).resolves.toBeUndefined();
  });
});

describe('overflow states its own loss', () => {
  it('drops the oldest window past the cap and reports what was dropped', async () => {
    const send = ok();
    const r = make(send, { maxBufferedWindows: 3 });
    for (let i = 1; i <= 5; i++) {
      r.record(bypass({ agentId: `agent-${i}` }));
      r.record(bypass({ agentId: `agent-${i}` })); // count 2 each
      r.recover(`agent-${i}`);
    }

    await r.flush({ force: true });

    const [body] = send.mock.calls[0];
    expect(body.windows.map((w) => w.agentId)).toEqual(['agent-3', 'agent-4', 'agent-5']);
    // agent-1 and agent-2 were lost: 2 windows, 4 bypasses. The trail must say so.
    expect(body.dropped).toMatchObject({ windows: 2, bypasses: 4 });
    expect(body.dropped!.dropId).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.dropped!.since).toBe('2026-09-21T12:00:00.000Z');
  });

  it('keeps the same dropId across retries and clears it once acknowledged', async () => {
    const send: Send = jest
      .fn()
      .mockRejectedValueOnce(new Error('down'))
      .mockResolvedValue({ status: 200 });
    const r = make(send, { maxBufferedWindows: 1 });
    for (let i = 1; i <= 3; i++) {
      r.record(bypass({ agentId: `agent-${i}` }));
      r.recover(`agent-${i}`);
    }

    await r.flush({ force: true });
    await r.flush({ force: true });
    expect(send.mock.calls[1][0].dropped!.dropId).toBe(send.mock.calls[0][0].dropped!.dropId);

    await r.flush({ force: true });
    // Acknowledged: no further request, and no stale dropped block.
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('sends a loss-only report when nothing buffered survived', async () => {
    const send = ok();
    const r = make(send, { maxBufferedWindows: 0 });
    r.record(bypass());
    r.recover('agent-1');
    await r.flush({ force: true });

    const [body] = send.mock.calls[0];
    expect(body.windows).toEqual([]);
    expect(body.dropped).toMatchObject({ windows: 1, bypasses: 1 });
  });
});

describe('shutdown drain', () => {
  it('closes open windows and sends them', async () => {
    const send = ok();
    const r = make(send);
    r.record(bypass()); // still open, nowhere near idle
    await r.drain({ timeoutMs: 1_000 });

    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0].windows[0]).toMatchObject({ agentId: 'agent-1', count: 1 });
  });

  it('gives up after the deadline instead of hanging shutdown on a dead endpoint', async () => {
    const send = mk(() => new Promise(() => {}));
    const r = make(send);
    r.record(bypass());

    const started = Date.now();
    await r.drain({ timeoutMs: 60 });

    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('stops after a failed attempt rather than looping until the deadline', async () => {
    const send: Send = jest.fn().mockRejectedValue(new Error('down'));
    const r = make(send);
    r.record(bypass());

    await r.drain({ timeoutMs: 5_000 });

    expect(send).toHaveBeenCalledTimes(1);
  });
});

describe('only sends text the server can store', () => {
  // Postgres text/jsonb reject NUL and a lone UTF-16 surrogate. The server's audit
  // write would throw, which reads as a retryable 5xx — so one such character
  // would make that window fail on every retry and never be recorded.
  const HIGH = String.fromCharCode(0xd83d);
  const LOW = String.fromCharCode(0xde00);
  const EMOJI = HIGH + LOW;
  const NUL = String.fromCharCode(0);
  const REPLACEMENT = String.fromCharCode(0xfffd);
  const isLoneSurrogate = (s: string) =>
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(s);

  async function sentWindow(over: Record<string, unknown>) {
    const send = ok();
    const r = make(send);
    r.record(bypass(over));
    r.recover(String(over.agentId ?? 'agent-1'));
    await r.flush({ force: true });
    return send.mock.calls[0][0].windows[0];
  }

  it('does not leave half an emoji when the message is cut at the limit', async () => {
    const w = await sentWindow({ message: 'a'.repeat(499) + EMOJI });

    expect(w.message).toBe('a'.repeat(499));
    expect(isLoneSurrogate(w.message!)).toBe(false);
  });

  it('keeps a whole emoji that fits', async () => {
    const w = await sentWindow({ message: 'a'.repeat(498) + EMOJI });

    expect(w.message).toBe('a'.repeat(498) + EMOJI);
  });

  it('replaces NUL and stray surrogates already in the text', async () => {
    const w = await sentWindow({ message: `a${NUL}b${HIGH}c${LOW}d`, source: `s${NUL}` });

    expect(w.message).toBe(`a${REPLACEMENT}b${REPLACEMENT}c${REPLACEMENT}d`);
    expect(w.source).toBe(`s${REPLACEMENT}`);
  });

  it('sends an empty agent id as "unknown" — the server requires at least one character', async () => {
    const w = await sentWindow({ agentId: '' });

    expect(w.agentId).toBe('unknown');
  });

  it('keeps an empty-id window and a real one apart from each other', async () => {
    const send = ok();
    const r = make(send);
    r.record(bypass({ agentId: '' }));
    r.record(bypass({ agentId: 'agent-1' }));
    r.recover('');
    r.recover('agent-1');
    await r.flush({ force: true });

    expect(send.mock.calls[0][0].windows.map((w) => w.agentId).sort()).toEqual([
      'agent-1',
      'unknown',
    ]);
  });
});
