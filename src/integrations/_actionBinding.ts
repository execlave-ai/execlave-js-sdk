/**
 * Shared action-context binding helpers for framework adapters.
 *
 * Single source of truth for the truncate-for-classifier /
 * seal-for-metadata split every adapter uses when enforcing a policy on a
 * value that may be large or structured (tool arguments, chain inputs, a
 * message array, ...):
 *
 *   - `input` sent to `enforcePolicy` is a BOUNDED string — cheap to run a
 *     classifier/heuristic over, not a governance-complete record.
 *   - `metadata` must carry the FULL, untruncated, JSON-safe value — that is
 *     what the server's certificate digest actually covers in whole.
 *
 * Before this module existed, five adapters each hand-rolled their own copy
 * of this split. A prior real incident: two of those copies truncated the
 * value into `input` and sealed NOTHING else, so the certificate bound to a
 * 4000-char summary instead of the actual payload — a material field could
 * change past the truncation point without invalidating the certificate.
 * Consolidating to one module means there is exactly one place this logic
 * can be gotten right or wrong, instead of five, and
 * `actionBindingContract.test.ts` (JS) / `test_action_binding_contract.py`
 * (Python) fail the build if any adapter file reintroduces a local copy
 * instead of importing from here.
 *
 * Adapters MUST call `enforcePolicy` through `enforcePolicyBound` below, not
 * `exe.enforcePolicy` directly — its `metadata` parameter requires the
 * `SealedMetadata` brand, which only `sealForMetadata` / `sealMetadataEntry`
 * / `sealMetadata` can produce. Passing a hand-built object literal there is
 * a compile error, not a silent runtime gap. The public `Execlave.enforcePolicy`
 * API is untouched and still accepts a plain `Record<string, unknown>` —
 * that boundary is a direct customer supplying their own data, a different
 * trust relationship than an adapter translating a provider request.
 */

import type { Execlave } from '../client';
import type { EnforcePolicyOptions, EnforceResult } from '../types';
import { MetadataContractError } from '../errors';

const DEFAULT_LIMIT = 4000;

/** Runtime tag backing the compile-time brand — see `enforcePolicyBound`. */
const SEALED_TAG = Symbol.for('execlave.sealedMetadata');

/**
 * A `metadata` value that has passed through `sealForMetadata` /
 * `sealMetadataEntry` / `sealMetadata`. Nominal (branded) so a plain object
 * literal does not structurally satisfy it — the only way to get one is to
 * call one of those three functions.
 */
export type SealedMetadata = Record<string, unknown> & { readonly [SEALED_TAG]?: true };

function brand(value: Record<string, unknown>): SealedMetadata {
  Object.defineProperty(value, SEALED_TAG, { value: true, enumerable: false });
  return value as SealedMetadata;
}

/** True only for objects actually produced by this module's seal functions. */
function isSealed(value: unknown): value is SealedMetadata {
  return typeof value === 'object' && value !== null && (value as any)[SEALED_TAG] === true;
}

/**
 * Truncate a value to a bounded string for the `input` field. NOT
 * governance-complete on its own — pair with `sealForMetadata` for
 * anything that should be part of the certificate's binding in full.
 */
export function truncateForClassifier(value: unknown, limit = DEFAULT_LIMIT): string | null {
  if (value === null || value === undefined) return null;
  try {
    const s = typeof value === 'string' ? value : JSON.stringify(value);
    return s.slice(0, limit);
  } catch {
    return null;
  }
}

/**
 * Recursively sanitize a value into something JSON-safe, replacing only
 * the individual fields that cannot serialize instead of the whole value.
 *
 * A prior version of `sealForMetadata` caught JSON.stringify failure at the
 * TOP level only: one bad field anywhere in a large object (an AbortSignal,
 * a callback, a class instance a provider SDK attaches) collapsed the
 * ENTIRE sealed value to a fixed placeholder string. The certificate digest
 * still matched between issuance and re-execution — both times hashing the
 * same placeholder — so verification silently became a no-op for every
 * other field in that payload, not just the one that couldn't serialize.
 *
 * This also does NOT delegate to `JSON.stringify` for detection: a function,
 * Symbol, Map, or Set value doesn't throw there — `JSON.stringify` silently
 * DROPS it (an object key vanishes, an array element becomes `null`), which
 * is the exact material-field-omission failure mode this module exists to
 * prevent, just reproduced one level deeper. Every branch below is explicit
 * so nothing is dropped without leaving a marker in its place.
 */
function safeSerialize(value: unknown, seen: WeakSet<object> = new WeakSet()): unknown {
  if (value === undefined) return '[unserializable:undefined]';
  if (value === null) return null;
  const t = typeof value;
  if (t === 'string' || t === 'number' || t === 'boolean') return value;
  if (t === 'bigint') return '[unserializable:bigint]';
  if (t === 'function') return '[unserializable:function]';
  if (t === 'symbol') return '[unserializable:symbol]';

  const obj = value as object;
  if (seen.has(obj)) return '[unserializable:circular]';

  if (Array.isArray(obj)) {
    seen.add(obj);
    const out = (obj as unknown[]).map((v) => safeSerialize(v, seen));
    seen.delete(obj);
    return out;
  }
  if (obj instanceof Date) return obj.toISOString();
  if (obj instanceof Map || obj instanceof Set) return `[unserializable:${obj.constructor.name}]`;

  seen.add(obj);
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(obj as Record<string, unknown>)) {
    out[key] = safeSerialize((obj as Record<string, unknown>)[key], seen);
  }
  seen.delete(obj);
  return out;
}

/**
 * Validate a value is JSON-safe before it is embedded in `metadata`,
 * replacing any individual non-serializable field with a marker rather than
 * failing the whole value — see `safeSerialize` for why per-field, not
 * whole-object. A raw, unvalidated object here (a circular reference, a
 * BigInt, ...) would otherwise throw inside JSON.stringify at the HTTP
 * layer. That throw is caught by enforcePolicy's network-error handler
 * (indistinguishable from a real outage) and, under the default fail_open
 * policy, silently ALLOWS the call — a governance bypass that reproduces
 * on every single call with that payload shape, not a transient blip.
 */
export function sealForMetadata(value: unknown): unknown {
  if (value === undefined || value === null) return undefined;
  return safeSerialize(value);
}

/**
 * Seal the ACTUAL raw request object an adapter is about to hand the
 * provider SDK — every own-enumerable field, by default, not a hand-picked
 * subset. `exclude` strips named fields (transport-only concerns: an
 * AbortSignal, a streaming callback) and defaults to empty — start maximal,
 * add an exclusion only when a specific field demonstrably needs it.
 *
 * This exists because a hand-picked inclusion list (`{ model, messages }`)
 * silently stops covering a field the day the provider SDK adds one and the
 * adapter isn't updated — the certificate binds to less than what actually
 * executes, with no error, no test failure, nothing to notice. Sealing the
 * whole object flips the default: a NEW provider field is covered
 * automatically, and omitting one requires a deliberate, reviewable entry
 * in `exclude` instead of an easy-to-forget addition to an inclusion list.
 */
export function sealFullRequest(
  request: Record<string, unknown> | null | undefined,
  exclude: readonly string[] = [],
): SealedMetadata {
  if (!request || typeof request !== 'object') return brand({});
  const excluded = new Set(exclude);
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(request)) {
    if (excluded.has(key)) continue;
    out[key] = safeSerialize(request[key]);
  }
  return brand(out);
}

/**
 * Convenience: seal `value` under `key` for a `metadata` object, or
 * `undefined` if there is nothing to seal (so callers can spread it —
 * `metadata: sealMetadataEntry('toolArguments', args)` — without an extra
 * null check).
 */
export function sealMetadataEntry(key: string, value: unknown): SealedMetadata | undefined {
  const sealed = sealForMetadata(value);
  return sealed !== undefined ? brand({ [key]: sealed }) : undefined;
}

/**
 * Seal a hand-built metadata object as a whole (e.g. `{ model, messages }`
 * where only some fields need sealing) — for the one call site
 * (`openai-chat.ts`) that combines a sealed field with plain scalars rather
 * than sealing a single field under `sealMetadataEntry`.
 */
export function sealMetadata(value: Record<string, unknown>): SealedMetadata {
  const sealed = sealForMetadata(value);
  const safe =
    sealed !== undefined && typeof sealed === 'object' && sealed !== null && !Array.isArray(sealed)
      ? (sealed as Record<string, unknown>)
      : { unserializable: true };
  return brand(safe);
}

/**
 * The only sanctioned way for an adapter to call `enforcePolicy`. Requires
 * `metadata` to carry the `SealedMetadata` brand — a bare object literal
 * fails to compile here. Defense-in-depth: also checks the runtime tag, so
 * an `as SealedMetadata` cast around the type system (or a plain-JS caller
 * with no compiler at all) still fails closed via `MetadataContractError`
 * instead of silently reaching the server unsealed.
 */
export async function enforcePolicyBound(
  exe: Execlave,
  opts: Omit<EnforcePolicyOptions, 'metadata'> & { metadata?: SealedMetadata },
): Promise<EnforceResult> {
  if (opts.metadata !== undefined && !isSealed(opts.metadata)) {
    throw new MetadataContractError(
      `metadata for agent '${opts.agentId}' was not produced by sealForMetadata/sealMetadataEntry/sealMetadata`,
    );
  }
  return exe.enforcePolicy(opts as EnforcePolicyOptions);
}
