import {
  truncateForClassifier,
  sealForMetadata,
  sealMetadataEntry,
  sealMetadata,
  sealFullRequest,
  enforcePolicyBound,
} from '../integrations/_actionBinding';
import { MetadataContractError } from '../errors';

function makeExe() {
  return { enforcePolicy: jest.fn().mockResolvedValue({ allowed: true }) } as any;
}

describe('truncateForClassifier', () => {
  it('returns null for null/undefined', () => {
    expect(truncateForClassifier(null)).toBeNull();
    expect(truncateForClassifier(undefined)).toBeNull();
  });

  it('passes a string through untouched below the limit', () => {
    expect(truncateForClassifier('hello')).toBe('hello');
  });

  it('truncates at the given limit', () => {
    const big = 'x'.repeat(5000);
    expect(truncateForClassifier(big)?.length).toBe(4000);
    expect(truncateForClassifier(big, 10)?.length).toBe(10);
  });

  it('JSON-stringifies a non-string value', () => {
    expect(truncateForClassifier({ q: 'x' })).toBe('{"q":"x"}');
  });

  it('returns null (not throw) for a circular reference', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(truncateForClassifier(circular)).toBeNull();
  });
});

describe('sealForMetadata', () => {
  it('returns undefined for null/undefined', () => {
    expect(sealForMetadata(null)).toBeUndefined();
    expect(sealForMetadata(undefined)).toBeUndefined();
  });

  it('round-trips a plain value unchanged', () => {
    const value = { a: 1, b: ['x', 'y'], c: { nested: true } };
    expect(sealForMetadata(value)).toEqual(value);
  });

  it('never throws — replaces only the circular field, not the whole value', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => sealForMetadata(circular)).not.toThrow();
    expect(sealForMetadata(circular)).toEqual({ self: '[unserializable:circular]' });
  });

  it('the fallback itself is JSON-serializable', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => JSON.stringify(sealForMetadata(circular))).not.toThrow();
  });

  it('isolates a single bad field instead of collapsing the whole object', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const value = { good: 'kept', model: 'gpt-4o', bad: circular };
    expect(sealForMetadata(value)).toEqual({
      good: 'kept',
      model: 'gpt-4o',
      bad: { self: '[unserializable:circular]' },
    });
  });

  it('marks function/symbol/bigint fields explicitly instead of dropping them', () => {
    const value = { cb: () => {}, sym: Symbol('x'), big: BigInt(1), fine: 'ok' };
    expect(sealForMetadata(value)).toEqual({
      cb: '[unserializable:function]',
      sym: '[unserializable:symbol]',
      big: '[unserializable:bigint]',
      fine: 'ok',
    });
  });

  it('marks a nested undefined field instead of silently dropping the key (unlike JSON.stringify)', () => {
    expect(sealForMetadata({ a: undefined, b: 1 })).toEqual({
      a: '[unserializable:undefined]',
      b: 1,
    });
  });

  it('serializes Date to ISO string and marks Map/Set explicitly', () => {
    const d = new Date('2026-01-01T00:00:00.000Z');
    expect(sealForMetadata({ when: d, m: new Map(), s: new Set() })).toEqual({
      when: '2026-01-01T00:00:00.000Z',
      m: '[unserializable:Map]',
      s: '[unserializable:Set]',
    });
  });

  it('does not falsely flag the same object referenced by two siblings as circular', () => {
    const shared = { q: 'x' };
    expect(sealForMetadata({ a: shared, b: shared })).toEqual({
      a: { q: 'x' },
      b: { q: 'x' },
    });
  });
});

describe('sealFullRequest', () => {
  it('seals every own field by default, not a hand-picked subset', () => {
    const params = { model: 'gpt-4o', messages: [], tools: [{ type: 'function' }], temperature: 0.2 };
    expect(sealFullRequest(params)).toEqual(params);
  });

  it('strips only explicitly named exclusions', () => {
    const params = { model: 'gpt-4o', signal: () => {}, temperature: 0.2 };
    expect(sealFullRequest(params, ['signal'])).toEqual({ model: 'gpt-4o', temperature: 0.2 });
  });

  it('returns an empty sealed object for a non-object request', () => {
    expect(sealFullRequest(null)).toEqual({});
    expect(sealFullRequest(undefined)).toEqual({});
  });

  it('produces a branded SealedMetadata value usable by enforcePolicyBound', async () => {
    const exe = { enforcePolicy: jest.fn().mockResolvedValue({ allowed: true }) } as any;
    const metadata = sealFullRequest({ model: 'gpt-4o' });
    await enforcePolicyBound(exe, { agentId: 'a1', input: 'hi', metadata });
    expect(exe.enforcePolicy).toHaveBeenCalledWith(expect.objectContaining({ metadata }));
  });
});

describe('sealMetadataEntry', () => {
  it('returns undefined when there is nothing to seal', () => {
    expect(sealMetadataEntry('key', null)).toBeUndefined();
    expect(sealMetadataEntry('key', undefined)).toBeUndefined();
  });

  it('wraps a sealed value under the given key', () => {
    expect(sealMetadataEntry('toolArguments', { q: 'x' })).toEqual({
      toolArguments: { q: 'x' },
    });
  });

  it('is JSON-serializable even for a circular input', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const entry = sealMetadataEntry('toolArguments', circular);
    expect(() => JSON.stringify(entry)).not.toThrow();
  });
});

describe('sealMetadata', () => {
  it('seals a hand-built object combining plain and structured fields', () => {
    const sealed = sealMetadata({ model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] });
    expect(sealed).toEqual({ model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] });
  });

  it('falls back to a safe marker for a circular reference, never throws', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => sealMetadata({ payload: circular })).not.toThrow();
    expect(() => JSON.stringify(sealMetadata({ payload: circular }))).not.toThrow();
  });
});

describe('enforcePolicyBound', () => {
  it('forwards a sealMetadataEntry result to exe.enforcePolicy', async () => {
    const exe = makeExe();
    const metadata = sealMetadataEntry('toolArguments', { q: 'x' });
    await enforcePolicyBound(exe, { agentId: 'a1', input: 'tool:search', metadata });
    expect(exe.enforcePolicy).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: 'a1', input: 'tool:search', metadata }),
    );
  });

  it('forwards a sealMetadata result to exe.enforcePolicy', async () => {
    const exe = makeExe();
    const metadata = sealMetadata({ model: 'gpt-4o', messages: [] });
    await enforcePolicyBound(exe, { agentId: 'a1', input: 'hi', metadata });
    expect(exe.enforcePolicy).toHaveBeenCalledWith(expect.objectContaining({ metadata }));
  });

  it('allows undefined metadata through untouched', async () => {
    const exe = makeExe();
    await enforcePolicyBound(exe, { agentId: 'a1', input: 'hi' });
    expect(exe.enforcePolicy).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: 'a1', input: 'hi' }),
    );
  });

  it('throws MetadataContractError for an unsealed object literal, without calling exe.enforcePolicy', async () => {
    const exe = makeExe();
    await expect(
      enforcePolicyBound(exe, {
        agentId: 'a1',
        input: 'hi',
        metadata: { q: 'x' } as any,
      }),
    ).rejects.toBeInstanceOf(MetadataContractError);
    expect(exe.enforcePolicy).not.toHaveBeenCalled();
  });
});
