# Security Policy — `@execlave/sdk`

If you discover a security issue in the JavaScript/TypeScript SDK (`@execlave/sdk` on npm), please report it privately. **Do not open a public GitHub issue for security vulnerabilities.**

## How to report

Email **security@execlave.com** with:

1. A description of the vulnerability
2. Steps to reproduce
3. Potential impact (confidentiality / integrity / availability)
4. Suggested fix if known
5. The affected `@execlave/sdk` version(s)

PGP key available on request.

## Response SLA

| Phase | Target |
|-------|--------|
| Acknowledgment | within 48 hours |
| Initial assessment | within 5 business days |
| Fix for confirmed vulnerabilities | within 14 days (coordinated disclosure) |

## Supported Versions

We provide security patches for the two most recent minor versions.

| Version | Supported |
|---------|-----------|
| 1.1.x   | ✅ |
| 1.0.x   | ✅ |
| < 1.0   | ❌ |

## Scope

**In scope:**

- `@execlave/sdk` published on npm
- Source code under `sdk-js/` in the public repository
- Subpath integrations: `@execlave/sdk/instrumentation`, `@execlave/sdk/integrations/langchain`

**Out of scope for this SDK** (report via [execlave.com/security](https://www.execlave.com/security)):

- Backend API (`api.execlave.com`)
- Dashboard (`app.execlave.com`)
- Infrastructure or hosting

## Safe Harbor

We will not pursue legal action against researchers who:

- Report in good faith
- Avoid privacy violations, destruction of data, and service interruption
- Do not publicly disclose before a coordinated fix is released

## Recognition

Valid reports that lead to a fix are acknowledged in release notes (with your permission) and, for significant findings, may be eligible for a reward through our bug-bounty programme.
