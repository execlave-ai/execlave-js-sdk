# @execlave/sdk

Official JavaScript/TypeScript SDK for the [Execlave](https://www.execlave.com) AI agent governance platform.

[![npm version](https://img.shields.io/npm/v/@execlave/sdk.svg)](https://www.npmjs.com/package/@execlave/sdk)
[![npm downloads](https://img.shields.io/npm/dm/@execlave/sdk.svg)](https://www.npmjs.com/package/@execlave/sdk)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![Docs](https://img.shields.io/badge/docs-execlave.com-0a84ff.svg)](https://www.execlave.com/docs)

> **Framework integrations** — use the [LangChain callback handler](https://www.execlave.com/docs/integrations/langchain) for automatic tracing and policy enforcement, or see [all integrations](https://www.execlave.com/docs/integrations). [Get an API key](https://www.execlave.com/signup?utm_source=github&utm_medium=sdk&utm_campaign=js).

## Installation

```bash
npm install @execlave/sdk
```

## Quick Start

```typescript
import { Execlave, AgentPausedError, PolicyBlockedError } from '@execlave/sdk';

// Initialize the SDK
const ag = new Execlave({
  apiKey: 'exe_prod_xxx', // or set EXECLAVE_API_KEY env var
  environment: 'production',
});

// Register your agent (idempotent — call on startup)
const agent = await ag.registerAgent({
  agentId: 'my-chatbot',
  name: 'Customer Support Bot',
  type: 'chatbot',
  platform: 'custom',
});

// Canonical pattern: enforce policies BEFORE the LLM call, then trace it.
async function handleMessage(userQuestion: string) {
  const trace = ag.startTrace({ agentId: 'my-chatbot', sessionId: 'sess_123' });
  trace.setInput(userQuestion);

  try {
    // Pre-execution enforcement is SYNCHRONOUS and MUST run before the LLM call.
    // Throws PolicyBlockedError if a block-mode policy (e.g. prompt injection) fires.
    await ag.enforcePolicy({ agentId: 'my-chatbot', input: userQuestion });

    const answer = await llm.call(userQuestion);

    trace.setOutput(answer).setModel('gpt-4-turbo').setTokens(150, 300).setCost(0.012).finish();
    return answer;
  } catch (err) {
    if (err instanceof PolicyBlockedError) {
      trace.setOutput('[BLOCKED BY POLICY]').finish('error', err.message);
      return 'Your input was blocked by our content policies.';
    }
    if (err instanceof AgentPausedError) {
      trace.finish('error', err.message);
      return 'Service temporarily unavailable.';
    }
    trace.finish('error', String(err));
    throw err;
  }
}

// Prompt management
const version = await agent.deployPrompt({
  promptTemplate: 'You are a helpful assistant. Answer: {question}',
  systemMessage: 'Be concise.',
  modelName: 'gpt-4-turbo',
  changeSummary: 'Improved conciseness',
});

// Graceful shutdown (flushes remaining traces)
await ag.shutdown();
```

> **Important:** tracing alone does NOT block LLM calls. Trace ingestion creates incidents post-hoc. To block requests before they reach the LLM, you MUST call `ag.enforcePolicy()` and handle `PolicyBlockedError` as shown above. The `enableInjectionScan` option only tags traces with an injection score — it does not block.

## Configuration

| Option                 | Type      | Default                    | Description                                                                                                                                                |
| ---------------------- | --------- | -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apiKey`               | `string`  | `EXECLAVE_API_KEY` env     | API key (`exe_prod_xxx`)                                                                                                                                   |
| `baseUrl`              | `string`  | `https://api.execlave.com` | Execlave API URL                                                                                                                                           |
| `environment`          | `string`  | `production`               | Deployment environment                                                                                                                                     |
| `asyncMode`            | `boolean` | `true`                     | Buffer traces for background flush                                                                                                                         |
| `batchSize`            | `number`  | `100`                      | Max traces per flush batch                                                                                                                                 |
| `flushIntervalMs`      | `number`  | `10000`                    | Background flush interval                                                                                                                                  |
| `debug`                | `boolean` | `false`                    | Enable debug logging                                                                                                                                       |
| `enableControlChannel` | `boolean` | `true`                     | Poll agent status for kill-switch                                                                                                                          |
| `pollIntervalMs`       | `number`  | `15000`                    | Status poll interval                                                                                                                                       |
| `enableInjectionScan`  | `boolean` | `true`                     | Client-side injection scoring; tags traces with metadata. **Does NOT block LLM calls** — use a `block`-mode injection policy + `enforcePolicy()` to block. |
| `enforcementOnOutage`  | `string`  | `fail_open`                | Behavior when enforcement API is unreachable: `fail_open` allows the call, `fail_closed` raises `EnforcementUnavailableError`.                             |
| `policyCacheTtlMs`     | `number`  | `60000`                    | TTL for cached policy decisions                                                                                                                            |

## API Reference

### `Execlave`

- `ping()` — Check API connectivity
- `registerAgent(opts)` — Register an AI agent
- `enforcePolicy(opts)` — **Synchronous pre-execution policy check.** Call this BEFORE every LLM invocation. Throws `PolicyBlockedError` on a block-mode violation, `AgentPausedError` if the agent is kill-switched, `EnforcementUnavailableError` only when configured `fail_closed`. `opts`: `{ agentId, input, model?, metadata? }`
- `startTrace(opts)` — Start a manual trace (post-hoc; does not block)
- `wrap(fn, opts)` — Wrap a function with automatic tracing
- `checkAgentStatus(agentId?)` — Get agent status
- `flush()` — Flush buffered traces
- `shutdown()` — Flush and shut down

### Errors

- `PolicyBlockedError` — A block-mode policy fired. Has a `violations: PolicyViolation[]` field with `policyType`, `policyName`, `severity`, `message`, `enforcementMode`.
- `AgentPausedError` — Agent is kill-switched.
- `EnforcementUnavailableError` — Enforcement API unreachable AND `enforcementOnOutage: 'fail_closed'`.

### `Agent`

- `deployPrompt(opts)` — Deploy a new prompt version
- `getCurrentPrompt()` — Get the deployed prompt
- `listPromptVersions()` — List all versions
- `refreshStatus()` — Refresh agent status
- `isPaused` — Whether agent is kill-switched

### `Trace`

- `setInput(data)` — Set input data (chainable)
- `setOutput(data)` — Set output data (chainable)
- `setModel(name)` — Set model name (chainable)
- `setTokens(prompt, completion)` — Set token counts (chainable)
- `setCost(usd)` — Set cost (chainable)
- `addMetadata(meta)` — Add metadata (chainable)
- `finish(status?, error?, errorType?)` — Submit the trace

## Zero Dependencies

This SDK has **zero runtime dependencies**. It uses Node.js built-in `http`/`https` modules for network requests.

## Legal

By using this SDK, you agree to the [Execlave Terms of Service](https://www.execlave.com/terms).

- [Privacy Policy](https://www.execlave.com/privacy)
- [Acceptable Use Policy](https://www.execlave.com/acceptable-use)
- [Responsible AI](https://www.execlave.com/responsible-ai)
- [Security](https://www.execlave.com/security)

## License

MIT — see [LICENSE](../LICENSE) for details.
