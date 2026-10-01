/**
 * Stub for 'firebase-functions/v2' in the root Vitest run.
 *
 * `firebase-functions` lives only in functions/node_modules, which a
 * root-only `npm ci` never installs — so any root test that reaches a
 * functions/src module importing it would fail on module resolution rather
 * than on an assertion. Aliased in vitest.config.ts, the same way
 * 'server-only' and next/* are. The emulator config deliberately does NOT
 * alias this: there the real logger should run.
 *
 * `logger` is a plain mutable object so tests can vi.spyOn(logger, 'error').
 */
export const logger = {
  debug: (..._args: unknown[]): void => {},
  log: (..._args: unknown[]): void => {},
  info: (..._args: unknown[]): void => {},
  warn: (..._args: unknown[]): void => {},
  error: (..._args: unknown[]): void => {},
}
