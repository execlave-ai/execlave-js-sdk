# Changelog

All notable changes to `@execlave/sdk` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.9.0] - 2026-10-02

A trace the platform refuses now reaches your application.

### Added

- **`onTraceRejected`** config handler. Called after a flush with the traces
  the platform refused to store, each with `traceId`, `code` and `message`.
- **`flush()` resolves with `{ sent, rejected, undelivered }`** instead of
  nothing. `rejected` lists refused traces; `undelivered` counts traces dropped
  without an answer (retries exhausted, or the trace quota is used up).
- Exported types `TraceRejection` and `FlushResult`.

### Fixed

- **A refused trace was silent in production.** Traces are sent in the
  background; a refusal was only a debug log, and a per-trace refusal inside an
  accepted batch was not read at all. With no `onTraceRejected` handler a
  refusal now goes to `console.error` whether or not `debug` is on.

### Why it matters now

Agents can be set to outcome strictness `strict`. The platform then refuses a
trace that claims `success` without evidence that the effect happened
(`code: 'OUTCOME_EVIDENCE_REQUIRED'`). The SDK never resends such a trace as
something else. Send `effectEvidence` with basis `read_back` or `callback`, or
report `effect_unconfirmed`.

## [1.8.1] - 2026-09-24

Error traces no longer take their batch down with them.

### Fixed

- **`trace.finish('error', message)` without an error type no longer loses
  traces.** The documented call omitted `errorType`; the platform rejected such
  a trace, which failed the whole ingest batch (successful traces included), and
  the SDK then retried and dropped it. Error traces now always carry a type and
  message: a missing or blank value becomes `UnspecifiedError` /
  `No error message provided`, in both `finish` overloads. Passing a real type —
  `finish('error', err.message, err.name)` — is still recommended. The platform
  applies the same placeholders server-side, so older SDK versions are covered
  too once your platform is updated.
- **Permanent ingest rejections are not retried.** A 4xx response other than
  408/429 now drops that chunk immediately with a single error log naming the
  status and the server's reason, instead of retrying a payload that cannot
  succeed. 408, 429, 5xx and network errors are retried as before.

## [1.8.0] - 2026-09-21

Enforcement bypasses now reach the platform's audit trail, and traces can carry
evidence about an action's effect.

### Added

- **Effect evidence on traces.** `trace.finish({ status, effectEvidence })`
  attaches an `EffectEvidence` (`basis`: `read_back` | `callback` |
  `acknowledgement` | `none`, plus optional `acknowledgementId`, `effectRef`,
  `confirmedAt`, `detail`) so a trace whose effect could not be confirmed says
  how the SDK knows what it claims. `acknowledgement` means the target accepted
  the request, not that it performed it; only `read_back` and `callback` are
  confirmation. The positional `finish(status, errorMessage, errorType)` form is
  unchanged.
- **`client.resolveTrace(traceId, { resolvedStatus, basis, ... })`** records a
  later observation about an unconfirmed trace. It appends to the trace's
  resolution ledger and never rewrites the original outcome.
- **Enforcement bypasses are now reported to the platform.** Until now
  `onEnforcementBypassed` told only the caller's own process, so the audit trail
  could not tell "every call was governed" from "the SDK lost contact for two
  hours". The SDK now sends each bypass to `POST /api/v1/sdk/bypass-windows`,
  where it is recorded as `enforcement.bypassed` in the org's audit chain.
  - Bypasses are coalesced into windows per (agent, reason) and only closed
    windows are sent: a window closes when the agent gets a governed decision,
    after 60 s without a bypass, or after 15 min. A long outage is many
    records, never one mutable one.
  - Reporting is off the enforcement path: it runs from an unref'd timer, retries
    with backoff (10 s, doubling to 5 min), and never delays or throws into an
    `enforcePolicy` call. Shutdown makes one bounded (3 s) attempt.
  - Unacknowledged windows are kept in a bounded buffer (500). If an outage
    outlasts it the oldest is dropped, and the loss itself is reported so the
    trail says "N bypasses were not reported" instead of staying silent.
  - Each window carries a client-generated `windowId`, so a retry after a lost
    response is idempotent.
  - **On by default.** Set `reportBypassesToPlatform: false` to keep only the
    local `onEnforcementBypassed` callback. The callback is unchanged and fires
    once per bypass regardless.
  - Requires a backend that has the endpoint. Against an older backend (404) the
    windows are kept and retried at the backoff ceiling; nothing else is affected.
  - Text sent to the platform is made storable first: a lone UTF-16 surrogate
    (for example from cutting a message mid-emoji) or NUL would make the server's
    audit write fail, and an empty `agentId` would get the whole report rejected.
    The first two are replaced with U+FFFD (a cut never splits an emoji), the
    last is sent as `unknown`.
  - A process crash during an outage loses the unsent in-memory buffer; nothing
    is spooled to disk.

### Fixed

- **A fail-open plan-limit allow now carries `source: 'fail_open_plan_limit'`**
  on the returned `EnforceResult`. It was the only fail-open allow without a
  `source`, so a caller could not tell it from a governed allow, and the
  matching `EnforcementBypassEvent.source` had no result counterpart to
  correlate with. The `EnforceResult.source` doc now lists all four fail-open
  sources.

## [1.7.0] - 2026-08-03

Production audit remediation: enforcement bypass visibility, strict schema
validation, LangChain cross-version compatibility, and approval certificate
verification evidence.

### Added

- **`onEnforcementBypassed` config option** — register a callback that fires on
  every ungoverned execution (network error, server error, circuit breaker open,
  fail-open allow). Each event carries `reason`, `agentId`, `timestamp`, and
  optional `status`/`message`, so the ungoverned window is observable even when
  the governance plane is down.
- **`EnforcementBypassEvent` and `EnforcementBypassReason` types** exported for
  strongly-typed listener implementations.
- **Approval certificate verification evidence** in compliance reports —
  `verifiedAtExecution` and `verifiedAt` fields on certificate inventory items,
  plus summary counts (verified vs unverified).
- **`alert_on_unverified_execution`** per-policy setting (default on) raises an
  `approval.execution_unverified` audit event and notification when an approved
  action's certificate is never verified within the grace window.
- **Server-Timing header** on the enforce endpoint — `enforce;dur=<ms>` for
  client-side latency attribution without adding instrumentation overhead.
- **CI enforcement-latency guard** — the build fails if p95 enforcement latency
  exceeds 0.5ms (measured by the bench-enforce-e2e suite).

### Fixed

- **Strict schema validation on all 78 request schemas** — unknown fields now
  produce a `400` rather than being silently dropped. A regression guard test
  prevents `.strict()` from being accidentally removed.
- **LangChain integration cross-version compatibility** — `resolveParentRunId`
  now discriminates on `runType` vocabulary instead of assuming UUID-shaped run
  IDs, fixing breakage with custom run ID formats. Peer dep widened to
  `>=0.3.0 <2.0.0`.
- **Semantic classifier fast-path** was unreachable for `action_type: 'general'`
  (the default from enforce). Fixed: confident-safe exit now covers all action
  types that lack dangerous context, reducing median classify time from 5.5s to
  ~300ms.
- **XSS sanitizer no longer corrupts CEL expressions** — the `on\w+\s*=` markup
  pattern matched inside `environment ==`; markup patterns now only apply when
  `<` is present in the value.
- **Injection detector regex semantics** — added `agent_directives_possessive`
  ambiguous rule with bounded regex execution to prevent ReDoS.
- **`custom` policy type rejected** — was creatable but inert (rule engine falls
  through to `default: return null`); now returns a validation error.
- **Format-string injection in log messages** — `formatLogMessage` now uses
  non-recursive `%s` substitution instead of vulnerable template interpolation.

### Changed

- Policy type count corrected from 20 to 19 across codebase and documentation.
- Trace schema field aliases (`inputData`→`input`, `outputData`→`output`,
  `estimatedCostUsd`→`costUsd`) accepted for backwards compatibility.
- Cost budget reconciliation: advisory enforcement uses discriminator field;
  FinOps aggregates default to production environment only.

## [1.6.0] - 2026-07-30

Enforcement-reliability hardening and expanded injection coverage, plus new
APIs for tool-output scanning and multi-turn evaluation.

### ⚠️ Upgrade note

- **`enforcePolicy()` now rejects unknown fields.** The server enforcement
  endpoint is now strict: a request carrying a field it does not recognize (for
  example, sending a tool name as `toolName` instead of the documented `tools`
  array) returns a `400` instead of being silently accepted. If you were relying
  on an unrecognized field being ignored, switch to the documented option names.

### Added

- **`enforceToolOutput(opts)`** — synchronously scan a tool's output _before_
  feeding it back to the model. Throws `PolicyBlockedError` when a block-mode
  `tool_output_scan` policy fires, so a poisoned or PII-laden tool result
  (indirect prompt injection) can be stopped before the agent consumes it.
- **`conversationHistory`** option on `enforcePolicy()` — pass recent turns so
  injection scanning runs over the combined conversation, catching an attack
  split across multiple turns (a "crescendo") that no single turn reveals.
- **`toolOutputs`** option on `enforcePolicy()`, plus `ConversationTurn` and
  `ToolOutput` exported types.

### Fixed

- **`enforcementOnOutage: 'fail_closed'` now blocks on the first failure.** It
  previously allowed the first calls of an outage through (the guarantee was
  gated on an internal circuit breaker that only trips after several failures),
  and re-leaked calls periodically during a sustained outage. It now raises
  `EnforcementUnavailableError` on every enforcement failure, as documented.
- **Server errors (5xx) now honor `enforcementOnOutage`.** A `502`/`503` — the
  common shape of an outage behind a proxy — previously bypassed the setting and
  threw a generic error the documented handler did not catch. It now routes
  through the same fail-open/fail-closed path as a network failure. Fail-open
  allows carry a `source` marker (`fail_open_network_error` /
  `fail_open_server_error`) so an ungoverned allow is distinguishable.
- **The kill switch is no longer bypassed by the local policy cache.** A paused
  agent could keep receiving cached `allow` decisions for up to the cache TTL;
  `enforcePolicy()` now skips the cache while the agent is paused and the cache
  is flushed the moment a pause is observed.
- **Framework adapters now enforce on their primary code path.** The LangChain
  handler previously enforced only on chain start, so a direct `model.invoke()`
  / `llm.invoke()` was traced but never gated; it now enforces at the LLM
  boundary (de-duplicated against an already-enforced parent run). The OpenAI
  Agents processor now enforces the agent's own input, not only tool calls.

Behavior change to note: after upgrading, block-mode policies will apply to
LangChain direct-invoke calls and OpenAI-Agents agent input that were previously
ungoverned. This is the intended behavior; review your policies if you relied on
those paths being unenforced.

## [1.5.0] - 2026-07-27

### Fixed

- **Certificate binding no longer stops at a hand-picked field list.** The
  OpenAI Chat adapter sealed only `{ model, messages }` into the approval
  certificate's action-binding digest — `tools`, `tool_choice`, `temperature`,
  and `response_format` could drift from what a human approved without ever
  invalidating the certificate. It now seals the **entire** request object via
  a new `sealFullRequest()` helper (exclusion-list, not inclusion-list: every
  field is covered by default, a field is only dropped by explicit, reviewed
  exclusion).
- **`sealForMetadata` no longer collapses an entire payload to a placeholder
  over one bad field.** Previously, a single non-serializable value anywhere
  in a metadata object (a circular reference, a callback, an `AbortSignal`)
  caused the _whole_ sealed value to fall back to a fixed placeholder string —
  identical at issuance and at re-execution, so certificate verification
  silently became a no-op for every other field in that payload. Sanitization
  is now per-field: only the offending field is replaced with an explicit
  `[unserializable:...]` marker.
- Added a structural contract test that fails the build if any adapter passes
  a hand-built, multi-field object literal to `sealMetadata`/
  `sealMetadataEntry` instead of a single already-complete value or
  `sealFullRequest(...)` — closing off the exact pattern that caused the
  OpenAI Chat gap from recurring in a future adapter.

## [1.4.0] - 2026-06-08

### Added

- **Optional HMAC request signing.** New `signRequests` config option (default
  `false`). When enabled, every request body is signed with HMAC-SHA256 keyed by
  the API key and sent with `X-Execlave-Timestamp` and `X-Execlave-Signature`
  (`sha256=<hex>`) headers. The server verifies the signature over the exact
  request bytes (`${timestamp}.${body}`) and rejects tampered or replayed
  requests. Defense-in-depth on top of TLS + API-key auth; opt-in and fully
  backward-compatible (unsigned requests are unaffected when the server has not
  made signing mandatory).

## [1.3.0] - 2026-06-03

### Added

- **Agent identity stamping.** New `stampIdentity` config option (default `false`).
  When enabled, the client issues and caches a short-lived RS256 `exe_agt_`
  credential per agent and attaches it to each trace on ingest (`agentCredential`
  field on `TracePayload`), so the platform can cryptographically stamp who
  produced the trace. Best-effort and non-breaking: if a credential cannot be
  issued, traces are still sent unstamped — stamping never blocks or drops ingest.
- **MCP tool-integrity surfaces.** Optional, backwards-compatible additions for
  MCP tool-supply-chain governance:
  - `toolDescriptor({ server, tool, descriptor, description? })` — computes the
    stable SHA-256 descriptor hash (canonical, key-order independent) used to pin
    and diff a tool.
  - `reportToolBaseline({ agentId, descriptors, reason? })` — pins the approved
    set of `(server, tool, descriptorHash)` tuples for an agent; re-pin with
    `reason: 'baseline_update'` after a reviewed tool update.
  - `enforcePolicy()` accepts an optional `toolDescriptors` array that is diffed
    against the agent's pinned baseline at runtime.
  - New `ToolIntegrityError` (extends `PolicyBlockedError`) is thrown when an
    enforcement is denied by a `tool_integrity` policy. `ToolDescriptorInput` and
    `ReportToolBaselineOptions` are exported from the type surface. Callers that
    do not use these fields are unaffected.

### Changed

- No telemetry. The SDK does not phone home, emit anonymous usage events, or
  fetch remote configuration. Every network call goes to the Execlave backend
  URL configured by the caller.

## [1.2.1] - 2026-05-29

### Added

- **AI Agent Management Platform (AMP) surfaces.** Optional, backwards-compatible
  additions for the governance features:
  - `registerAgent()` accepts an optional `autonomyLevel`
    (`observe` | `advise` | `act_with_approval` | `autonomous`) that maps the
    agent onto a tiered-governance template.
  - New `reportAgentMetadata()` method that records a version snapshot in the
    agent registry (`versionLabel` / `gitCommit` / `deployedAt` / `notes` /
    `activate`) — call it from a deploy pipeline to build version history for
    diff/rollback.
  - `AutonomyLevel` and `ReportAgentMetadataOptions` exported from the type
    surface. Callers that do not set these fields are unaffected.

## [1.2.0] - 2026-05-28

### Added

- **Framework integration modules** (tree-shakeable, opt-in via
  `@execlave/sdk/integrations`): Model Context Protocol (MCP) wrapper and an
  OpenAI Chat Completions wrapper that route tool calls / completions through
  policy enforcement and trace ingestion without changing the host app's call
  sites.

## [1.1.5] - 2026-05-05

### Added

- `ValidatorDeniedError` (extends `PolicyBlockedError`) for programmatic handling
  of denials originating from a Custom Validator (BYOV). The `fromViolations()`
  factory returns a `ValidatorDeniedError` when any violation is validator-sourced
  and a plain `PolicyBlockedError` otherwise, so existing `catch` sites keep working.

### Fixed

- `http://api.execlave.com` is normalized to `https://api.execlave.com` so
  POST-based calls are not downgraded to GET by an HTTP-to-HTTPS redirect.
- Policy enforcement cache keys now include environment to avoid reusing a
  development response for production, or vice versa.

## [1.1.4] - 2026-05-05

### Fixed

- `registerAgent()` now handles agent responses wrapped as `{ data: [...] }`
  by selecting the matching `agentId` instead of passing the list into `Agent`.
- `enforcePolicy()` docs/types now explicitly allow either the registered
  external `agentId` or the internal agent UUID, matching the backend
  `/policies/enforce` contract.

## [1.0.0] — 2026-04

### Added

- Initial public release of `@execlave/sdk`.
- `ExeclaveClient` with policy enforcement (`enforce`), trace ingestion
  (`ingestTrace`), and agent registration (`registerAgent`).
- TypeScript type definitions shipped alongside the compiled JavaScript.
- Zero runtime dependencies beyond `node:fetch`.
- Works in Node.js 18+ and modern browsers.
- Support for API keys via the `exe_` / `exe_test_` prefix.

### Security

- TLS certificate verification is always enabled and cannot be disabled via
  a flag. Callers who need to target a self-signed local environment must
  configure `NODE_TLS_REJECT_UNAUTHORIZED` at the process level and accept
  the risk explicitly.

[Unreleased]: https://github.com/rishitmavani/agentguard/compare/sdk-js-v1.3.0...HEAD
[1.3.0]: https://github.com/rishitmavani/agentguard/compare/sdk-js-v1.2.1...sdk-js-v1.3.0
[1.2.1]: https://github.com/rishitmavani/agentguard/compare/sdk-js-v1.2.0...sdk-js-v1.2.1
[1.2.0]: https://github.com/rishitmavani/agentguard/compare/sdk-js-v1.1.5...sdk-js-v1.2.0
[1.1.5]: https://github.com/rishitmavani/agentguard/compare/sdk-js-v1.1.4...sdk-js-v1.1.5
[1.1.4]: https://github.com/rishitmavani/agentguard/compare/sdk-js-v1.1.3...sdk-js-v1.1.4
[1.0.0]: https://github.com/rishitmavani/agentguard/releases/tag/sdk-js-v1.0.0
