import { ExeclaveCallbackHandler, resolveParentRunId } from '../integrations/langchain';

/**
 * LangChain reordered `handleChainStart`'s trailing parameters between major
 * versions:
 *
 *   0.3.x  (chain, inputs, runId, parentRunId?, tags?, metadata?, runType?, runName?)
 *   1.x    (chain, inputs, runId, runType?, tags?, metadata?, runName?, parentRunId?, extra?)
 *
 * The handler previously bound `parentRunId` to the 4th position. Under 1.x
 * that slot holds `runType` — the string "chain" — so `!parentRunId` was false
 * for every root chain and chain-level enforcement silently stopped running,
 * while spans were parented to a run id that does not exist.
 *
 * The peer range now admits 1.x, so both call shapes must behave identically.
 */

const UUID_A = '11111111-2222-4333-8444-555555555555';
const UUID_B = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';

describe('resolveParentRunId', () => {
  it('reads the 0.3 position', () => {
    // (parentRunId, tags, metadata, runType, runName)
    expect(resolveParentRunId([UUID_A, [], {}, 'chain', 'MyChain'])).toBe(UUID_A);
  });

  it('reads the 1.x position', () => {
    // (runType, tags, metadata, runName, parentRunId, extra)
    expect(resolveParentRunId(['chain', [], {}, 'MyChain', UUID_B, {}])).toBe(UUID_B);
  });

  it('returns undefined for a root chain in either version', () => {
    expect(resolveParentRunId([undefined, [], {}, 'chain', 'MyChain'])).toBeUndefined();
    expect(resolveParentRunId(['chain', [], {}, 'MyChain', undefined, {}])).toBeUndefined();
  });

  it('never mistakes runType for a run id', () => {
    for (const runType of ['chain', 'llm', 'tool', 'retriever', 'parser']) {
      expect(resolveParentRunId([runType, [], {}, 'Name'])).toBeUndefined();
    }
  });

  it('supports non-UUID run ids in the 0.3 slot', () => {
    // Run ids are UUIDs in real LangChain, but the shape must not be load
    // bearing for the version the SDK has always supported.
    expect(resolveParentRunId(['r1', [], {}, 'chain', 'MyChain'])).toBe('r1');
  });

  it("never mistakes 0.3's runName for a 1.x parent id", () => {
    // 0.3 root chain: parentRunId undefined, runName occupies the slot that
    // 1.x uses for parentRunId. Reading it would suppress enforcement.
    expect(resolveParentRunId([undefined, [], {}, 'chain', 'MyChain'])).toBeUndefined();
  });
});

describe('handleChainStart enforces identically on 0.3 and 1.x call shapes', () => {
  function makeHandler() {
    const baseTrace = {
      setInput: jest.fn().mockReturnThis(),
      setOutput: jest.fn().mockReturnThis(),
      setModel: jest.fn().mockReturnThis(),
      setTokens: jest.fn().mockReturnThis(),
      addMetadata: jest.fn().mockReturnThis(),
      finish: jest.fn(),
    };
    const enforce = jest.fn().mockResolvedValue({ allowed: true });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const exe: any = {
      enforcePolicy: enforce,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      startTrace: jest.fn((opts: any) => ({
        ...baseTrace,
        traceId: opts?.traceId ?? `tr_${Math.random()}`,
      })),
    };
    const handler = new ExeclaveCallbackHandler(exe, {
      agentId: 'agent-1',
      enforce: true,
    });
    return { handler, enforce };
  }

  const CHAIN = { name: 'MyChain', id: ['MyChain'] };
  const INPUTS = { input: 'what is the weather' };

  it('enforces a ROOT chain under the 0.3 call shape', async () => {
    const { handler, enforce } = makeHandler();
    // 0.3: parentRunId is 4th and undefined for a root chain.
    await handler.handleChainStart(CHAIN, INPUTS, UUID_A, undefined, [], {}, 'chain', 'MyChain');
    expect(enforce).toHaveBeenCalledTimes(1);
  });

  it('enforces a ROOT chain under the 1.x call shape', async () => {
    const { handler, enforce } = makeHandler();
    // 1.x: 4th is runType ("chain"); parentRunId is 8th and absent.
    await handler.handleChainStart(CHAIN, INPUTS, UUID_A, 'chain', [], {}, 'MyChain', undefined, {});
    // Before the fix this was 0: "chain" was truthy, so the root-chain branch
    // never ran and the chain input was never enforced.
    expect(enforce).toHaveBeenCalledTimes(1);
  });

  it('does not double-enforce a CHILD chain under either shape', async () => {
    for (const args of [
      [CHAIN, INPUTS, UUID_B, UUID_A, [], {}, 'chain', 'Child'],
      [CHAIN, INPUTS, UUID_B, 'chain', [], {}, 'Child', UUID_A, {}],
    ] as const) {
      const { handler, enforce } = makeHandler();
      // Establish the parent as an enforced root first.
      await handler.handleChainStart(CHAIN, INPUTS, UUID_A);
      enforce.mockClear();
      await (handler.handleChainStart as (...a: unknown[]) => Promise<void>)(...args);
      expect(enforce).not.toHaveBeenCalled();
    }
  });
});
