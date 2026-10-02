/**
 * Structural contract: no framework adapter may define its own copy of the
 * truncate-for-classifier / seal-for-metadata split. There must be exactly
 * one place this logic lives (`_actionBinding.ts`) so it cannot drift
 * file-to-file the way it did before that module existed (see its doc
 * comment for the incident this fixes).
 *
 * This is a source-scanning test, not a type-system guarantee — see the
 * "Honest gap" note below and in `_actionBinding.ts`.
 */
import fs from 'fs';
import path from 'path';

const INTEGRATIONS_DIR = path.join(__dirname, '..', 'integrations');
const EXCLUDED_FILES = new Set(['_actionBinding.ts', 'index.ts']);

// Adapters known (at the time this test was written) to enforce a policy on
// a value that needs the truncate/seal split. If a NEW adapter is added that
// also needs it, add it here — the test below will otherwise not catch a
// fresh adapter that reintroduces a local copy instead of importing the
// shared one.
const ADAPTERS_REQUIRING_ACTION_BINDING = [
  'mcp.ts',
  'openai-chat.ts',
  'crewai.ts',
  'langchain.ts',
  'openai-agents.ts',
];

function integrationFiles(): string[] {
  return fs
    .readdirSync(INTEGRATIONS_DIR)
    .filter((f) => f.endsWith('.ts') && !EXCLUDED_FILES.has(f));
}

describe('action-binding contract', () => {
  it('no adapter file locally redefines safeStr / safeMetadataValue', () => {
    const offenders: string[] = [];
    for (const file of integrationFiles()) {
      const content = fs.readFileSync(path.join(INTEGRATIONS_DIR, file), 'utf8');
      if (/function\s+safeStr\s*\(/.test(content) || /function\s+safeMetadataValue\s*\(/.test(content)) {
        offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('every adapter known to need it imports from the shared _actionBinding module', () => {
    const missing: string[] = [];
    for (const file of ADAPTERS_REQUIRING_ACTION_BINDING) {
      const content = fs.readFileSync(path.join(INTEGRATIONS_DIR, file), 'utf8');
      if (!content.includes("from './_actionBinding'")) {
        missing.push(file);
      }
    }
    expect(missing).toEqual([]);
  });

  it('every adapter known to need it calls enforcePolicyBound, never exe.enforcePolicy directly', () => {
    const offenders: string[] = [];
    for (const file of ADAPTERS_REQUIRING_ACTION_BINDING) {
      const content = fs.readFileSync(path.join(INTEGRATIONS_DIR, file), 'utf8');
      const callsBound = /\benforcePolicyBound\s*\(/.test(content);
      // Matches `exe.enforcePolicy(` / `this._exe.enforcePolicy(` etc. A dot
      // immediately before `enforcePolicy(` never appears in
      // `enforcePolicyBound(`, so this can't false-positive on that call.
      const callsDirect = /\.enforcePolicy\s*\(/.test(content);
      if (!callsBound || callsDirect) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });

  it('no adapter passes a hand-built multi-field object literal to sealMetadata/sealMetadataEntry', () => {
    // Two or more `key:` pairs typed directly inside the seal call's braces
    // is the inclusion-list anti-pattern this repo's incidents keep tracing
    // back to (see _actionBinding.ts's module doc): a hand-picked literal
    // silently stops covering a field the day a provider adds one and the
    // adapter isn't updated. A single identifier already holding the
    // complete value, or a call to sealFullRequest(...), is required
    // instead — this is exactly the bug that shipped in openai-chat.ts's
    // old `sealMetadata({ model, messages })`.
    const multiFieldLiteral =
      /seal(?:Metadata|MetadataEntry)\s*\((?:\s*['"][^'"]+['"]\s*,)?\s*\{[^{}]*:[^{}]*,[^{}]*:/;
    const offenders: string[] = [];
    for (const file of integrationFiles()) {
      const content = fs.readFileSync(path.join(INTEGRATIONS_DIR, file), 'utf8');
      if (multiFieldLiteral.test(content)) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });

  it('lists every adapter file that exists today (fails loudly if one is added without being triaged here)', () => {
    const found = integrationFiles().sort();
    const known = [...ADAPTERS_REQUIRING_ACTION_BINDING].sort();
    // If this fails, a new adapter file was added. Decide whether it needs
    // the truncate/seal split; if yes, add it to
    // ADAPTERS_REQUIRING_ACTION_BINDING above so the import check covers it.
    expect(found).toEqual(known);
  });
});
