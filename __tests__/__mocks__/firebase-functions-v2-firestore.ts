/**
 * Stub for 'firebase-functions/v2/firestore' in the root Vitest run.
 *
 * Same boundary and same reason as firebase-functions-v2-scheduler.ts (the
 * real package only exists under functions/node_modules; a vi.mock can't help
 * because Vite resolves the static import first). The triggers just need to
 * be callable and return something a module can export; tests exercise the
 * underlying `run*` functions directly.
 */
export function onDocumentWritten(...[]: unknown[]): unknown {
  return { __stub: 'onDocumentWritten' }
}
export function onDocumentUpdated(...[]: unknown[]): unknown {
  return { __stub: 'onDocumentUpdated' }
}
export function onDocumentCreated(...[]: unknown[]): unknown {
  return { __stub: 'onDocumentCreated' }
}
