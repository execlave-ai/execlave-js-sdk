# Third-Party Notices — `@execlave/sdk`

This package is distributed with zero required runtime dependencies. Optional dependencies are listed in `package.json` under `peerDependencies` and `peerDependenciesMeta`; they are loaded only when the consumer opts into an integration or telemetry feature.

## Required runtime dependencies

None.

## Optional peer dependencies

| Peer | Licence | Used by |
|------|---------|---------|
| `@langchain/core` | MIT | `@execlave/sdk/integrations/langchain` |
| `@opentelemetry/api` | Apache-2.0 | `@execlave/sdk/otel` |
| `@opentelemetry/sdk-trace-base` | Apache-2.0 | `@execlave/sdk/otel` |

## Development dependencies

Not shipped with the published package. See `package.json` under `devDependencies`.

## Licence of this package

`@execlave/sdk` itself is released under the **MIT licence** — see `LICENSE`.

## Attribution updates

If you believe a dependency is missing from this notice or incorrectly attributed, please open an issue or email `legal@execlave.com`.
