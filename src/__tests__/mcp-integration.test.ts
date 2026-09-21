/**
 * Tests for the MCP client integration. Duck-typed — no MCP SDK needed.
 */

import {
  PolicyBlockedError,
  CertificateMismatchError,
  ApprovalVerificationError,
} from '../errors';
import { instrumentMcpClient } from '../integrations/mcp';

function makeExe() {
  const baseTrace = {
    setInput: jest.fn().mockReturnThis(),
    setOutput: jest.fn().mockReturnThis(),
    setModel: jest.fn().mockReturnThis(),
    setTokens: jest.fn().mockReturnThis(),
    addMetadata: jest.fn().mockReturnThis(),
    finish: jest.fn(),
  };
  return {
    enforcePolicy: jest.fn().mockResolvedValue({ allowed: true }),
    startTrace: jest.fn((opts: any) => ({
      ...baseTrace,
      traceId: opts?.traceId ?? `tr_${Math.random()}`,
    })),
  } as any;
}

function makeMcp(result: any | Error) {
  const callTool = jest.fn(async (..._args: any[]) => {
    if (result instanceof Error) throw result;
    return result;
  });
  return { callTool };
}

describe('instrumentMcpClient', () => {
  it('requires a client', () => {
    expect(() => instrumentMcpClient(undefined as any, makeExe(), { agentId: 'b' })).toThrow();
  });

  it('requires agentId', () => {
    expect(() => instrumentMcpClient(makeMcp({}), makeExe(), { agentId: '' })).toThrow();
  });

  it('rejects a client without callTool', () => {
    expect(() => instrumentMcpClient({} as any, makeExe(), { agentId: 'b' })).toThrow(TypeError);
  });

  it('enforces with tool allowlist (object request)', async () => {
    const exe = makeExe();
    const mcp = makeMcp({ content: [{ text: 'ok' }] });
    instrumentMcpClient(mcp, exe, { agentId: 'bot' });
    await mcp.callTool({ name: 'search', arguments: { q: 'x' } });
    expect(exe.enforcePolicy).toHaveBeenCalledWith(
      expect.objectContaining({ tools: ['search'], agentId: 'bot' }),
    );
  });

  it('enforces with positional (name, args) shape', async () => {
    const exe = makeExe();
    const mcp = makeMcp({ content: [{ text: 'ok' }] });
    instrumentMcpClient(mcp, exe, { agentId: 'bot' });
    await mcp.callTool('search', { q: 'x' });
    expect(exe.enforcePolicy).toHaveBeenCalledWith(
      expect.objectContaining({ tools: ['search'] }),
    );
  });

  it('seals the full untruncated tool arguments into metadata', async () => {
    // `input` (safeStr) truncates at 4000 chars for policy/classifier read.
    // The certificate's digest must cover the WHOLE sealed action context —
    // metadata is never truncated — so a large argument blob's tail is still
    // bound: a change past input's truncation point must invalidate the
    // certificate, not silently escape it.
    const exe = makeExe();
    const mcp = makeMcp({ content: [{ text: 'ok' }] });
    instrumentMcpClient(mcp, exe, { agentId: 'bot' });
    const bigArgs = { q: 'x'.repeat(5000) };
    await mcp.callTool({ name: 'search', arguments: bigArgs });
    expect(exe.enforcePolicy).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: { toolArguments: bigArgs } }),
    );
  });

  it('sanitizes non-serializable tool arguments instead of letting them fail-open at the HTTP layer', async () => {
    // Regression: sealing raw args verbatim risked a circular ref / BigInt
    // reaching JSON.stringify inside the HTTP layer. That throw is caught by
    // enforcePolicy's network-error handler (indistinguishable from a real
    // outage) and, under the default fail_open policy, silently ALLOWS the
    // call — every time, for that payload shape, not just on a transient
    // blip. The adapter must sanitize before calling enforcePolicy so this
    // never reaches the network layer at all.
    const exe = makeExe();
    const mcp = makeMcp({ content: [{ text: 'ok' }] });
    instrumentMcpClient(mcp, exe, { agentId: 'bot' });

    const circular: Record<string, unknown> = { cmd: 'wire_funds' };
    circular.self = circular;

    await mcp.callTool({ name: 'wire_funds', arguments: circular });

    expect(exe.enforcePolicy).toHaveBeenCalledTimes(1);
    const sentPayload = (exe.enforcePolicy as jest.Mock).mock.calls[0][0];
    // Whatever was sent must itself be JSON-serializable (the real risk
    // surface) — this call throwing would fail the test.
    expect(() => JSON.stringify(sentPayload)).not.toThrow();
    expect(sentPayload.metadata).toBeDefined();
  });

  it('blocks before forwarding when policy denies', async () => {
    const exe = makeExe();
    exe.enforcePolicy = jest
      .fn()
      .mockRejectedValue(new PolicyBlockedError([{ policyType: 'tool', message: 'no' }] as any));
    const mcp = makeMcp({ content: [] });
    const originalSpy = mcp.callTool;
    instrumentMcpClient(mcp, exe, { agentId: 'bot' });
    await expect(
      mcp.callTool({ name: 'rm_rf', arguments: { path: '/' } }),
    ).rejects.toBeInstanceOf(PolicyBlockedError);
    // Underlying spy never invoked because enforce threw first.
    expect(originalSpy).not.toHaveBeenCalled();
  });

  it('blocks before forwarding on post-approval drift (CertificateMismatchError)', async () => {
    // Regression: this error was missing from the adapter's enforcement-error
    // allowlist, so a drift rejection was swallowed as "non-fatal" and the tool
    // call went through anyway — fail-open on the exact case the certificate
    // binding exists to catch.
    const exe = makeExe();
    exe.enforcePolicy = jest
      .fn()
      .mockRejectedValue(new CertificateMismatchError('apr_1', 'action_context_mismatch'));
    const mcp = makeMcp({ content: [] });
    const originalSpy = mcp.callTool;
    instrumentMcpClient(mcp, exe, { agentId: 'bot' });

    await expect(mcp.callTool({ name: 'wire_funds', arguments: { amount: 999999 } })).rejects.toBeInstanceOf(
      CertificateMismatchError,
    );
    expect(originalSpy).not.toHaveBeenCalled();
  });

  it('blocks before forwarding when the certificate cannot be verified at all', async () => {
    const exe = makeExe();
    exe.enforcePolicy = jest
      .fn()
      .mockRejectedValue(new ApprovalVerificationError('apr_1', 'ECONNRESET'));
    const mcp = makeMcp({ content: [] });
    const originalSpy = mcp.callTool;
    instrumentMcpClient(mcp, exe, { agentId: 'bot' });

    await expect(mcp.callTool({ name: 'wire_funds', arguments: {} })).rejects.toBeInstanceOf(
      ApprovalVerificationError,
    );
    expect(originalSpy).not.toHaveBeenCalled();
  });

  it('still swallows genuinely transient enforcement failures (fail-open preserved)', async () => {
    // Not a governance decision — a transport blip talking to Execlave. The
    // adapter should log and continue, otherwise every Execlave hiccup becomes
    // an agent outage.
    const exe = makeExe();
    exe.enforcePolicy = jest.fn().mockRejectedValue(new Error('socket hang up'));
    const mcp = makeMcp({ content: [{ text: 'ok' }] });
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    instrumentMcpClient(mcp, exe, { agentId: 'bot' });

    await expect(mcp.callTool({ name: 'search', arguments: {} })).resolves.toBeDefined();
    warn.mockRestore();
  });

  it('is idempotent', () => {
    const exe = makeExe();
    const mcp = makeMcp({ content: [] });
    instrumentMcpClient(mcp, exe, { agentId: 'bot', enforce: false });
    const first = mcp.callTool;
    instrumentMcpClient(mcp, exe, { agentId: 'bot', enforce: false });
    expect(mcp.callTool).toBe(first);
  });

  it('marks span as error when isError is true', async () => {
    const exe = makeExe();
    const mcp = makeMcp({ content: [{ text: 'oops' }], isError: true });
    instrumentMcpClient(mcp, exe, { agentId: 'bot', enforce: false });
    await mcp.callTool({ name: 't', arguments: {} });
    const trace = (exe.startTrace as jest.Mock).mock.results[0].value;
    expect((trace.finish as jest.Mock).mock.calls[0][0]).toBe('error');
  });

  it('propagates underlying exceptions and marks span error', async () => {
    const exe = makeExe();
    const mcp = makeMcp(new Error('transport gone'));
    instrumentMcpClient(mcp, exe, { agentId: 'bot', enforce: false });
    await expect(mcp.callTool({ name: 't' })).rejects.toThrow('transport gone');
    const trace = (exe.startTrace as jest.Mock).mock.results[0].value;
    expect(trace.finish).toHaveBeenCalledWith('error', 'transport gone', 'Error');
  });
});
