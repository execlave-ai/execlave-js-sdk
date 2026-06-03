/**
 * Tests for the MCP client integration. Duck-typed — no MCP SDK needed.
 */

import { PolicyBlockedError } from '../errors';
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
