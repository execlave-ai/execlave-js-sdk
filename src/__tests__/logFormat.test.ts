import { formatLogMessage } from '../client';

/**
 * `_log` passed its message through to console as DATA to prevent
 * format-string injection (CWE-134). Correct security-wise, but callers write
 * `%s` placeholders, so debug output read:
 *
 *   [Execlave] Policy cache hit for %s agent-1
 *
 * Substitution now happens here, and the result is still handed to console as
 * data — so placeholders resolve without external text ever being interpreted
 * as a format specifier (F-SDK-14).
 */
describe('debug log formatting', () => {
  it('substitutes placeholders in order', () => {
    expect(formatLogMessage('env=%s async=%s', ['production', true])).toBe(
      'env=production async=true'
    );
  });

  it('returns the message unchanged when there are no arguments', () => {
    expect(formatLogMessage('nothing to fill', [])).toBe('nothing to fill');
  });

  it('appends extra arguments rather than dropping them', () => {
    expect(formatLogMessage('one %s', ['a', 'b'])).toBe('one a b');
  });

  it('leaves surplus placeholders literal when arguments run out', () => {
    expect(formatLogMessage('%s and %s', ['only'])).toBe('only and %s');
  });

  it('does not let a substituted value consume the next argument', () => {
    // The whole point of the single non-recursive pass: an argument carrying
    // its own %s must not act as a format specifier.
    expect(formatLogMessage('a=%s b=%s', ['%s', 'real'])).toBe('a=%s b=real');
  });

  it('renders an Error by message rather than as "[object Object]"', () => {
    expect(formatLogMessage('failed: %s', [new Error('connection refused')])).toBe(
      'failed: connection refused'
    );
  });

  it('renders objects as JSON', () => {
    expect(formatLogMessage('payload=%s', [{ a: 1 }])).toBe('payload={"a":1}');
  });

  it('survives a value that cannot be serialised', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => formatLogMessage('x=%s', [circular])).not.toThrow();
  });
});
