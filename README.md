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
import { Execlave } from '@execlave/sdk';

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

// Trace an LLM call
const trace = ag.startTrace({ agentId: 'my-chatbot', sessionId: 'sess_123' });
trace.setInput(userQuestion);

const answer = await llm.call(userQuestion);

trace.setOutput(answer).setModel('gpt-4-turbo').setTokens(150, 300).setCost(0.012);
trace.finish(); // submits to buffer; flushed in background

// Or use the wrap() helper for automatic tracing
const tracedCall = ag.wrap(
  async (question: string) => {
    return await llm.call(question);
  },
  { agentId: 'my-chatbot' },
);

const result = await tracedCall('Hello!');

// Prompt management
const version = await agent.deployPrompt({
  promptTemplate: 'You are a helpful assistant. Answer: {question}',
  systemMessage: 'Be concise.',
  modelName: 'gpt-4-turbo',
  changeSummary: 'Improved conciseness',
});

// Kill-switch aware
try {
  const trace = ag.startTrace();
  // ...
} catch (err) {
  if (err instanceof AgentPausedError) {
    return 'Service temporarily unavailable.';
  }
  throw err;
}

// Graceful shutdown (flushes remaining traces)
await ag.shutdown();
```

## Configuration

| Option                 | Type      | Default                    | Description                        |
| ---------------------- | --------- | -------------------------- | ---------------------------------- |
| `apiKey`               | `string`  | `EXECLAVE_API_KEY` env     | API key (`exe_prod_xxx`)           |
| `baseUrl`              | `string`  | `https://api.execlave.com` | Execlave API URL                   |
| `environment`          | `string`  | `production`               | Deployment environment             |
| `asyncMode`            | `boolean` | `true`                     | Buffer traces for background flush |
| `batchSize`            | `number`  | `100`                      | Max traces per flush batch         |
| `flushIntervalMs`      | `number`  | `10000`                    | Background flush interval          |
| `debug`                | `boolean` | `false`                    | Enable debug logging               |
| `enableControlChannel` | `boolean` | `true`                     | Poll agent status for kill-switch  |
| `pollIntervalMs`       | `number`  | `15000`                    | Status poll interval               |

## API Reference

### `Execlave`

- `ping()` — Check API connectivity
- `registerAgent(opts)` — Register an AI agent
- `startTrace(opts)` — Start a manual trace
- `wrap(fn, opts)` — Wrap a function with automatic tracing
- `checkAgentStatus(agentId?)` — Get agent status
- `flush()` — Flush buffered traces
- `shutdown()` — Flush and shut down

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
