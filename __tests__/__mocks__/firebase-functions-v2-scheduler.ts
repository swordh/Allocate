/**
 * Stub for 'firebase-functions/v2/scheduler' in the root Vitest run.
 *
 * Same boundary as __tests__/__mocks__/firebase-functions-v2.ts: the real
 * package lives only in functions/node_modules, which a root-only `npm ci`
 * never installs. Aliasing (rather than a per-test `vi.mock`) is required
 * here specifically because Vite's import-analysis pass resolves a static
 * import's specifier at transform time, before any mock registry is
 * consulted — a `vi.mock('firebase-functions/v2/scheduler', ...)` in a test
 * file still fails with "Cannot find package" the moment a functions/src
 * module it imports statically requires 'firebase-functions/v2/scheduler',
 * because Vite never gets past resolving that bare specifier to ask whether
 * it's mocked. Aliasing it to this file sidesteps that resolution entirely.
 *
 * `onSchedule` just needs to be callable and return something a module can
 * export as a Cloud Function definition — nothing under test ever invokes
 * the returned value as a scheduler trigger, so a plain pass-through stub is
 * enough. Tests exercise the underlying `run*` function directly instead.
 */
export function onSchedule(...[]: unknown[]): unknown {
  return { __stub: 'onSchedule' }
}
