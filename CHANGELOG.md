# Changelog

All notable changes to `@execlave/sdk` will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- No telemetry. The SDK does not phone home, emit anonymous usage events, or
  fetch remote configuration. Every network call goes to the Execlave backend
  URL configured by the caller.

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

[Unreleased]: https://github.com/rishitmavani/agentguard/compare/sdk-js-v1.0.0...HEAD
[1.0.0]: https://github.com/rishitmavani/agentguard/releases/tag/sdk-js-v1.0.0
