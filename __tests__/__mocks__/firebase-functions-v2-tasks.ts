/**
 * Stub for 'firebase-functions/v2/tasks' in the root Vitest run — see
 * firebase-functions-v2-scheduler.ts for why this is a config-level alias.
 * `onTaskDispatched` is only called at module load to define the export;
 * tests exercise `runAutoStatusTask` directly.
 */
export function onTaskDispatched(...[]: unknown[]): unknown {
  return { __stub: 'onTaskDispatched' }
}
