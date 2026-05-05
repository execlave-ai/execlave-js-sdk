# Changelog

All notable changes to `@execlave/sdk` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- No telemetry. The SDK does not phone home, emit anonymous usage events, or
  fetch remote configuration. Every network call goes to the Execlave backend
  URL configured by the caller.

## [1.1.5] - 2026-05-05

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

[Unreleased]: https://github.com/rishitmavani/agentguard/compare/sdk-js-v1.1.5...HEAD
[1.1.5]: https://github.com/rishitmavani/agentguard/compare/sdk-js-v1.1.4...sdk-js-v1.1.5
[1.1.4]: https://github.com/rishitmavani/agentguard/compare/sdk-js-v1.1.3...sdk-js-v1.1.4
[1.0.0]: https://github.com/rishitmavani/agentguard/releases/tag/sdk-js-v1.0.0
