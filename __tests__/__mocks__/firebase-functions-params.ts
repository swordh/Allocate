/**
 * Stub for 'firebase-functions/params' in the root Vitest run — see
 * __tests__/__mocks__/firebase-functions-v2-scheduler.ts's docblock for why
 * this has to be an alias rather than a per-test `vi.mock`.
 *
 * `defineSecret` only needs to hand back something with a `.value()` method
 * (what production code calls to read the secret at runtime, inside an
 * `onSchedule`/`onDocumentCreated` closure) — nothing under test resolves it
 * against a real Secret Manager binding.
 */
export function defineSecret(name: string): { name: string; value: () => string } {
  return { name, value: () => `stub-secret:${name}` }
}
