/**
 * OpenAI Chat Completions auto-instrumentation.
 *
 * Wrap an `openai` client so every `chat.completions.create(...)` call is
 * governed by Execlave: the user prompt is enforced before the request
 * leaves, and the call is recorded as an `llm` span with model + token
 * usage metadata.
 *
 * ```ts
 * import OpenAI from 'openai';
 * import { Execlave } from '@execlave/sdk';
 * import { instrumentOpenAI } from '@execlave/sdk/integrations/openai-chat';
 *
 * const exe = new Execlave({ apiKey: '...' });
 * const openai = instrumentOpenAI(new OpenAI(), exe, { agentId: 'my-bot' });
 *
 * const resp = await openai.chat.completions.create({
 *   model: 'gpt-4o-mini',
 *   messages: [{ role: 'user', content: 'hi' }],
 * });
 * ```
 *
 * Idempotent — marker prevents double-wrapping. No compile-time
 * dependency on the openai SDK — the call surface is duck-typed.
 */

import type { Execlave } from '../client';
import { isEnforcementError } from '../errors';
import { SPAN_KIND_LLM, getSpanTree } from '../instrumentation/spans';
import { truncateForClassifier, sealFullRequest, enforcePolicyBound } from './_actionBinding';

const MARKER = '_execlaveInstrumented';

export interface InstrumentOpenAIOptions {
  /** Agent id registered with Execlave. Required for enforcement. */
  agentId: string;
  /** Run `enforcePolicy` on the user message. Default true. */
  enforce?: boolean;
  sessionId?: string;
  userId?: string;
}

/**
 * Patch `client.chat.completions.create` to enforce policies and record
 * an LLM span around every call. Returns the same client for fluent
 * chaining.
 */
export function instrumentOpenAI<T>(client: T, exe: Execlave, opts: InstrumentOpenAIOptions): T {
  if (client === null || client === undefined) {
    throw new Error('instrumentOpenAI: client must not be null/undefined');
  }
  if (!exe) throw new Error('instrumentOpenAI: exe must not be null/undefined');
  if (!opts?.agentId) throw new Error('instrumentOpenAI: agentId is required');

  const c = client as any;
  const completions = c?.chat?.completions;
  if (!completions || typeof completions.create !== 'function') {
    throw new TypeError('instrumentOpenAI: client.chat.completions.create is missing');
  }
  if (completions[MARKER]) return client;

  const enforce = opts.enforce !== false;
  const tree = getSpanTree(exe);
  const originalCreate = completions.create.bind(completions);

  const wrappedCreate = async (params: any, ...rest: any[]): Promise<any> => {
    const model: string | undefined = params?.model;
    const messages: unknown = params?.messages;

    if (enforce) {
      const userText = extractUserInput(messages) ?? 'chat.completions';
      try {
        // `input` is the extracted latest user turn — bounded for policy/
        // classifier read, not the whole request. The certificate's
        // action-binding digest covers the WHOLE sealed action context, so
        // the ENTIRE request object (model, messages, tools, tool_choice,
        // temperature, response_format, ...) goes into metadata — not a
        // hand-picked subset that stops covering a field the day OpenAI adds
        // one and this adapter isn't updated. A drift in any of it must
        // still invalidate the certificate, not silently escape a digest
        // scoped to only the fields someone remembered to list here.
        await enforcePolicyBound(exe, {
          agentId: opts.agentId,
          input: userText,
          metadata: sealFullRequest(params),
        });
      } catch (err) {
        if (isEnforcementError(err)) throw err;
        // eslint-disable-next-line no-console
        console.warn('[execlave] enforcePolicy failed (non-fatal):', err);
      }
    }

    const span = tree.start({
      kind: SPAN_KIND_LLM,
      name: String(model ?? 'chat.completions'),
      agentId: opts.agentId,
      sessionId: opts.sessionId,
      userId: opts.userId,
      metadata: { provider: 'openai', endpoint: 'chat.completions' },
    });
    if (model) span.setModel(String(model));
    try {
      span.setInput(messages);
    } catch {
      /* noop */
    }

    let response: any;
    try {
      response = await originalCreate(params, ...rest);
    } catch (err: any) {
      span.finish('error', err?.message ?? String(err), err?.name ?? 'Error');
      throw err;
    }

    try {
      const choices = response?.choices ?? [];
      const message = choices[0]?.message;
      const content = message?.content;
      if (content !== undefined && content !== null) span.setOutput(content);
      const usage = response?.usage;
      const p = (usage?.prompt_tokens ?? usage?.promptTokens) as number | undefined;
      const compl = (usage?.completion_tokens ?? usage?.completionTokens) as number | undefined;
      if (typeof p === 'number' && typeof compl === 'number') span.setTokens(p, compl);
      const respModel = response?.model;
      if (typeof respModel === 'string' && respModel) span.setModel(respModel);
    } catch {
      /* swallow — instrumentation must not break the call */
    }
    span.finish('success');
    return response;
  };

  try {
    completions.create = wrappedCreate;
    completions[MARKER] = true;
  } catch {
    // Frozen object — double-wrap guard inactive but we've done what we can.
  }
  return client;
}

// ----------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------
function extractUserInput(messages: unknown): string | null {
  if (!Array.isArray(messages)) return truncateForClassifier(messages);
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i] as any;
    if (msg?.role !== 'user') continue;
    const content = msg?.content;
    if (Array.isArray(content)) {
      const parts = content
        .map((p: any) => (typeof p?.text === 'string' ? p.text : null))
        .filter((x: string | null): x is string => !!x);
      if (parts.length) return truncateForClassifier(parts.join('\n'));
    }
    return truncateForClassifier(content);
  }
  return null;
}
