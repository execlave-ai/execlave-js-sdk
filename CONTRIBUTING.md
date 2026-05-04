# Contributing to `@execlave/sdk`

Thanks for wanting to contribute! This project is the official JavaScript/TypeScript SDK for the Execlave AI Governance Platform.

## Ground rules

1. **By contributing, you agree your work will be released under the MIT licence** (see `LICENSE`).
2. **Be kind.** See [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md).
3. **Security issues go to `security@execlave.com`**, never to a public issue. See [SECURITY.md](SECURITY.md).

## Development setup

```bash
# Fork, then clone
git clone https://github.com/<you>/execlave-js-sdk
cd execlave-js-sdk

npm install

# Type-check
npm run type-check

# Full test suite
npm test

# Build distributable
npm run build
```

Node 20+ is required. TypeScript strict mode is on. Jest drives tests.

## Project layout

```
src/
├── client.ts                        # Execlave client + enforce_policy
├── trace.ts                         # Trace primitive
├── instrumentation/                 # Shared span + event helpers
│   ├── spans.ts
│   └── events.ts
├── integrations/
│   ├── index.ts
│   └── langchain.ts                 # ExeclaveCallbackHandler
└── __tests__/                       # Jest tests
```

## Pull request checklist

- [ ] `npm run type-check` passes
- [ ] `npm test` passes
- [ ] `npm run build` produces clean output in `dist/`
- [ ] Public API changes documented in the README
- [ ] `CHANGELOG.md` updated under *Unreleased* if user-visible
- [ ] Subpath exports in `package.json#exports` updated if adding a new integration
- [ ] For new framework adapters: optional peer dep added, not a required dep

## Adding a new framework integration

1. Create the module under `src/integrations/<name>.ts`.
2. **Duck-type** the framework's base classes where possible — do not `import` the framework at compile time. Users who do not install the framework must still be able to import the core SDK.
3. Use the helpers from `src/instrumentation/` rather than driving `Trace` directly.
4. Call `Execlave.enforcePolicy(...)` on every external action (tool call, outbound HTTP, database write).
5. Add the framework package as an **optional peer dependency** with `peerDependenciesMeta`.
6. Add a subpath export in `package.json` (e.g. `./integrations/langchain`) so consumers get both JS and `.d.ts`.
7. Add unit tests under `src/__tests__/` that mock the framework — CI does not install the real framework.
8. Add a docs page at `frontend/app/docs/integrations/<name>/page.tsx` in the monorepo PR.

## Style

- Prettier + the shared ESLint config at the repo root.
- `no-explicit-any` is a warning; prefer `unknown` with narrowing.
- No `console.log` in library code — use `client.on('log', ...)` or throw.
- Never swallow exceptions without logging — fail-open is acceptable for telemetry paths only, and must be logged.

## Release process

Releases are driven from the monorepo. Tag `sdk-js/vX.Y.Z` publishes to npm via the `sdk-publish.yml` workflow. Versioning follows SemVer.

## Questions?

Open a discussion at <https://github.com/execlave-ai/execlave-js-sdk/discussions> or email `support@execlave.com`.
