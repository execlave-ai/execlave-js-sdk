/**
 * Workload identity federation in the SDK: the credential source (cache,
 * single-flight, refresh, validation) and the client wiring (config guards,
 * registerAgent without POST /agents, bearer and signing, outage vs refusal).
 */

const mockRequest = jest.fn();
jest.mock('../http', () => ({
  request: mockRequest,
}));

// socket.io-client is an optional peer dependency the client require()s lazily.
const mockSocket = { on: jest.fn(), connect: jest.fn(), disconnect: jest.fn() };
const mockIo = jest.fn(() => mockSocket);
jest.mock('socket.io-client', () => ({ io: mockIo }));

import { Execlave } from '../client';
import { FederatedCredentialSource, type ExchangedCredential } from '../credentialProvider';
import { ExeclaveAuthError, ExeclaveError } from '../errors';

const AGENT_UUID = '11111111-2222-4333-8444-555555555555';
const OTHER_UUID = '99999999-2222-4333-8444-555555555555';
// Shaped like a compact JWS; never a real token.
const IDP_TOKEN = 'aaa.bbb.ccc';

function credential(n: number, expiresInMs = 15 * 60_000, agentId = AGENT_UUID): ExchangedCredential {
  return {
    credential: `exe_agt_test${n}`,
    expiresAt: new Date(Date.now() + expiresInMs).toISOString(),
    agentId,
  };
}

describe('FederatedCredentialSource', () => {
  it('exchanges once for concurrent callers and then serves the cache', async () => {
    const provider = jest.fn().mockResolvedValue(IDP_TOKEN);
    const exchange = jest.fn().mockResolvedValue(credential(1));
    const source = new FederatedCredentialSource({ provider, exchange });

    const [a, b, c] = await Promise.all([source.get(), source.get(), source.get()]);
    expect(a).toBe(b);
    expect(b).toBe(c);
    await source.get();

    expect(provider).toHaveBeenCalledTimes(1);
    expect(exchange).toHaveBeenCalledTimes(1);
    expect(exchange).toHaveBeenCalledWith(IDP_TOKEN);
    expect(source.boundAgentId).toBe(AGENT_UUID);
  });

  it('exchanges again once less than refreshBeforeMs is left', async () => {
    let now = 1_000_000;
    const exchange = jest
      .fn()
      .mockResolvedValueOnce({ credential: 'exe_agt_a', expiresAt: new Date(now + 120_000).toISOString(), agentId: AGENT_UUID })
      .mockResolvedValueOnce({ credential: 'exe_agt_b', expiresAt: new Date(now + 900_000).toISOString(), agentId: AGENT_UUID });
    const source = new FederatedCredentialSource({
      provider: () => IDP_TOKEN,
      exchange,
      now: () => now,
    });

    expect((await source.get()).credential).toBe('exe_agt_a');
    now += 59_000; // 61 s left: still cached
    expect((await source.get()).credential).toBe('exe_agt_a');
    now += 2_000; // 59 s left: refresh
    expect((await source.get()).credential).toBe('exe_agt_b');
    expect(exchange).toHaveBeenCalledTimes(2);
  });

  it('surfaces a failed exchange and tries again on the next call', async () => {
    const exchange = jest
      .fn()
      .mockRejectedValueOnce(new ExeclaveError('Network error: ECONNRESET'))
      .mockResolvedValueOnce(credential(2));
    const source = new FederatedCredentialSource({ provider: () => IDP_TOKEN, exchange });

    await expect(source.get()).rejects.toThrow('ECONNRESET');
    expect((await source.get()).credential).toBe('exe_agt_test2');
  });

  it.each([
    ['a credential without the exe_agt_ prefix', { ...credential(1), credential: 'exe_prod_key' }],
    ['no agentId', { ...credential(1), agentId: '' }],
    ['an unparseable expiry', { ...credential(1), expiresAt: 'soon' }],
    ['no body', undefined],
  ])('refuses an exchange answer with %s', async (_label, answer) => {
    const source = new FederatedCredentialSource({
      provider: () => IDP_TOKEN,
      exchange: jest.fn().mockResolvedValue(answer),
    });
    await expect(source.get()).rejects.toThrow('unexpected response');
  });

  it('refuses an empty token from the provider without calling the exchange', async () => {
    const exchange = jest.fn();
    const source = new FederatedCredentialSource({ provider: () => '', exchange });
    await expect(source.get()).rejects.toThrow('credentialProvider returned no token');
    expect(exchange).not.toHaveBeenCalled();
  });

  it('stops when the identity is rebound to a different agent', async () => {
    let now = 1_000_000;
    const exchange = jest
      .fn()
      .mockResolvedValueOnce({ credential: 'exe_agt_a', expiresAt: new Date(now + 120_000).toISOString(), agentId: AGENT_UUID })
      .mockResolvedValueOnce({ credential: 'exe_agt_b', expiresAt: new Date(now + 900_000).toISOString(), agentId: OTHER_UUID });
    const source = new FederatedCredentialSource({ provider: () => IDP_TOKEN, exchange, now: () => now });

    await source.get();
    now += 100_000;
    await expect(source.get()).rejects.toBeInstanceOf(ExeclaveAuthError);
    expect(source.boundAgentId).toBe(AGENT_UUID);
  });
});

// ---------------------------------------------------------------------------
// Client wiring
// ---------------------------------------------------------------------------

type Req = { method: string; url: string; headers?: Record<string, string>; body?: any; sign?: { key: string } };

/** Route mocked requests by path; record every call. */
function route(handlers: Record<string, (req: Req) => { status: number; data: unknown }>): Req[] {
  const calls: Req[] = [];
  mockRequest.mockImplementation(async (req: Req) => {
    calls.push(req);
    const path = new URL(req.url).pathname;
    const handler = Object.entries(handlers).find(([suffix]) => path.endsWith(suffix))?.[1];
    if (!handler) throw new Error(`unexpected request ${req.method} ${path}`);
    return handler(req);
  });
  return calls;
}

const exchangeOk = () => ({ status: 201, data: { data: credential(1) } });

function federatedClient(overrides: Record<string, unknown> = {}): Execlave {
  return new Execlave({
    credentialProvider: () => IDP_TOKEN,
    baseUrl: 'http://localhost:4000',
    asyncMode: false,
    enableControlChannel: false,
    ...overrides,
  } as any);
}

describe('Execlave with credentialProvider', () => {
  const savedKey = process.env.EXECLAVE_API_KEY;
  afterEach(() => {
    mockRequest.mockReset();
    if (savedKey === undefined) delete process.env.EXECLAVE_API_KEY;
    else process.env.EXECLAVE_API_KEY = savedKey;
  });

  describe('configuration', () => {
    it('refuses an apiKey together with a credentialProvider', () => {
      expect(() => federatedClient({ apiKey: 'exe_prod_x' })).toThrow('not both');
    });

    it('ignores EXECLAVE_API_KEY from the environment', async () => {
      process.env.EXECLAVE_API_KEY = 'exe_prod_from_env';
      const calls = route({
        '/agent-credentials/exchange': exchangeOk,
        '/policies/enforce': () => ({ status: 200, data: { allowed: true } }),
      });
      const exe = federatedClient();
      await exe.enforcePolicy({ agentId: AGENT_UUID, input: 'hi' });
      expect(JSON.stringify(calls)).not.toContain('exe_prod_from_env');
    });

    it('refuses OTLP mode, whose exporter needs an API key', () => {
      expect(() => federatedClient({ mode: 'otlp', otlpEndpoint: 'http://localhost:4317' })).toThrow(
        'otlp',
      );
    });
  });

  describe('registerAgent', () => {
    it('names the bound agent without creating one', async () => {
      const calls = route({ '/agent-credentials/exchange': exchangeOk });
      const exe = federatedClient();

      const agent = await exe.registerAgent({ agentId: 'support-bot', name: 'Support bot' });

      expect(agent.id).toBe(AGENT_UUID);
      expect(agent.agentId).toBe('support-bot');
      expect(calls).toHaveLength(1);
      expect(calls[0].body).toEqual({ token: IDP_TOKEN });
      // The exchange is unauthenticated: the token is the proof.
      expect(calls[0].headers?.Authorization).toBeUndefined();
      expect(await exe.registerAgent({ agentId: 'support-bot', name: 'Support bot' })).toBe(agent);
    });

    it('refuses a second agent name, since one client is one agent', async () => {
      route({ '/agent-credentials/exchange': exchangeOk });
      const exe = federatedClient();
      await exe.registerAgent({ agentId: 'support-bot', name: 'Support bot' });
      await expect(exe.registerAgent({ agentId: 'billing-bot', name: 'Billing' })).rejects.toThrow(
        "already registered as 'support-bot'",
      );
    });
  });

  describe('enforcePolicy', () => {
    it('sends the credential as bearer, the agent UUID, and signs with the credential', async () => {
      const calls = route({
        '/agent-credentials/exchange': exchangeOk,
        '/policies/enforce': () => ({ status: 200, data: { allowed: true } }),
      });
      const exe = federatedClient({ signRequests: true });
      await exe.registerAgent({ agentId: 'support-bot', name: 'Support bot' });

      const result = await exe.enforcePolicy({ agentId: 'support-bot', input: 'hi' });

      expect(result.allowed).toBe(true);
      const enforce = calls.find((c) => c.url.endsWith('/policies/enforce'))!;
      expect(enforce.headers?.Authorization).toBe('Bearer exe_agt_test1');
      expect(enforce.body.agentId).toBe(AGENT_UUID);
      expect(enforce.sign).toEqual({ key: 'exe_agt_test1' });
    });

    it('does not fail open when the exchange refuses the token', async () => {
      route({
        '/agent-credentials/exchange': () => ({
          status: 401,
          data: { error: { message: 'Federation token rejected' } },
        }),
      });
      const onEnforcementBypassed = jest.fn();
      const exe = federatedClient({ onEnforcementBypassed });

      await expect(exe.enforcePolicy({ agentId: AGENT_UUID, input: 'hi' })).rejects.toBeInstanceOf(
        ExeclaveAuthError,
      );
      expect(onEnforcementBypassed).not.toHaveBeenCalled();
    });

    it('treats an unavailable exchange as an outage under fail_open', async () => {
      route({ '/agent-credentials/exchange': () => ({ status: 503, data: {} }) });
      const onEnforcementBypassed = jest.fn();
      const exe = federatedClient({ onEnforcementBypassed });

      const result = await exe.enforcePolicy({ agentId: AGENT_UUID, input: 'hi' });

      expect(result).toMatchObject({ allowed: true, source: 'fail_open_network_error' });
      expect(onEnforcementBypassed).toHaveBeenCalledTimes(1);
    });

    it('blocks on an unavailable exchange under fail_closed', async () => {
      route({ '/agent-credentials/exchange': () => ({ status: 503, data: {} }) });
      const exe = federatedClient({ enforcementOnOutage: 'fail_closed' });
      await expect(exe.enforcePolicy({ agentId: AGENT_UUID, input: 'hi' })).rejects.toThrow(
        'unavailable',
      );
    });
  });

  it('sends traces with the agent UUID so ingest matches them to the credential', async () => {
    const calls = route({
      '/agent-credentials/exchange': exchangeOk,
      '/traces/ingest': () => ({ status: 201, data: { data: { accepted: 1 } } }),
    });
    const exe = federatedClient();
    await exe.registerAgent({ agentId: 'support-bot', name: 'Support bot' });

    exe.startTrace({ agentId: 'support-bot' }).setInput('q').setOutput('a').finish();
    await exe.flush();

    const ingest = calls.find((c) => c.url.endsWith('/traces/ingest'))!;
    expect(ingest.headers?.Authorization).toBe('Bearer exe_agt_test1');
    expect(ingest.body.traces[0]).toMatchObject({ agentId: 'support-bot', agentUuid: AGENT_UUID });
  });

  it('reports bypass windows under the agent UUID, authenticated with the credential', async () => {
    const calls = route({
      '/agent-credentials/exchange': exchangeOk,
      '/policies/enforce': () => {
        throw new ExeclaveError('Network error: ECONNRESET');
      },
      '/sdk/bypass-windows': () => ({ status: 200, data: { accepted: 1 } }),
    });
    const exe = federatedClient({ reportBypassesToPlatform: undefined });
    await exe.registerAgent({ agentId: 'support-bot', name: 'Support bot' });

    const result = await exe.enforcePolicy({ agentId: 'support-bot', input: 'hi' });
    expect(result.allowed).toBe(true);
    await exe.shutdown();

    const report = calls.find((c) => c.url.endsWith('/sdk/bypass-windows'))!;
    expect(report.headers?.Authorization).toBe('Bearer exe_agt_test1');
    expect(report.body.windows[0]).toMatchObject({ agentId: AGENT_UUID, reason: 'network_error' });
  });

  describe('WebSocket control channel', () => {
    beforeEach(() => {
      mockIo.mockClear();
      mockSocket.on.mockReset();
      mockSocket.connect.mockReset();
    });

    const handler = (event: string) =>
      mockSocket.on.mock.calls.find(([name]) => name === event)?.[1] as (...a: any[]) => void;

    it('authenticates each handshake with a current agent credential, never an API key', async () => {
      route({ '/agent-credentials/exchange': exchangeOk });
      const exe = federatedClient({ enableControlChannel: true });

      const opts = (mockIo.mock.calls[0] as any[])[1];
      expect(typeof opts.auth).toBe('function');
      const auth = await new Promise((resolve) => opts.auth(resolve));
      expect(auth).toEqual({ agentCredential: 'exe_agt_test1' });
      await exe.shutdown();
    });

    it('reconnects after the server closes the socket at credential expiry', async () => {
      route({ '/agent-credentials/exchange': exchangeOk });
      const exe = federatedClient({ enableControlChannel: true });

      handler('disconnect')('io server disconnect');
      expect(mockSocket.connect).toHaveBeenCalledTimes(1);
      handler('disconnect')('transport close'); // the client retries these itself
      expect(mockSocket.connect).toHaveBeenCalledTimes(1);
      await exe.shutdown();
    });

    it('answers the handshake without a credential when none can be had', async () => {
      route({ '/agent-credentials/exchange': () => ({ status: 401, data: {} }) });
      const exe = federatedClient({ enableControlChannel: true });

      const opts = (mockIo.mock.calls[0] as any[])[1];
      expect(await new Promise((resolve) => opts.auth(resolve))).toEqual({});
      await exe.shutdown();
    });
  });

  it('pings /health without exchanging a credential', async () => {
    const calls = route({ '/health': () => ({ status: 200, data: { status: 'ok' } }) });
    const exe = federatedClient();
    expect(await exe.ping()).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].headers).toEqual({});
  });
});
